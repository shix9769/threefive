'use strict';

/**
 * 多人五子棋 —— Socket.IO 房间中继服务器
 * ---------------------------------------------------------------------------
 * 设计要点：
 *  1. 服务器只做「房间 + 消息转发」，不保存棋局、不做规则裁决。
 *     棋盘状态与胜负判定仍由房主（seat 0）的浏览器权威计算，
 *     与本项目原有前端逻辑保持一致，改动面最小。
 *  2. 全部流量走一条 WebSocket 连接到本服务，不依赖 WebRTC / NAT 打洞 / TURN，
 *     因此在国内各种宽带、4G/5G 网络下都能稳定联机。
 *  3. 开启 socket.io 的 connectionStateRecovery，配合宽限期，
 *     手机切后台、地铁断网等瞬时掉线可以自动恢复，不会踢掉玩家。
 *
 * 事件协议
 * ---------------------------------------------------------------------------
 *  浏览器 -> 服务器
 *    createRoom {roomId}              房主建房
 *    joinRoom   {roomId}              房客进房
 *    toHost     {data}                房客 -> 房主
 *    toGuests   {data}                房主 -> 全场房客
 *    toGuest    {to, data}            房主 -> 指定房客
 *    kickGuest  {to, data}            房主把某个房客移出房间
 *    leaveRoom                        主动离开（关页面 / 点「新房间」）
 *
 *  服务器 -> 房主
 *    roomReady  {roomId, resumed}     房间已就绪（resumed=true 表示断线重连回来）
 *    roomExists {roomId}              房间号撞号，需要换一个
 *    guestJoined{guestId, resumed}    有房客进来
 *    guestLeft  {guestId}             房客掉线
 *    hostMessage{from, data}          房客发来的消息
 *    hostOnline / hostOffline         房主自己重连成功 / 掉线
 *
 *  服务器 -> 房客
 *    guestMessage {data}              房主转发来的消息（welcome / full / kicked / state）
 *    roomNotFound {roomId}            房间不存在
 *    roomFull                         房间人数已满
 *    hostLeft                         房主离开，房间解散
 *    hostOnline / hostOffline         房主重连成功 / 掉线
 *    serverError  {message}           参数错误等
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

/** 掉线宽限期：房主/房客断线后保留房间与座位的时间（配合前端自动重连） */
const GRACE_MS = Number(process.env.GRACE_MS) || 90 * 1000;
/** 最多 4 名玩家（房主 + 3 名房客），对应 ffa4 / team4 模式 */
const MAX_GUESTS = 3;
/** 房间号：3~12 位小写字母或数字 */
const ROOM_ID_RE = /^[a-z0-9]{3,12}$/;

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  // 断线重连时恢复原 socket.id 与所在房间，让瞬时掉线无感
  connectionStateRecovery: {
    maxDisconnectionDuration: 90 * 1000,
    skipMiddlewares: true
  },
  pingInterval: 20000,
  pingTimeout: 25000
});

/**
 * roomId -> {
 *   hostId: string,                      房主 socket.id
 *   hostOnline: boolean,
 *   hostTimer: NodeJS.Timeout | null,    房主断线后的关房定时器
 *   members: Map<socketId, {online: boolean, timer: NodeJS.Timeout|null}>
 * }
 */
const rooms = new Map();

/* ------------------------------------------------------------------ */
/* 静态资源：本地测试时直接托管 public/ 里的前端                          */
/* ------------------------------------------------------------------ */
app.use(express.static(path.join(__dirname, 'public')));

// Render / 负载均衡健康检查
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) });
});

/* ------------------------------------------------------------------ */
/* 工具函数                                                             */
/* ------------------------------------------------------------------ */
function normalizeRoomId(raw) {
  if (typeof raw !== 'string') return null;
  const id = raw.trim().toLowerCase();
  return ROOM_ID_RE.test(id) ? id : null;
}

function onlineGuestCount(room) {
  let n = 0;
  for (const m of room.members.values()) if (m.online) n++;
  return n;
}

function closeRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  rooms.delete(roomId);
  if (room.hostTimer) clearTimeout(room.hostTimer);
  for (const m of room.members.values()) if (m.timer) clearTimeout(m.timer);
  io.to(roomId).emit('hostLeft');
  io.in(roomId).socketsLeave(roomId);
  console.log(`[销毁] 房间 ${roomId} 已关闭`);
}

/* ------------------------------------------------------------------ */
/* 连接处理                                                             */
/* ------------------------------------------------------------------ */

/**
 * 断线重连（connectionStateRecovery）：把玩家放回原房间。
 * 必须在所有 socket.on(...) 事件处理器注册之后调用，
 * 否则恢复后的 socket 会缺少业务事件处理器。
 */
function recoverSession(socket) {
  if (!socket.recovered) return;

  for (const [roomId, room] of rooms) {
    if (room.hostId === socket.id) {
      if (room.hostTimer) {
        clearTimeout(room.hostTimer);
        room.hostTimer = null;
      }
      room.hostOnline = true;
      socket.data.roomId = roomId;
      socket.data.isHost = true;
      socket.join(roomId);
      socket.emit('roomReady', { roomId, resumed: true });
      io.to(roomId).emit('hostOnline');
      console.log(`[恢复] 房主重连回房间 ${roomId}`);
      return;
    }

    const member = room.members.get(socket.id);
    if (member) {
      if (member.timer) {
        clearTimeout(member.timer);
        member.timer = null;
      }
      member.online = true;
      socket.data.roomId = roomId;
      socket.data.isHost = false;
      socket.join(roomId);
      io.to(room.hostId).emit('guestJoined', { guestId: socket.id, resumed: true });
      console.log(`[恢复] 房客重连回房间 ${roomId}`);
      return;
    }
  }
  console.log(`[恢复] ${socket.id} 未找到对应房间，按新连接处理`);
}

