'use strict';

/**
 * 多人五子棋 —— 本地 Node 后端（原生 WebSocket）
 * ---------------------------------------------------------------------------
 * 与 Cloudflare Worker（src/worker.js）使用同一套 JSON 协议，方便本地调试与自建。
 * 生产环境可部署到 Cloudflare Workers（免绑卡、永久在线），本文件保留用于：
 *   1. 本地开发测试（node server.js 后打开 http://localhost:3000）
 *   2. 不想用云平台时，在自己电脑上跑后端 + 内网穿透
 *
 * 协议见 src/worker.js 顶部注释。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = process.env.PORT || 3000;
const GRACE_MS = Number(process.env.GRACE_MS) || 90 * 1000;
const MAX_GUESTS = 3;
const ROOM_ID_RE = /^[a-z0-9]{3,12}$/;

/** roomId -> { hostClientId, hostWs, hostOnline, hostGraceTimer, guests: Map<clientId,{ws,timer}> } */
const rooms = new Map();

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* 忽略 */ }
  }
}

function broadcastToGuests(room, obj) {
  for (const [, g] of room.guests) {
    if (g.ws) send(g.ws, obj);
  }
}

function closeRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  rooms.delete(roomId);
  if (room.hostGraceTimer) clearTimeout(room.hostGraceTimer);
  broadcastToGuests(room, { t: 'hostLeft' });
  for (const [, g] of room.guests) {
    if (g.timer) clearTimeout(g.timer);
    if (g.ws) { try { g.ws.close(4000, 'host left'); } catch (e) {} }
  }
  room.guests.clear();
  console.log(`[销毁] 房间 ${roomId}`);
}

function handleMessage(room, conn, raw) {
  let msg;
  try { msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); } catch (e) { return; }
  if (!msg || typeof msg !== 'object') return;

  switch (msg.t) {
    case 'host': {
      const clientId = typeof msg.clientId === 'string' ? msg.clientId : '';
      if (room.hostClientId && room.hostClientId !== clientId && room.hostOnline) {
        send(conn.ws, { t: 'roomTaken' });
        try { conn.ws.close(4001, 'room taken'); } catch (e) {}
        return;
      }
      if (room.hostGraceTimer) { clearTimeout(room.hostGraceTimer); room.hostGraceTimer = null; }
      room.hostClientId = clientId;
      room.hostWs = conn.ws;
      room.hostOnline = true;
      conn.role = 'host';
      conn.clientId = clientId;
      send(conn.ws, { t: 'roomReady' });
      broadcastToGuests(room, { t: 'hostOnline' });
      console.log(`[建房] ${conn.roomId} by ${clientId || conn.wsId}`);
      break;
    }
    case 'guest': {
      const clientId = typeof msg.clientId === 'string' ? msg.clientId : '';
      if (!room.hostClientId || !room.hostOnline) {
        send(conn.ws, { t: 'roomNotFound' });
        try { conn.ws.close(4004, 'no host'); } catch (e) {}
        return;
      }
      const existing = room.guests.get(clientId);
      if (existing) {
        if (existing.timer) { clearTimeout(existing.timer); existing.timer = null; }
        if (existing.ws) { try { existing.ws.close(4000, 'replaced'); } catch (e) {} }
        existing.ws = conn.ws;
        conn.role = 'guest';
        conn.clientId = clientId;
        send(room.hostWs, { t: 'guestJoined', guestId: clientId });
        console.log(`[重连] 房客 ${clientId} -> ${conn.roomId}`);
        return;
      }
      if (room.guests.size >= MAX_GUESTS) {
        send(conn.ws, { t: 'roomFull' });
        try { conn.ws.close(4003, 'full'); } catch (e) {}
        return;
      }
      room.guests.set(clientId, { ws: conn.ws, timer: null });
      conn.role = 'guest';
      conn.clientId = clientId;
      send(room.hostWs, { t: 'guestJoined', guestId: clientId });
      console.log(`[进房] ${clientId} -> ${conn.roomId}（在线房客 ${room.guests.size}）`);
      break;
    }
    case 'toHost': {
      if (conn.role !== 'guest' || !room.hostWs) return;
      send(room.hostWs, { t: 'toHost', from: conn.clientId, data: msg.data });
      break;
    }
    case 'toGuests': {
      if (conn.role !== 'host') return;
      broadcastToGuests(room, { t: 'guestMessage', data: msg.data });
      break;
    }
    case 'toGuest': {
      if (conn.role !== 'host') return;
      const g = room.guests.get(msg.to);
      if (g && g.ws) send(g.ws, { t: 'guestMessage', data: msg.data });
      break;
    }
    case 'kick': {
      if (conn.role !== 'host') return;
      const g = room.guests.get(msg.to);
      if (g) {
        if (g.ws) {
          send(g.ws, { t: 'guestMessage', data: msg.data || { type: 'kicked' } });
          try { g.ws.close(4000, 'kicked'); } catch (e) {}
        }
        if (g.timer) clearTimeout(g.timer);
        room.guests.delete(msg.to);
      }
      break;
    }
    case 'leave': {
      if (conn.role === 'host') {
        closeRoom(conn.roomId);
      } else if (conn.role === 'guest') {
        const g = room.guests.get(conn.clientId);
        if (g) {
          if (g.timer) clearTimeout(g.timer);
          room.guests.delete(conn.clientId);
          send(room.hostWs, { t: 'guestLeft', guestId: conn.clientId });
        }
      }
      break;
    }
    case 'ping': {
      send(conn.ws, { t: 'pong' });
      break;
    }
  }
}

