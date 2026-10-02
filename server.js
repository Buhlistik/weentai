import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import pg from "pg";
import { createRemoteJWKSet, jwtVerify } from "jose";

const { Pool } = pg;
const PORT = Number(process.env.PORT || 10000);
const rawNeonAuthUrl = String(process.env.NEON_AUTH_URL || "").trim();
const NEON_AUTH_URL = rawNeonAuthUrl.endsWith("/") ? rawNeonAuthUrl.slice(0, -1) : rawNeonAuthUrl;
const NEON_AUTH_ISSUER = NEON_AUTH_URL ? new URL(NEON_AUTH_URL).origin : "";
const NEON_AUTH_JWKS_URL = String(process.env.NEON_AUTH_JWKS_URL || "").trim();
const HOST_EMAIL = "austincochrane@gmail.com";
const authJwks = NEON_AUTH_JWKS_URL
  ? createRemoteJWKSet(new URL(NEON_AUTH_JWKS_URL))
  : NEON_AUTH_URL
    ? createRemoteJWKSet(new URL(".well-known/jwks.json", NEON_AUTH_URL + "/"))
    : null;
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || "https://weentai.gamer.free")
  .split(",").map((value) => value.trim()).filter(Boolean));
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, max: 4, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 })
  : null;
let schemaPromise = null;
let host = null;
let guest = null;
let pending = null;
let invite = null;

const schema = `
CREATE TABLE IF NOT EXISTS game_playtime (
  username_key TEXT NOT NULL,
  username TEXT NOT NULL,
  game_serial TEXT NOT NULL,
  seconds BIGINT NOT NULL DEFAULT 0 CHECK (seconds >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (username_key, game_serial)
);
CREATE TABLE IF NOT EXISTS session_ends (
  session_id TEXT PRIMARY KEY,
  host_username_key TEXT NOT NULL,
  host_username TEXT NOT NULL,
  guest_username_key TEXT,
  guest_username TEXT,
  game_serial TEXT NOT NULL,
  title TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  guest_started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ NOT NULL,
  host_seconds BIGINT NOT NULL,
  guest_seconds BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS session_ends_guest_lookup
  ON session_ends (guest_username_key, session_id);
`;

async function ensureSchema() {
  if (!pool) return false;
  if (!schemaPromise) {
    schemaPromise = pool.query(schema).then(() => true).catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

function send(socket, data) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
}
function nameKey(user) {
  return String(user?.id || "");
}
function displayName(user) {
  return String(user?.name || user?.email || "Player").trim().slice(0, 32) || "Player";
}
async function verifyIdentity(token) {
  if (!authJwks || !NEON_AUTH_ISSUER || typeof token !== "string" || token.length > 8192)
    throw new Error("auth_not_configured");
  const { payload } = await jwtVerify(token, authJwks, {
    issuer: NEON_AUTH_ISSUER,
    algorithms: ["ES256", "EdDSA", "RS256"]
  });
  const id = String(payload.sub || "");
  const email = String(payload.email || "").trim().toLowerCase();
  const name = String(payload.name || "").trim().slice(0, 32) || email.split("@")[0];
  const emailVerified = payload.emailVerified === true || payload.email_verified === true;
  if (!id || !email.includes("@") || !emailVerified) throw new Error("verified_identity_required");
  return { id, email, name, emailVerified };
}
function validSerial(value) {
  return typeof value === "string" && /^[A-Z0-9-]{4,24}$/.test(value);
}
function validSessionId(value) {
  return typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);
}
function safeSeconds(value) {
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 315_360_000 ? seconds : null;
}
function sendPresence() {
  const online = Boolean(host && invite && invite.expiresAt > Date.now());
  send(guest, {
    type: "presence", online,
    hostName: host?.name || "",
    game: online ? host?.game || "" : "",
    gameSerial: online ? host?.gameSerial || "" : ""
  });
}
function validInvite(raw) {
  if (typeof raw !== "string" || raw.length > 1200) return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const domain = url.hostname.toLowerCase();
    if (domain === "stream.moonlightweb.top") return true;
    const ip = domain.split(".").map(Number);
    if (ip.length !== 4 || ip.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    return ip[0] === 10 || (ip[0] === 192 && ip[1] === 168) ||
      (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) || ip[0] === 127;
  } catch { return false; }
}

