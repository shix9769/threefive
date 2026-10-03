/**
 * 多人五子棋 —— Cloudflare Workers + Durable Objects 后端（原生 WebSocket）
 * ---------------------------------------------------------------------------
 * 与本地 server.js 使用同一套 JSON 协议，方便本地调试与线上无缝切换。
 *
 * 协议（每条消息都是 JSON 文本）：
 *   客户端 -> 服务端
 *     {t:'host', clientId}          声明房主（第一个连进来的人）
 *     {t:'guest', clientId}         声明房客
 *     {t:'toHost', data}            房客 -> 房主
 *     {t:'toGuests', data}          房主 -> 全场房客
 *     {t:'toGuest', to, data}       房主 -> 指定房客
 *     {t:'kick', to, data}          房主移出房客
 *     {t:'leave'}                   主动离开
 *     {t:'ping'}                    心跳
 *
 *   服务端 -> 客户端
 *     {t:'roomReady'}               房主建房成功
 *     {t:'roomTaken'}               房间已有房主
 *     {t:'roomNotFound'}            房客找不到房主
 *     {t:'roomFull'}                房客已满（3 人）
 *     {t:'guestJoined', guestId}    房主收到新房客
 *     {t:'guestLeft', guestId}      房主收到房客离开
 *     {t:'toHost', from, data}      房主收到房客消息
 *     {t:'guestMessage', data}      房客收到房主消息
 *     {t:'hostOffline'/'hostOnline'/'hostLeft'}  房主掉线/恢复/离开
 *     {t:'pong'}                    心跳回包
 */

const GRACE_MS = 90 * 1000;
const MAX_GUESTS = 3;

