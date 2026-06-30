/* ============================================================
   德州扑克 - 联机服务器 (server.js)
   HTTP 静态托管 + WebSocket 房间 + 权威牌桌
   ============================================================ */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { WebSocketServer } = require("ws");
const { Table, AI_NAMES, AI_AVATARS } = require("./engine.js");

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, "www");

/* ---------- 静态文件服务 ---------- */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  // 防目录遍历
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
});

/* ---------- 房间管理 ---------- */
const rooms = new Map(); // code -> room

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = "";
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function createRoom(opts) {
  const code = genCode();
  const table = new Table(opts);
  const room = { code, table, clients: new Map(), hostId: null };
  table.onUpdate = () => broadcastState(room);
  table.onLog = (text, cls) => broadcastLog(room, text, cls);
  rooms.set(code, room);
  return room;
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcastState(room) {
  for (const [pid, ws] of room.clients) {
    const state = room.table.stateFor(pid);
    state.code = room.code;
    state.hostId = room.hostId;
    state.isHost = pid === room.hostId;
    state.canStart = room.table.readyCount() >= 2;
    state.aiCount = room.table.players.filter((p) => p.isAI).length;
    send(ws, { type: "state", state });
  }
}
function broadcastLog(room, text, cls) {
  for (const [, ws] of room.clients) send(ws, { type: "log", text, cls: cls || "" });
}

function usedAINames(table) {
  return new Set(table.players.filter((p) => p.isAI).map((p) => p.name));
}
function addAI(room) {
  const used = usedAINames(room.table);
  let name = AI_NAMES.find((n) => !used.has(n));
  if (!name) name = "AI" + (room.table.players.length + 1);
  const avatar = AI_AVATARS[AI_NAMES.indexOf(name)] || "🤖";
  const p = room.table.addPlayer({ name, isAI: true, avatar });
  if (p) {
    p.aiAggro = 0.8 + Math.random() * 0.6;
    p.aiNoise = 0.12 + Math.random() * 0.12;
  }
  return p;
}

function reassignHostIfNeeded(room) {
  if (room.hostId && room.table.getPlayer(room.hostId)) {
    const hp = room.table.getPlayer(room.hostId);
    if (hp.connected && !hp.isAI) return;
  }
  // 选一个仍在线的真人当房主
  const next = room.table.players.find((p) => !p.isAI && p.connected && room.clients.has(p.id));
  room.hostId = next ? next.id : null;
}

function cleanupRoom(room) {
  // 没有任何在线真人则销毁
  const humanConnected = [...room.clients.keys()].some((pid) => {
    const p = room.table.getPlayer(pid);
    return p && !p.isAI;
  });
  if (!humanConnected) {
    room.table._clearTimer();
    rooms.delete(room.code);
  }
}

/* ---------- WebSocket ---------- */
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => (ws.isAlive = true));
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    handleMessage(ws, msg);
  });
  ws.on("close", () => handleClose(ws));
  ws.on("error", () => {});
});