io.on('connection', (socket) => {
  console.log(`[连接] ${socket.id}${socket.recovered ? ' (会话已恢复)' : ''}`);

  /* ---------- 1. 房主建房 ---------- */
  socket.on('createRoom', (payload) => {
    const roomId = normalizeRoomId(payload && payload.roomId);
    if (!roomId) {
      socket.emit('serverError', { message: '房间号不合法' });
      return;
    }
    if (rooms.has(roomId)) {
      socket.emit('roomExists', { roomId });
      return;
    }

    rooms.set(roomId, {
      hostId: socket.id,
      hostOnline: true,
      hostTimer: null,
      members: new Map()
    });
    socket.data.roomId = roomId;
    socket.data.isHost = true;
    socket.join(roomId);
    socket.emit('roomReady', { roomId, resumed: false });
    console.log(`[建房] ${roomId} by ${socket.id}`);
  });

  /* ---------- 2. 房客进房 ---------- */
  socket.on('joinRoom', (payload) => {
    const roomId = normalizeRoomId(payload && payload.roomId);
    if (!roomId) {
      socket.emit('serverError', { message: '房间号不合法' });
      return;
    }

    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('roomNotFound', { roomId });
      return;
    }
    if (!room.hostOnline) {
      socket.emit('roomNotFound', { roomId, hostOffline: true });
      return;
    }
    // 服务器层面只兜底 4 人上限，具体座位够不够由房主判断
    if (onlineGuestCount(room) >= MAX_GUESTS) {
      socket.emit('roomFull', { roomId });
      return;
    }

    room.members.set(socket.id, { online: true, timer: null });
    socket.data.roomId = roomId;
    socket.data.isHost = false;
    socket.join(roomId);
    io.to(room.hostId).emit('guestJoined', { guestId: socket.id, resumed: false });
    console.log(`[进房] ${socket.id} -> ${roomId}（在线房客 ${onlineGuestCount(room)}）`);
  });

  /* ---------- 3. 房客 -> 房主 ---------- */
  socket.on('toHost', (data) => {
    const roomId = socket.data.roomId;
    const room = roomId && rooms.get(roomId);
    if (!room || socket.data.isHost) return;
    io.to(room.hostId).emit('hostMessage', { from: socket.id, data });
  });

  /* ---------- 4. 房主 -> 全体房客 ---------- */
  socket.on('toGuests', (data) => {
    const roomId = socket.data.roomId;
    const room = roomId && rooms.get(roomId);
    if (!room || !socket.data.isHost) return;
    socket.to(roomId).emit('guestMessage', data);
  });

  /* ---------- 5. 房主 -> 指定房客 ---------- */
  socket.on('toGuest', (payload) => {
    const roomId = socket.data.roomId;
    const room = roomId && rooms.get(roomId);
    if (!room || !socket.data.isHost) return;
    const to = payload && payload.to;
    if (typeof to !== 'string') return;
    io.to(to).emit('guestMessage', payload.data || {});
  });

  /* ---------- 6. 房主移出房客（满员 / 切换模式） ---------- */
  socket.on('kickGuest', (payload) => {
    const roomId = socket.data.roomId;
    const room = roomId && rooms.get(roomId);
    if (!room || !socket.data.isHost) return;

    const to = payload && payload.to;
    const member = typeof to === 'string' ? room.members.get(to) : null;
    if (!member) return;

    if (member.timer) clearTimeout(member.timer);
    room.members.delete(to);

    io.to(to).emit('guestMessage', payload.data || { type: 'kicked' });
    const guest = io.sockets.sockets.get(to);
    if (guest) {
      guest.leave(roomId);
      guest.data.roomId = null;
    }
    console.log(`[移出] ${to} <- ${roomId}`);
  });

  /* ---------- 7. 主动离开 ---------- */
  socket.on('leaveRoom', () => {
    const roomId = socket.data.roomId;
    const room = roomId && rooms.get(roomId);
    if (!room) return;

    if (socket.data.isHost) {
      closeRoom(roomId);
      return;
    }

    const member = room.members.get(socket.id);
    if (member && member.timer) clearTimeout(member.timer);
    room.members.delete(socket.id);
    io.to(room.hostId).emit('guestLeft', { guestId: socket.id });
    socket.leave(roomId);
    socket.data.roomId = null;
    console.log(`[离开] ${socket.id} <- ${roomId}`);
  });

  /* ---------- 8. 断线 ---------- */
  socket.on('disconnect', (reason) => {
    const roomId = socket.data.roomId;
    const room = roomId && rooms.get(roomId);
    if (!room) return;

    if (socket.data.isHost) {
      room.hostOnline = false;
      io.to(roomId).emit('hostOffline');
      if (room.hostTimer) clearTimeout(room.hostTimer);
      // 给宽限期，期间房主重连（含 connectionStateRecovery）房间都不会丢
      room.hostTimer = setTimeout(() => closeRoom(roomId), GRACE_MS);
      console.log(`[房主掉线] ${roomId} (${reason})，${GRACE_MS / 1000}s 后关房`);
      return;
    }

    const member = room.members.get(socket.id);
    if (!member) return;
    member.online = false;
    io.to(room.hostId).emit('guestLeft', { guestId: socket.id });
    if (member.timer) clearTimeout(member.timer);
    member.timer = setTimeout(() => {
      room.members.delete(socket.id);
      console.log(`[超时移除] ${socket.id} <- ${roomId}`);
    }, GRACE_MS);
    console.log(`[房客掉线] ${socket.id} <- ${roomId} (${reason})`);
  });

  // 断线重连恢复（必须放在所有事件处理器注册之后）
  recoverSession(socket);
});

/* ------------------------------------------------------------------ */
server.listen(PORT, () => {
  console.log(`🚀 五子棋联机服务器已启动，端口: ${PORT}`);
});

// 优雅退出，避免 Render 重启时残留连接
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`收到 ${sig}，正在关闭…`);
    io.close(() => server.close(() => process.exit(0)));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
