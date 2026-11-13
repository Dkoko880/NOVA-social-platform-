FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY tsconfig.build.json ./
COPY prisma/ ./prisma/
COPY src ./src
RUN npm run build
ARG RENDER_GIT_COMMIT=local
RUN --mount=type=secret,id=database_url,required=true printf '%s' "$RENDER_GIT_COMMIT" >/dev/null && DATABASE_URL="$(cat /run/secrets/database_url)" npm run db:migrate:deploy

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
EXPOSE 4000
CMD ["npm", "start"]
