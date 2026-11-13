# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend enabling type-aware lint rules by installing `oxlint-tsgolint` and editing `.oxlintrc.json`:

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "options": {
    "typeAware": true
  },
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
```

See the [Oxlint rules documentation](https://oxc.rs/docs/guide/usage/linter/rules) for the full list of rules and categories.

## Messaging and real-time media

Group conversations created from the Messages page are persisted with an explicit group flag. Owners and moderators can add directory members from the group header; direct one-to-one conversations cannot be expanded this way. Message delivery/read receipts are persisted per recipient; read timestamps are only shared when that recipient has read receipts enabled. Unread markers, presence privacy, and last-seen timestamps are persisted per user. “My contacts” means people in a direct one-to-one NOVACHAT conversation; per-contact exceptions are not currently supported.

**NOVACHAT is not end-to-end encrypted.** Messages and attachments are transmitted over the configured HTTPS/API and stored as ordinary message content in PostgreSQL/media storage. The server can read message text and metadata; the application does not implement sender/recipient key agreement, device key storage, ciphertext-only message persistence, or client-side decryption. This is not equivalent to E2EE, and the UI must not claim that it is. A real E2EE rollout requires a separately designed and reviewed protocol, identity/device-key verification and recovery, multi-device/group key distribution, encrypted attachment handling, and a compatible migration strategy for existing plaintext messages. No partial encryption is applied.

GIF and sticker search uses the GIPHY API from the server. Set `GIPHY_API_KEY` in the API deployment environment; the key is never sent to the browser. The picker reports an explicit configuration error if this credential is missing.

Authenticated server-sent events, connection presence, recording indicators, and transient typing state are process-local. Unexpected connection closure and recording heartbeats clear stale local state, but multi-instance deployment still requires shared realtime/pub-sub infrastructure for accurate cross-instance presence and event fan-out.

Apply the schema changes before deploying:

```sh
cd server
npm run db:migrate:deploy
```

Voice/video calls and live broadcasts use LiveKit rooms, with the browser connecting through `livekit-client` and the API issuing 10-minute, session-scoped tokens with `livekit-server-sdk`. Call room access is limited to call participants with an active lifecycle state. Live room publishers are limited to the host and guests/co-hosts who are both host-approved and explicitly admitted to the stage; other viewers receive subscribe-only tokens after joining an active session. Live sessions are not marked live until LiveKit confirms the host's camera and microphone tracks are published, and calls are not marked connected until LiveKit confirms multiple call participants are present.

Configure `LIVEKIT_URL` (`wss://` media-server address), `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` on the API. Set all three together; the API validates the URL and never sends the key or secret to browsers. Keep the media server publicly reachable over TLS with its required UDP/TCP media ports open. Browsers require HTTPS (or localhost) and user permission for camera/microphone access. The provider's ICE/TURN configuration is managed by the LiveKit deployment.

Live broadcast lifecycle, moderator/guest state, and viewer heartbeats are persisted in PostgreSQL; viewer counts include only connections confirmed by LiveKit and expire after 60 seconds without a heartbeat. Linked Feed posts and their comment/reaction endpoints enforce the broadcast's audience and block settings. State is shared across API instances, and start transitions are coordinated against the persisted broadcast row. Authenticated server-sent events and voice/video call session state remain process-local, so cross-instance event fan-out and distributed call state still require shared realtime/session infrastructure. LiveKit provides the media plane but does not replace the app's lifecycle store or realtime transport.

Starting a broadcast creates or updates one linked Feed post, where viewers can subscribe without leaving the feed and use session comments and reactions. Approved guests and co-hosts must explicitly join the stage before publishing. When browser replay recording succeeds, the recording is attached to that same post.