async function saveHighWater(client, user, serial, seconds) {
  const key = nameKey(user);
  await client.query(
    `INSERT INTO game_playtime (username_key, username, game_serial, seconds)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (username_key, game_serial) DO UPDATE SET
       username = EXCLUDED.username,
       seconds = GREATEST(game_playtime.seconds, EXCLUDED.seconds),
       updated_at = CASE WHEN EXCLUDED.seconds > game_playtime.seconds THEN NOW() ELSE game_playtime.updated_at END`,
    [key, displayName(user), serial, seconds]
  );
  const result = await client.query(
    "SELECT seconds FROM game_playtime WHERE username_key = $1 AND game_serial = $2",
    [key, serial]
  );
  return Number(result.rows[0]?.seconds || 0);
}

async function addSessionSeconds(client, user, serial, seconds) {
  if (!seconds) return 0;
  const key = nameKey(user);
  await client.query(
    `INSERT INTO game_playtime (username_key, username, game_serial, seconds)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (username_key, game_serial) DO UPDATE SET
       username = EXCLUDED.username,
       seconds = game_playtime.seconds + EXCLUDED.seconds,
       updated_at = NOW()`,
    [key, displayName(user), serial, seconds]
  );
  const result = await client.query(
    "SELECT seconds FROM game_playtime WHERE username_key = $1 AND game_serial = $2",
    [key, serial]
  );
  return Number(result.rows[0]?.seconds || 0);
}

async function sendPlaytimeSnapshot(socket, user) {
  if (!pool || !nameKey(user)) {
    send(socket, { type: "error", code: "storage_unavailable" });
    return;
  }
  await ensureSchema();
  const result = await pool.query(
    "SELECT game_serial AS serial, seconds FROM game_playtime WHERE username_key = $1",
    [nameKey(user)]
  );
  send(socket, {
    type: "playtime_snapshot",
    totals: result.rows.map((row) => ({ serial: row.serial, seconds: Number(row.seconds) }))
  });
}

async function sendPendingEnd(socket, user, sessionId) {
  if (!pool || !validSessionId(sessionId) || !nameKey(user)) return;
  await ensureSchema();
  const result = await pool.query(
    `SELECT session_id, game_serial, title, started_at, guest_started_at, ended_at
     FROM session_ends
     WHERE session_id = $1 AND guest_username_key = $2`,
    [sessionId, nameKey(user)]
  );
  const row = result.rows[0];
  if (row) send(socket, {
    type: "session_ended",
    sessionId: row.session_id,
    gameSerial: row.game_serial,
    title: row.title,
    startedAt: row.started_at,
    guestStartedAt: row.guest_started_at,
    endedAt: row.ended_at
  });
}

