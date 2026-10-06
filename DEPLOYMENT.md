# NOVA production deployment

The production frontend is a Vite application deployed to Vercel from the repository root, and the Express API in `server/` is deployed to Render. The frontend's SPA rewrite is configured in `vercel.json`; `server/Dockerfile` provides the API container. Do not create another service if the existing Vercel and Render services are already connected to this repository.

## Required configuration

Copy `server/.env.example` to `server/.env` and set:

- `NODE_ENV=production`
- `HOST=0.0.0.0` and `PORT=4000` (or the values supplied by the runtime)
- `DATABASE_URL` to the production PostgreSQL connection string
- `JWT_SECRET` to a unique random value of at least 32 characters, stored only in the deployment secret manager
- `JWT_EXPIRES_IN`, `COOKIE_NAME`, and `COOKIE_SAME_SITE`; use `COOKIE_SAME_SITE=none` only when the web and API are cross-site and HTTPS is enforced
- `CORS_ORIGIN` to one or more exact HTTPS web origins separated by commas; wildcards are rejected in production
- `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_REQUESTS`, and `AUTH_RATE_LIMIT_MAX`

The frontend API URL is `https://nova-social-platform-api.onrender.com` by default. Set `VITE_API_BASE_URL` to that exact origin in Vercel's project environment settings for production builds; the variable is optional for the current frontend source, which falls back to the same production API URL and does not fall back to localhost. The root `.env.example` contains only the safe, blank variable name.

## Vercel

Use the existing Vercel project and configure it to deploy the repository's `main` branch with the repository root as the project root. Vite's defaults use `npm ci`, `npm run build`, and `dist`; `vercel.json` rewrites browser routes to `index.html` so refreshes on client-side routes work. Set `VITE_API_BASE_URL=https://nova-social-platform-api.onrender.com` in the Vercel environment settings for every deployment target that should use the production API. This is a public API URL, not a secret.

## Render

Use the existing Render API service; do not create a second service. The API is a Docker service with `server/` as its root directory and `Dockerfile` as its Dockerfile path. The image build runs `npm run build` (which generates Prisma, applies committed migrations, and compiles TypeScript); container startup applies migrations again and runs `npm start`. The server listens on `0.0.0.0` and uses Render's `PORT` when provided.

Configure the Render service environment with the required variable names listed below and in `server/.env.example`. Set `CORS_ORIGIN` to the exact HTTPS Vercel production origin(s), comma-separated if there is more than one. The API also explicitly permits the known Vercel production hostnames in `server/src/app.ts`. Store database URLs and signing keys only in Render's environment settings, never in this repository.

## PostgreSQL and Prisma

Create an empty PostgreSQL database and grant the application user only the permissions required by the application. From `server/`, run:

```sh
npm ci
npm run db:generate
npm run db:migrate:deploy
npm run db:migrate:status
```

`db:migrate:deploy` applies committed migrations without resetting data. The production container runs this command before starting the API. Do not use `db:push` or `migrate dev` against production.

## Build and start

Backend:

```sh
npm --prefix server ci
npm --prefix server run db:generate
npm --prefix server run db:migrate:deploy
npm --prefix server run build
npm --prefix server start
```

Frontend:

```sh
VITE_API_BASE_URL=https://api.example.com npm ci
VITE_API_BASE_URL=https://api.example.com npm run build
```

The included `docker-compose.production.yml` builds the API and Nginx web service. Set `VITE_API_BASE_URL` in the environment used by Compose and keep `server/.env` outside version control. The API health check is `GET /api/health`; the web container health check is `GET /health`.

## Domains and realtime

Point the web domain at the Nginx service and the API domain at the Express service. Set `CORS_ORIGIN` to the web origin exactly, including scheme and port where applicable. Keep HTTPS termination in front of both services. Messaging realtime currently uses authenticated Server-Sent Events at `/api/realtime`; the proxy must allow long-lived connections, forward cookies, disable response buffering for that route, and permit keep-alive connections.

## Payments

Payment records are provider-agnostic and remain `PENDING` until a real provider integration confirms payment. No provider credentials are included. Before enabling public checkout, configure the chosen provider's account, API key, webhook signing secret, and event endpoint in the deployment secret manager; implement signature verification, raw-body handling, replay protection, and writes to `PaymentWebhookEvent` using `(provider, providerEventId)` as the idempotency key. Never mark a payment paid from a browser request alone.

## Security checklist

- Use a unique production `JWT_SECRET`; never use example or development values.
- Use HTTPS, secure cookies, exact CORS origins, and a restricted database role.
- Run migrations before accepting traffic and confirm `/api/health` reports `database: ok`.
- Keep application logs free of passwords, tokens, payment secrets, and unnecessary personal data.
- Configure a reverse proxy timeout and buffering policy suitable for SSE.
- Rotate secrets through the deployment secret manager, not repository files.

## Verification

After deployment, verify `GET /api/health` returns HTTP 200 with `status: ok` and `database: ok`, load the web domain, register/login with community rules accepted, create a post, send a message, open the realtime stream, and confirm an admin-only endpoint rejects a normal user. Inspect logs for startup and database errors without exposing secret values.
