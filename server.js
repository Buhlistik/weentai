import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.PORT || 10000);
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || "https://weentai.gamer.free")
  .split(",").map((value) => value.trim()).filter(Boolean));
const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ error: "not_found" }));
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
let host = null;
let guest = null;
let pending = null;
let invite = null;

function send(socket, data) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
}

function sendPresence() {
  send(guest, { type: "presence", online: Boolean(host && invite && invite.expiresAt > Date.now()), hostName: host?.name || "", game: host?.game || "" });
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

function clearHost() {
  host = null;
  invite = null;
  pending = null;
  send(guest, { type: "host_offline" });
}

server.on("upgrade", (req, socket, head) => {
  const origin = req.headers.origin || "";
  if (req.url !== "/ws" || !allowedOrigins.has(origin)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => {
  let role = "";
  let name = "Player";
  let requestCooldownAt = 0;

  ws.on("message", (buffer) => {
    let msg;
    try { msg = JSON.parse(buffer.toString()); } catch { send(ws, { type: "error", code: "bad_message" }); return; }
    if (!msg || typeof msg.type !== "string") return;

    if (msg.type === "hello" && !role) {
      if (msg.role !== "host" && msg.role !== "guest") { send(ws, { type: "error", code: "bad_role" }); ws.close(); return; }
      role = msg.role;
      name = String(msg.name || "Player").trim().slice(0, 32) || "Player";
      if (role === "host") {
        if (host && host.ws !== ws) { send(ws, { type: "error", code: "host_busy" }); ws.close(); return; }
        host = { ws, name, game: "Baldur's Gate: Dark Alliance II" };
        send(ws, { type: "host_ready" });
        sendPresence();
      } else {
        if (guest && guest !== ws) { send(ws, { type: "error", code: "guest_busy" }); ws.close(); return; }
        guest = ws;
        send(ws, { type: "hello", name });
        sendPresence();
      }
      return;
    }

    if (role === "host" && host?.ws === ws) {
      if (msg.type === "publish") {
        if (!validInvite(msg.inviteUrl)) { send(ws, { type: "error", code: "invalid_invite" }); return; }
        invite = { url: msg.inviteUrl, expiresAt: Date.now() + 120_000 };
        send(ws, { type: "published" });
        sendPresence();
      } else if (msg.type === "approve" && pending && pending.guest === guest && invite && invite.expiresAt > Date.now()) {
        send(guest, { type: "join_approved", inviteUrl: invite.url });
        send(ws, { type: "join_sent" });
        invite = null;
        pending = null;
        sendPresence();
      } else if (msg.type === "deny" && pending) {
        send(pending.guest, { type: "join_denied" });
        pending = null;
      } else if (msg.type === "stop") {
        clearHost();
        send(ws, { type: "stopped" });
        return;
      } else if (msg.type === "heartbeat") {
        if (invite) invite.expiresAt = Date.now() + 120_000;
      }
    }

    if (role === "guest" && guest === ws) {
      if (msg.type === "request_join") {
        const now = Date.now();
        if (now - requestCooldownAt < 5000) { send(ws, { type: "error", code: "wait_before_request" }); return; }
        requestCooldownAt = now;
        if (!host || !invite || invite.expiresAt <= now) { send(ws, { type: "error", code: "host_unavailable" }); return; }
        pending = { guest: ws, name };
        send(ws, { type: "waiting_approval" });
        send(host.ws, { type: "join_request", guestName: name });
      }
    }
  });

  ws.on("close", () => {
    if (role === "host" && host?.ws === ws) clearHost();
    if (role === "guest" && guest === ws) {
      guest = null;
      if (pending?.guest === ws) pending = null;
    }
  });
  ws.on("error", () => {});
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Weentai presence service listening on port " + PORT);
});
