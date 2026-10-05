# Weentai presence service

Render WebSocket service for authenticated Weentai PS2 sessions.

- Neon Managed Better Auth identifies every connection. The server verifies JWTs with NEON_AUTH_JWKS_URL. Only the verified austincochrane@gmail.com account can host; all other verified accounts are guests, regardless of the role requested by the client.
- Postgres stores playtime totals per authenticated user and game, plus ended-session records for guest end notices after reconnect. The service creates its tables on startup. Playtime writes happen only when a session ends; high-water updates prevent stale local values from reducing server totals.
- The host must approve each guest request. Use Moonlight-Web's Gamepad only invite permission.
- The host invitation URL is sent through Render over TLS and kept in memory for at most two minutes, refreshed by the host heartbeat. It remains available for additional approved guests and is cleared when hosting stops or the host disconnects.
- WebSocket origin is restricted to https://weentai.gamer.free. One authenticated host can approve multiple guests.
- PS2 video, audio, and controller traffic stay on Moonlight-Web; this service coordinates lobby access and playtime.

## Required Render environment

Set these values on the Render service before deploying the authenticated build:

- DATABASE_URL: Neon Postgres connection string. Keep it secret.
- NEON_AUTH_URL: Neon Auth base_url for the production branch.
- NEON_AUTH_JWKS_URL: Neon Auth jwks_url for that same branch.
- The service validates JWT issuers against the origin of NEON_AUTH_URL, as required by Neon Auth.
- ALLOWED_ORIGINS: https://weentai.gamer.free.


## Local development

Requires Node.js 20+.

```sh
npm ci
npm test
npm start
```

The service listens on PORT (default 10000). Health check: /healthz. WebSocket path: /ws. Health reports whether auth and storage are configured without returning their values.

## Release checks

Run npm ci and npm test, commit and push main, then verify Render reports that exact commit as live. Check /healthz and recent startup logs. If automatic deployment misses a push, redeploy the current main revision and confirm it again. Deploy backend changes before uploading matching website files to InfinityFree.
