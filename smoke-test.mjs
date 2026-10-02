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
  const wait = type => {
    const index = queue.findIndex(message => message.type === type);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for " + type)), 6000);
      waiters.push({ type, resolve: value => { clearTimeout(timer); resolve(value); } });
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
const serial = "SLUS-20435";
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
  const guest = await client("host", "friend@example.test", "Friend", randomUUID());
  await guest.ready;
  assert.equal((await guest.wait("hello")).role, "guest");
  assert.equal((await guest.wait("presence")).online, false);

  host.send({ type: "publish", inviteUrl: "https://stream.moonlightweb.top/test-only",
    game: "Armored Core 3", gameSerial: serial });
  await host.wait("published");
  assert.equal((await guest.wait("presence")).online, true);
  host.send({ type: "session_start", sessionId, gameSerial: serial, title: "Armored Core 3" });
  assert.equal((await host.wait("session_started")).sessionId, sessionId);

  const staleHost = host;
  host = await client("guest", hostEmail, "Austin", hostUserId);
  await host.ready;
  assert.equal((await staleHost.wait("host_replaced")).type, "host_replaced");
  assert.equal((await host.wait("host_ready")).role, "host");

  guest.send({ type: "request_join", gameSerial: serial });
  await guest.wait("waiting_approval");
  assert.equal((await host.wait("join_request")).guestName, "Friend");
  host.send({ type: "approve" });
  await host.wait("join_sent");
  assert.equal((await guest.wait("join_approved")).sessionId, sessionId);
  guest.send({ type: "guest_started", sessionId, gameSerial: serial });
  assert.equal((await guest.wait("guest_started_ack")).sessionId, sessionId);
  assert.equal((await host.wait("guest_started")).guestName, "Friend");
  host.send({ type: "stop", hostSeconds: 12 });
  assert.equal((await guest.wait("session_ended")).sessionId, sessionId);
  assert.equal((await host.wait("session_ended_saved")).sessionId, sessionId);
  await guest.wait("host_offline");
  await host.wait("stopped");
  host.ws.close();
  guest.ws.close();
  console.log("PASS: Neon JWT verification, email-derived host role, session tracking, and host-ended guest notification.");
} finally {
  service.kill();
  await new Promise(resolve => authServer.close(resolve));
}