function handleClose(room, conn) {
  if (conn.closed) return;   // close / error 可能都触发，去重
  conn.closed = true;
  if (conn.role === 'host') {
    room.hostOnline = false;
    room.hostWs = null;
    broadcastToGuests(room, { t: 'hostOffline' });
    if (room.hostGraceTimer) clearTimeout(room.hostGraceTimer);
    room.hostGraceTimer = setTimeout(() => closeRoom(conn.roomId), GRACE_MS);
    console.log(`[房主掉线] ${conn.roomId}`);
  } else if (conn.role === 'guest') {
    const g = room.guests.get(conn.clientId);
    if (!g || g.ws !== conn.ws) return; // 已被替换
    g.ws = null;
    send(room.hostWs, { t: 'guestLeft', guestId: conn.clientId });
    g.timer = setTimeout(() => { room.guests.delete(conn.clientId); }, GRACE_MS);
    console.log(`[房客掉线] ${conn.clientId} <- ${conn.roomId}`);
  }
}

/* ------------------------------------------------------------------ */
/* HTTP：静态前端 + 健康检查                                             */
/* ------------------------------------------------------------------ */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) }));
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, data) => {
      if (err) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('index.html 读取失败'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

/* ------------------------------------------------------------------ */
/* WebSocket：/room/<roomId>                                            */
/* ------------------------------------------------------------------ */
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const m = url.pathname.match(/^\/room\/([a-z0-9]{3,12})$/);
  if (!m) {
    socket.destroy();
    return;
  }
  const roomId = m[1];

  wss.handleUpgrade(req, socket, head, (ws) => {
    let room = rooms.get(roomId);
    if (!room) {
      room = { hostClientId: null, hostWs: null, hostOnline: false, hostGraceTimer: null, guests: new Map() };
      rooms.set(roomId, room);
    }
    const conn = { ws, role: null, clientId: null, roomId, wsId: `ws-${Math.random().toString(36).slice(2, 8)}` };
    ws.on('message', (raw) => handleMessage(room, conn, raw));
    ws.on('close', () => handleClose(room, conn));
    ws.on('error', () => handleClose(room, conn));
  });
});

server.listen(PORT, () => {
  console.log(`🚀 五子棋联机服务器（原生 WebSocket）已启动，端口: ${PORT}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`收到 ${sig}，正在关闭…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