async function finishSession(hostState, reportedHostSeconds = null) {
  const active = hostState?.activeSession;
  if (!active) return null;
  const endedAtMs = Date.now();
  const hostSeconds = Math.max(0, Math.floor((endedAtMs - Date.parse(active.startedAt)) / 1000));
  const guestSeconds = active.guestStartedAt
    ? Math.max(0, Math.floor((endedAtMs - Date.parse(active.guestStartedAt)) / 1000))
    : 0;
  const session = {
    type: "session_ended", sessionId: active.id, gameSerial: active.gameSerial,
    title: active.title, startedAt: active.startedAt,
    guestStartedAt: active.guestStartedAt || null,
    endedAt: new Date(endedAtMs).toISOString()
  };
  let canonicalHostSeconds = null;
  let canonicalGuestSeconds = null;
  if (pool) {
    await ensureSchema();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO session_ends
         (session_id, host_username_key, host_username, guest_username_key, guest_username,
          game_serial, title, started_at, guest_started_at, ended_at, host_seconds, guest_seconds)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (session_id) DO NOTHING RETURNING session_id`,
        [active.id, nameKey(hostState.user), displayName(hostState.user), active.guestUser ? nameKey(active.guestUser) : null,
          active.guestUser ? displayName(active.guestUser) : null, active.gameSerial, active.title, active.startedAt,
          active.guestStartedAt || null, session.endedAt, hostSeconds, guestSeconds]
      );
      if (inserted.rowCount) {
        canonicalHostSeconds = await addSessionSeconds(client, hostState.user, active.gameSerial, hostSeconds);
        if (active.guestUser && guestSeconds > 0)
          canonicalGuestSeconds = await addSessionSeconds(client, active.guestUser, active.gameSerial, guestSeconds);
      }
      const hostTotal = safeSeconds(reportedHostSeconds);
      if (hostTotal !== null)
        canonicalHostSeconds = await saveHighWater(client, hostState.user, active.gameSerial, hostTotal);
      if (active.guestUser) {
        const guestTotal = await client.query(
          "SELECT seconds FROM game_playtime WHERE username_key = $1 AND game_serial = $2",
          [nameKey(active.guestUser), active.gameSerial]
        );
        canonicalGuestSeconds = Number(guestTotal.rows[0]?.seconds || 0);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  hostState.activeSession = null;
  if (active.guestUser) {
    send(guest, { ...session, hostTotalSeconds: canonicalHostSeconds, guestTotalSeconds: canonicalGuestSeconds });
  }
  send(hostState.ws, {
    ...session, type: "session_ended_saved",
    hostTotalSeconds: canonicalHostSeconds
  });
  return session;
}

function clearHost() {
  host = null;
  invite = null;
  pending = null;
  send(guest, { type: "host_offline" });
  sendPresence();
}

async function handleMessage(ws, context, msg) {
  if (!msg || typeof msg.type !== "string") return;
  if (msg.type === "hello" && !context.role) {
    if (msg.role !== "host" && msg.role !== "guest") {
      send(ws, { type: "error", code: "bad_role" }); ws.close(); return;
    }
    try { context.user = await verifyIdentity(msg.authToken); }
    catch (error) {
      send(ws, { type: "error", code: error.message === "auth_not_configured" ? "auth_not_configured" : "unauthorized" });
      ws.close(); return;
    }
    context.name = displayName(context.user);
    context.role = context.user.email === HOST_EMAIL ? "host" : "guest";
    if (context.role === "host") {
      if (host && host.ws !== ws) {
        if (host.user.id !== context.user.id) { send(ws, { type: "error", code: "host_busy" }); ws.close(); return; }
        send(host.ws, { type: "host_replaced" });
        host.ws.close();
        host = { ...host, ws, name: context.name, user: context.user };
      } else {
        host = { ws, name: context.name, user: context.user, game: "", gameSerial: "", activeSession: null };
      }
      send(ws, { type: "host_ready", storageReady: Boolean(pool), role: "host", user: { id: context.user.id, email: context.user.email, name: context.name } });
    } else {
      if (guest && guest !== ws) { send(ws, { type: "error", code: "guest_busy" }); ws.close(); return; }
      guest = ws;
      send(ws, { type: "hello", role: "guest", user: { id: context.user.id, email: context.user.email, name: context.name } });
    }
    sendPresence();
    if (msg.activeSessionId) await sendPendingEnd(ws, context.user, msg.activeSessionId);
    await sendPlaytimeSnapshot(ws, context.user);
    return;
  }

  if (context.role === "host" && host?.ws === ws) {
    if (msg.type === "publish") {
      if (!validInvite(msg.inviteUrl)) { send(ws, { type: "error", code: "invalid_invite" }); return; }
      if (!validSerial(msg.gameSerial)) { send(ws, { type: "error", code: "invalid_game" }); return; }
      host.game = String(msg.game || "").trim().slice(0, 100) || msg.gameSerial;
      host.gameSerial = msg.gameSerial;
      invite = { url: msg.inviteUrl, gameSerial: msg.gameSerial, expiresAt: Date.now() + 120_000 };
      send(ws, { type: "published", gameSerial: msg.gameSerial });
      sendPresence();
    } else if (msg.type === "session_start") {
      if (!validSessionId(msg.sessionId) || !validSerial(msg.gameSerial) || msg.gameSerial !== host.gameSerial) {
        send(ws, { type: "error", code: "invalid_session" }); return;
      }
      if (host.activeSession) await finishSession(host);
      host.activeSession = {
        id: msg.sessionId, gameSerial: msg.gameSerial,
        title: String(msg.title || host.game || msg.gameSerial).trim().slice(0, 100),
        startedAt: new Date().toISOString(), guestUser: null, guestStartedAt: null
      };
      send(ws, { type: "session_started", sessionId: host.activeSession.id, startedAt: host.activeSession.startedAt });
    } else if (msg.type === "approve" && pending && pending.guest === guest && invite && invite.expiresAt > Date.now()) {
      if (!host.activeSession || host.activeSession.gameSerial !== invite.gameSerial) {
        send(ws, { type: "error", code: "session_unavailable" }); return;
      }
      send(guest, { type: "join_approved", inviteUrl: invite.url, gameSerial: invite.gameSerial, sessionId: host.activeSession.id });
      send(ws, { type: "join_sent" });
      invite = null; pending = null; sendPresence();
    } else if (msg.type === "deny" && pending) {
      send(pending.guest, { type: "join_denied" }); pending = null;
    } else if (msg.type === "stop") {
      const ended = await finishSession(host, safeSeconds(msg.hostSeconds));
      invite = null; pending = null;
      send(guest, { type: "host_offline" });
      send(ws, { type: "stopped", endedSessionId: ended?.sessionId || "" });
      sendPresence();
      return;
    } else if (msg.type === "heartbeat") {
      if (invite) invite.expiresAt = Date.now() + 120_000;
    } else if (msg.type === "sync_playtime") {
      await syncPlaytime(ws, host.user, msg);
    } else if (msg.type === "sync_request") {
      await sendPlaytimeSnapshot(ws, host.user);
      await sendPendingEnd(ws, host.user, msg.activeSessionId);
    }
  }

  if (context.role === "guest" && guest === ws) {
    if (msg.type === "request_join") {
      const now = Date.now();
      if (now - context.requestCooldownAt < 5000) { send(ws, { type: "error", code: "wait_before_request" }); return; }
      context.requestCooldownAt = now;
      if (!host || !invite || invite.expiresAt <= now) { send(ws, { type: "error", code: "host_unavailable" }); return; }
      if (typeof msg.gameSerial !== "string" || msg.gameSerial !== invite.gameSerial) {
        send(ws, { type: "error", code: "game_unavailable" }); return;
      }
      pending = { guest: ws, user: context.user, name: context.name, gameSerial: msg.gameSerial };
      send(ws, { type: "waiting_approval", gameSerial: msg.gameSerial });
      send(host.ws, { type: "join_request", guestName: context.name, gameSerial: msg.gameSerial });
    } else if (msg.type === "guest_started") {
      if (!host?.activeSession || msg.sessionId !== host.activeSession.id || host.activeSession.gameSerial !== msg.gameSerial) {
        send(ws, { type: "error", code: "session_unavailable" }); return;
      }
      const startedAt = new Date().toISOString();
      host.activeSession.guestUser = context.user;
      host.activeSession.guestStartedAt = startedAt;
      send(ws, { type: "guest_started_ack", sessionId: msg.sessionId, startedAt });
      send(host.ws, { type: "guest_started", sessionId: msg.sessionId, guestName: context.name, startedAt });
    } else if (msg.type === "sync_playtime") {
      await syncPlaytime(ws, context.user, msg);
    } else if (msg.type === "sync_request") {
      await sendPlaytimeSnapshot(ws, context.user);
      await sendPendingEnd(ws, context.user, msg.activeSessionId);
    } else if (msg.type === "session_ended_ack") {
      send(ws, { type: "session_ended_acknowledged", sessionId: msg.sessionId });
    }
  }
}

async function syncPlaytime(socket, user, msg) {
  if (!pool) { send(socket, { type: "error", code: "storage_unavailable" }); return; }
  if (!validSerial(msg.gameSerial)) { send(socket, { type: "error", code: "invalid_game" }); return; }
  const seconds = safeSeconds(msg.seconds);
  if (seconds === null) { send(socket, { type: "error", code: "invalid_playtime" }); return; }
  await ensureSchema();
  const client = await pool.connect();
  try {
    const canonicalSeconds = await saveHighWater(client, user, msg.gameSerial, seconds);
    send(socket, { type: "playtime_total", serial: msg.gameSerial, seconds: canonicalSeconds });
  } finally { client.release(); }
}

const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ status: "ok", storageConfigured: Boolean(pool), authConfigured: Boolean(authJwks) }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ error: "not_found" }));
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
server.on("upgrade", (req, socket, head) => {
  const origin = req.headers.origin || "";
  if (req.url !== "/ws" || !allowedOrigins.has(origin)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => {
  const context = { role: "", name: "Player", requestCooldownAt: 0 };
  let queue = Promise.resolve();
  ws.on("message", (buffer) => {
    queue = queue.then(async () => {
      let msg;
      try { msg = JSON.parse(buffer.toString()); }
      catch { send(ws, { type: "error", code: "bad_message" }); return; }
      await handleMessage(ws, context, msg);
    }).catch((error) => {
      console.error("Presence message failed:", error.message);
      send(ws, { type: "error", code: pool ? "storage_error" : "storage_unavailable" });
    });
  });
  ws.on("close", () => {
    queue = queue.then(async () => {
      if (context.role === "host" && host?.ws === ws) {
        await finishSession(host);
        clearHost();
      }
      if (context.role === "guest" && guest === ws) {
        guest = null;
        if (pending?.guest === ws) pending = null;
      }
    }).catch((error) => console.error("Presence close failed:", error.message));
  });
  ws.on("error", () => {});
});

server.listen(PORT, "0.0.0.0", () => {
  if (pool) {
    ensureSchema().then(() => console.log("Playtime database ready"))
      .catch((error) => console.error("Playtime database unavailable:", error.message));
  } else {
    console.error("Playtime database unavailable: DATABASE_URL is not set.");
  }
  console.log("Weentai presence service listening on port " + PORT);
});