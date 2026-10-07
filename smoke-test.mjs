import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const origin = "https://weentai.gamer.free";
const hostEmail = "austincochrane@gmail.com";
const port = Number(process.env.WEENTAI_TEST_PORT || 18765);
const authPort = port + 1;
const authUrl = "http://127.0.0.1:" + authPort + "/neondb/auth";
const authIssuer = new URL(authUrl).origin;
const authJwksUrl = authUrl + "/.well-known/jwks.json";
const url = "ws://127.0.0.1:" + port + "/ws";
const { publicKey, privateKey } = await generateKeyPair("ES256");
const publicJwk = { ...(await exportJWK(publicKey)), kid: "weentai-test-key", use: "sig", alg: "ES256" };
const authServer = createServer((req, res) => {
  if (req.url === "/neondb/auth/.well-known/jwks.json") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=60" });
    res.end(JSON.stringify({ keys: [publicJwk] }));
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise(resolve => authServer.listen(authPort, "127.0.0.1", resolve));
const service = spawn(process.execPath, ["server.js"], {
  cwd: fileURLToPath(new URL(".", import.meta.url)),
  stdio: "inherit",
  env: { ...process.env, PORT: String(port), DATABASE_URL: "", NEON_AUTH_URL: authUrl,
    NEON_AUTH_JWKS_URL: authJwksUrl, NEON_AUTH_ISSUER: authUrl,
    HOST_EMAIL: "attacker@example.test", ALLOWED_ORIGINS: origin }
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitForService() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch("http://127.0.0.1:" + port + "/healthz");
      if (response.ok) {
        const health = await response.json();
        assert.equal(health.authConfigured, true);
        assert.equal(health.storageConfigured, false);
        return;
      }
    } catch {}
    await delay(150);
  }
  throw new Error("Presence service did not start.");
}
async function makeToken(email, name, id, verified = true) {
  return new SignJWT({ email, name, emailVerified: verified })
    .setProtectedHeader({ alg: "ES256", kid: publicJwk.kid })
    .setIssuer(authIssuer).setSubject(id).setIssuedAt().setExpirationTime("5m")
    .sign(privateKey);
}
async function client(requestedRole, email, name, id, verified = true) {
  const ws = new WebSocket(url, { headers: { Origin: origin } });
  const queue = [];
  const waiters = [];
  ws.on("message", raw => {
    const message = JSON.parse(raw.toString());
    const index = waiters.findIndex(waiter => waiter.type === message.type);
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
    else queue.push(message);
  });
  const wait = (type, timeoutMs = 6000) => {
    const index = queue.findIndex(message => message.type === type);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      let timer;
      const waiter = { type, resolve: value => { clearTimeout(timer); resolve(value); } };
      timer = setTimeout(() => {
        const waiterIndex = waiters.indexOf(waiter);
        if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
        reject(new Error("Timed out waiting for " + type));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };
  const ready = new Promise((resolve, reject) => {
    ws.once("open", resolve); ws.once("error", reject);
  }).then(async () => ws.send(JSON.stringify({
    type: "hello", role: requestedRole, authToken: await makeToken(email, name, id, verified)
  })));
  return { ws, ready, wait, send: data => ws.send(JSON.stringify(data)) };
}
await waitForService();
const serial = "SLUS-20675";
const sessionId = randomUUID();
try {
  const unverified = await client("guest", "guest@example.test", "Guest", randomUUID(), false);
  await unverified.ready;
  assert.equal((await unverified.wait("error")).code, "unauthorized");
  unverified.ws.close();

  const hostUserId = randomUUID();
  let host = await client("guest", hostEmail, "Austin", hostUserId);
  await host.ready;
  assert.equal((await host.wait("host_ready")).role, "host");
  assert.equal((await host.wait("error")).code, "storage_unavailable");
  const guest = await client("host", "friend@example.test", "Friend", randomUUID());
  await guest.ready;
  assert.equal((await guest.wait("hello")).role, "guest");
  assert.equal((await guest.wait("presence")).online, false);
  assert.equal((await guest.wait("error")).code, "storage_unavailable");
  const guest2 = await client("guest", "another-friend@example.test", "Friend 2", randomUUID());
  await guest2.ready;
  assert.equal((await guest2.wait("hello")).role, "guest");
  assert.equal((await guest2.wait("presence")).online, false);
  assert.equal((await guest2.wait("error")).code, "storage_unavailable");
  assert.equal((await guest.wait("presence")).online, false);
  assert.deepEqual((await host.wait("manga_viewers")).viewers, []);
  assert.deepEqual((await guest.wait("manga_viewers")).viewers, []);
  assert.deepEqual((await guest2.wait("manga_viewers")).viewers, []);

  host.send({ type: "manga_join" });
  assert.equal((await host.wait("manga_page_state")).page, 1);
  assert.deepEqual((await host.wait("manga_viewers")).viewers, ["Austin"]);
  assert.deepEqual((await guest.wait("manga_viewers")).viewers, ["Austin"]);
  assert.deepEqual((await guest2.wait("manga_viewers")).viewers, ["Austin"]);
  guest.send({ type: "manga_join" });
  assert.equal((await guest.wait("manga_page_state")).page, 1);
  assert.deepEqual((await host.wait("manga_viewers")).viewers, ["Austin", "Friend"]);
  assert.deepEqual((await guest.wait("manga_viewers")).viewers, ["Austin", "Friend"]);
  assert.deepEqual((await guest2.wait("manga_viewers")).viewers, ["Austin", "Friend"]);
  guest.send({ type: "manga_page", page: 4 });
  assert.equal((await host.wait("manga_page")).page, 4);
  await assert.rejects(guest2.wait("manga_page_state", 150), /Timed out waiting for manga_page_state/);
  host.send({ type: "manga_page", page: 12 });
  await assert.rejects(guest.wait("manga_page", 150), /Timed out waiting for manga_page/);
  guest.send({ type: "manga_leave" });
  await guest.wait("manga_left");
  assert.deepEqual((await host.wait("manga_viewers")).viewers, ["Austin"]);
  assert.deepEqual((await guest.wait("manga_viewers")).viewers, ["Austin"]);
  assert.deepEqual((await guest2.wait("manga_viewers")).viewers, ["Austin"]);
  host.send({ type: "manga_page", page: 5 });
  await assert.rejects(guest.wait("manga_page", 150), /Timed out waiting for manga_page/);
  await assert.rejects(guest2.wait("manga_page", 150), /Timed out waiting for manga_page/);
  guest2.send({ type: "manga_join" });
  assert.equal((await guest2.wait("manga_page_state")).page, 5);
  assert.deepEqual((await host.wait("manga_viewers")).viewers, ["Austin", "Friend 2"]);
  assert.deepEqual((await guest.wait("manga_viewers")).viewers, ["Austin", "Friend 2"]);
  assert.deepEqual((await guest2.wait("manga_viewers")).viewers, ["Austin", "Friend 2"]);
  guest2.send({ type: "manga_leave" });
  await guest2.wait("manga_left");
  assert.deepEqual((await host.wait("manga_viewers")).viewers, ["Austin"]);
  assert.deepEqual((await guest.wait("manga_viewers")).viewers, ["Austin"]);

  host.send({ type: "publish", inviteUrl: "https://stream.moonlightweb.top/test-only",
    game: "Baldur's Gate: Dark Alliance II", gameSerial: serial });
  await host.wait("published");
  assert.equal((await guest.wait("presence")).online, true);
  assert.equal((await guest2.wait("presence")).online, true);
  host.send({ type: "session_start", sessionId, gameSerial: serial, title: "Baldur's Gate: Dark Alliance II" });
  assert.equal((await host.wait("session_started")).sessionId, sessionId);

  const otherHost = await client("host", hostEmail, "Impostor", randomUUID());
  await otherHost.ready;
  assert.equal((await otherHost.wait("error")).code, "host_busy");
  otherHost.ws.close();

  const staleHost = host;
  host = await client("guest", hostEmail, "Austin", hostUserId);
  await host.ready;
  assert.equal((await staleHost.wait("host_replaced")).type, "host_replaced");
  assert.equal((await host.wait("host_ready")).role, "host");

  guest.send({ type: "request_join", gameSerial: serial });
  await guest.wait("waiting_approval");
  assert.equal((await host.wait("join_request")).guestName, "Friend");
  guest2.send({ type: "request_join", gameSerial: serial });
  await guest2.wait("waiting_approval");
  host.send({ type: "approve" });
  await host.wait("join_sent");
  assert.equal((await guest.wait("join_approved")).sessionId, sessionId);
  assert.equal((await host.wait("join_request")).guestName, "Friend 2");
  host.send({ type: "approve" });
  await host.wait("join_sent");
  assert.equal((await guest2.wait("join_approved")).sessionId, sessionId);
  guest.send({ type: "guest_started", sessionId, gameSerial: serial });
  guest2.send({ type: "guest_started", sessionId, gameSerial: serial });
  assert.equal((await guest.wait("guest_started_ack")).sessionId, sessionId);
  assert.equal((await guest2.wait("guest_started_ack")).sessionId, sessionId);
  assert.equal((await host.wait("guest_started")).guestName, "Friend");
  assert.equal((await host.wait("guest_started")).guestName, "Friend 2");
  host.send({ type: "stop", hostSeconds: 12 });
  assert.equal((await guest.wait("session_ended")).sessionId, sessionId);
  assert.equal((await guest2.wait("session_ended")).sessionId, sessionId);
  assert.equal((await host.wait("session_ended_saved")).sessionId, sessionId);
  await guest.wait("host_offline");
  await host.wait("stopped");
  host.ws.close();
  guest.ws.close();
  guest2.ws.close();
  console.log("PASS: Neon auth, shared manga page and viewer sync, Austin-only hosting, multi-guest PS2 approvals, and session tracking.");
} finally {
  service.kill();
  await new Promise(resolve => authServer.close(resolve));
}