// 前端页面（由 wrangler 的 Text 规则打进包），实现前后端同源、一步部署
import indexHtml from '../public/index.html';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 健康检查
    if (url.pathname === '/healthz') {
      return Response.json({ ok: true, rooms: 0 });
    }

    // WebSocket 连接：/room/<roomId>
    const m = url.pathname.match(/^\/room\/([a-z0-9]{3,12})$/);
    if (m && request.headers.get('Upgrade') === 'websocket') {
      const roomId = m[1];
      const id = env.ROOMS.idFromName(roomId);
      const stub = env.ROOMS.get(id);
      return stub.fetch(request);
    }

    // 前端页面
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(indexHtml, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }
      });
    }

    return new Response('threefive-gomoku — 请访问 / 打开游戏，/healthz 健康检查', { status: 404 });
  }
};

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.hostClientId = null;
    this.hostWs = null;
    this.hostOnline = false;
    this.hostGraceTimer = null;
    this.guests = new Map(); // clientId -> { ws, timer }
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const conn = { server, role: null, clientId: null };
    server.addEventListener('message', (ev) => this.onMessage(conn, ev.data));
    server.addEventListener('close', () => this.onClose(conn));
    server.addEventListener('error', () => this.onClose(conn));

    return new Response(null, { status: 101, webSocket: client });
  }

  send(ws, obj) {
    try { if (ws) ws.send(JSON.stringify(obj)); } catch (e) { /* 忽略 */ }
  }

  broadcastToGuests(obj) {
    for (const [, g] of this.guests) {
      if (g.ws) this.send(g.ws, obj);
    }
  }

  closeRoom() {
    if (this.hostGraceTimer) { clearTimeout(this.hostGraceTimer); this.hostGraceTimer = null; }
    this.broadcastToGuests({ t: 'hostLeft' });
    for (const [, g] of this.guests) {
      if (g.timer) clearTimeout(g.timer);
      if (g.ws) { try { g.ws.close(4000, 'host left'); } catch (e) {} }
    }
    this.guests.clear();
    this.hostClientId = null;
    this.hostWs = null;
    this.hostOnline = false;
    try { this.ctx.storage.deleteAll(); } catch (e) {}
  }

  onMessage(conn, raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;

    switch (msg.t) {
      case 'host': {
        const clientId = typeof msg.clientId === 'string' ? msg.clientId : '';
        if (this.hostClientId && this.hostClientId !== clientId && this.hostOnline) {
          this.send(conn.server, { t: 'roomTaken' });
          try { conn.server.close(4001, 'room taken'); } catch (e) {}
          return;
        }
        if (this.hostGraceTimer) { clearTimeout(this.hostGraceTimer); this.hostGraceTimer = null; }
        this.hostClientId = clientId;
        this.hostWs = conn.server;
        this.hostOnline = true;
        conn.role = 'host';
        conn.clientId = clientId;
        this.send(conn.server, { t: 'roomReady' });
        this.broadcastToGuests({ t: 'hostOnline' });
        break;
      }
      case 'guest': {
        const clientId = typeof msg.clientId === 'string' ? msg.clientId : '';
        if (!this.hostClientId || !this.hostOnline) {
          this.send(conn.server, { t: 'roomNotFound' });
          try { conn.server.close(4004, 'no host'); } catch (e) {}
          return;
        }
        const existing = this.guests.get(clientId);
        if (existing) {
          // 同一 clientId 重连
          if (existing.timer) { clearTimeout(existing.timer); existing.timer = null; }
          if (existing.ws) { try { existing.ws.close(4000, 'replaced'); } catch (e) {} }
          existing.ws = conn.server;
          conn.role = 'guest';
          conn.clientId = clientId;
          this.send(this.hostWs, { t: 'guestJoined', guestId: clientId });
          return;
        }
        if (this.guests.size >= MAX_GUESTS) {
          this.send(conn.server, { t: 'roomFull' });
          try { conn.server.close(4003, 'full'); } catch (e) {}
          return;
        }
        this.guests.set(clientId, { ws: conn.server, timer: null });
        conn.role = 'guest';
        conn.clientId = clientId;
        this.send(this.hostWs, { t: 'guestJoined', guestId: clientId });
        break;
      }
      case 'toHost': {
        if (conn.role !== 'guest' || !this.hostWs) return;
        this.send(this.hostWs, { t: 'toHost', from: conn.clientId, data: msg.data });
        break;
      }
      case 'toGuests': {
        if (conn.role !== 'host') return;
        this.broadcastToGuests({ t: 'guestMessage', data: msg.data });
        break;
      }
      case 'toGuest': {
        if (conn.role !== 'host') return;
        const g = this.guests.get(msg.to);
        if (g && g.ws) this.send(g.ws, { t: 'guestMessage', data: msg.data });
        break;
      }
      case 'kick': {
        if (conn.role !== 'host') return;
        const g = this.guests.get(msg.to);
        if (g) {
          if (g.ws) {
            this.send(g.ws, { t: 'guestMessage', data: msg.data || { type: 'kicked' } });
            try { g.ws.close(4000, 'kicked'); } catch (e) {}
          }
          if (g.timer) clearTimeout(g.timer);
          this.guests.delete(msg.to);
        }
        break;
      }
      case 'leave': {
        if (conn.role === 'host') this.closeRoom();
        else if (conn.role === 'guest') {
          const g = this.guests.get(conn.clientId);
          if (g) {
            if (g.timer) clearTimeout(g.timer);
            this.guests.delete(conn.clientId);
            if (this.hostWs) this.send(this.hostWs, { t: 'guestLeft', guestId: conn.clientId });
          }
        }
        break;
      }
      case 'ping': {
        this.send(conn.server, { t: 'pong' });
        break;
      }
    }
  }

  onClose(conn) {
    if (conn.closed) return;   // close / error 可能都触发，去重
    conn.closed = true;
    if (conn.role === 'host') {
      this.hostOnline = false;
      this.hostWs = null;
      this.broadcastToGuests({ t: 'hostOffline' });
      if (this.hostGraceTimer) clearTimeout(this.hostGraceTimer);
      this.hostGraceTimer = setTimeout(() => this.closeRoom(), GRACE_MS);
    } else if (conn.role === 'guest') {
      const g = this.guests.get(conn.clientId);
      if (!g || g.ws !== conn.server) return; // 已被替换
      g.ws = null;
      if (this.hostWs) this.send(this.hostWs, { t: 'guestLeft', guestId: conn.clientId });
      g.timer = setTimeout(() => { this.guests.delete(conn.clientId); }, GRACE_MS);
    }
  }
}