function handleMessage(ws, msg) {
  switch (msg.type) {
    case "create": {
      const sb = clampInt(msg.smallBlind, 5, 500, 10);
      const stack = clampInt(msg.startStack, 100, 100000, 2000);
      const room = createRoom({ smallBlind: sb, startStack: stack });
      const name = sanitizeName(msg.name);
      const p = room.table.addPlayer({ name, avatar: "😎" });
      room.hostId = p.id;
      room.clients.set(p.id, ws);
      ws._room = room.code;
      ws._pid = p.id;
      send(ws, { type: "joined", code: room.code, youId: p.id });
      broadcastState(room);
      break;
    }
    case "join": {
      const room = rooms.get((msg.code || "").toUpperCase());
      if (!room) return send(ws, { type: "error", msg: "房间不存在" });
      const name = sanitizeName(msg.name);
      const p = room.table.addPlayer({ name, avatar: "😎" });
      if (!p) return send(ws, { type: "error", msg: "房间已满（最多 8 人）" });
      room.clients.set(p.id, ws);
      ws._room = room.code;
      ws._pid = p.id;
      if (!room.hostId) room.hostId = p.id;
      send(ws, { type: "joined", code: room.code, youId: p.id });
      broadcastLog(room, `${name} 加入了房间`, "sys");
      broadcastState(room);
      break;
    }
    case "start": {
      const room = rooms.get(ws._room);
      if (!room || ws._pid !== room.hostId) return;
      if (room.table.handActive) return;
      if (room.table.readyCount() < 2)
        return send(ws, { type: "error", msg: "至少需要 2 名玩家（可添加 AI 补位）" });
      room.table.startHand();
      break;
    }
    case "addAI": {
      const room = rooms.get(ws._room);
      if (!room || ws._pid !== room.hostId) return;
      if (room.table.players.length >= 8) return send(ws, { type: "error", msg: "座位已满" });
      const p = addAI(room);
      if (p) broadcastLog(room, `${p.name}（AI）加入了房间`, "sys");
      broadcastState(room);
      break;
    }
    case "removeAI": {
      const room = rooms.get(ws._room);
      if (!room || ws._pid !== room.hostId) return;
      const target = room.table.getPlayer(msg.id);
      if (target && target.isAI) {
        room.table.removePlayer(msg.id);
        broadcastState(room);
      }
      break;
    }
    case "action": {
      const room = rooms.get(ws._room);
      if (!room) return;
      const r = room.table.handleAction(ws._pid, msg.action, msg.amount);
      if (r && !r.ok) send(ws, { type: "error", msg: r.msg });
      break;
    }
    case "chat": {
      const room = rooms.get(ws._room);
      if (!room) return;
      const p = room.table.getPlayer(ws._pid);
      if (!p) return;
      const text = String(msg.text || "").slice(0, 120);
      if (text) broadcastLog(room, `💬 ${p.name}：${text}`, "chat");
      break;
    }
    case "leave": {
      handleClose(ws);
      break;
    }
  }
}

function handleClose(ws) {
  const room = rooms.get(ws._room);
  if (!room) return;
  const pid = ws._pid;
  room.clients.delete(pid);
  const p = room.table.getPlayer(pid);
  if (p) {
    if (room.table.handActive) {
      // 牌局中：标记掉线（引擎会在轮到时自动处理），保留座位
      room.table.setConnected(pid, false);
      broadcastLog(room, `${p.name} 掉线了`, "sys");
    } else {
      // 非牌局中：直接移除座位
      room.table.removePlayer(pid);
      broadcastLog(room, `${p.name} 离开了房间`, "sys");
    }
  }
  reassignHostIfNeeded(room);
  if (room.clients.size === 0 || ![...room.clients.keys()].some((id) => !room.table.getPlayer(id)?.isAI)) {
    cleanupRoom(room);
  } else {
    broadcastState(room);
  }
}

/* ---------- 辅助 ---------- */
function sanitizeName(n) {
  n = String(n || "").trim().slice(0, 10);
  return n || "玩家";
}
function clampInt(v, lo, hi, def) {
  v = parseInt(v, 10);
  if (isNaN(v)) return def;
  return Math.max(lo, Math.min(hi, v));
}

// 心跳：清理死连接
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  });
}, 30000);
wss.on("close", () => clearInterval(heartbeat));

/* ---------- 启动 ---------- */
function getLanIPs() {
  const ips = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name]) {
      if (ni.family === "IPv4" && !ni.internal) ips.push(ni.address);
    }
  }
  return ips;
}

server.listen(PORT, "0.0.0.0", () => {
  const ips = getLanIPs();
  console.log("\n  ♠ ♥ ♦ ♣  德州扑克联机服务器已启动\n");
  console.log("  本机访问：   http://localhost:" + PORT);
  for (const ip of ips) console.log("  局域网好友： http://" + ip + ":" + PORT);
  console.log("\n  把上面的「局域网」地址发给同一 WiFi 下的朋友即可一起玩。");
  console.log("  按 Ctrl+C 停止服务器。\n");
});
