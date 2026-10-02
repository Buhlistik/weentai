# Weentai presence service

Small Render WebSocket service for one Weentai host and one guest. It shares online state and delivers a Moonlight-Web invitation only after the host accepts a guest request.

- Neon Managed Better Auth identifies every connection. The server verifies JWTs with NEON_AUTH_JWKS_URL. Only the verified austincochrane@gmail.com account can host; all other verified accounts are guests, regardless of the role requested by the client.
- Postgres stores playtime totals per authenticated user and game, plus ended-session records for guest end notices after reconnect. The service creates its tables on startup. Playtime writes happen only when a session ends; high-water updates prevent stale local values from reducing server totals.
- The host must approve each guest request. Use Moonlight-Web's Gamepad only invite permission.
- The host invitation URL is sent through Render over TLS and kept in memory for at most two minutes, refreshed by the host heartbeat. It is deleted after approval or disconnect.
- WebSocket origin is restricted to https://weentai.gamer.free. Only one host and one guest can be connected at a time.
- Video and audio stay on Moonlight-Web. The frontend must label transport statistics unverified because the presence service cannot inspect the media route.

## Required Render environment

Set these values on the Render service before deploying the authenticated build:

- DATABASE_URL: Neon Postgres connection string. Keep it secret.
- NEON_AUTH_URL: Neon Auth base_url for the production branch.
- NEON_AUTH_JWKS_URL: Neon Auth jwks_url for that same branch.
- NEON_AUTH_ISSUER: Neon Auth base URL used as the JWT issuer; defaults to NEON_AUTH_URL.
- ALLOWED_ORIGINS: https://weentai.gamer.free.

The static site also needs the same NEON_AUTH_URL in auth-config.js. Add the production website domain to Neon Auth trusted domains and enable the sign-in providers you intend to use.

## Local development

Requires Node.js 20+.

```sh
npm ci
npm test
npm start
```

The service listens on PORT (default 10000). Health check: /healthz. WebSocket path: /ws. Health reports whether auth and storage are configured without returning their values.