const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// 房间状态管理
const rooms = {};

io.on('connection', (socket) => {
  console.log(`[连接] ${socket.id}`);

  // 1. 加入/创建房间 (对应前端 socket.emit('joinRoom', ...))
  socket.on('joinRoom', ({ roomId, playerName }) => {
    if (!rooms[roomId]) rooms[roomId] = { players: [], readyCount: 0, gameStarted: false };
    const room = rooms[roomId];

    if (room.players.length >= 3) {
      socket.emit('roomFull');
      return;
    }

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerName = playerName;
    
    const playerId = room.players.length + 1; // 1, 2, 3
    room.players.push({ id: socket.id, name: playerName, playerId, ready: false });
    
    // 通知当前玩家分配到的身份
    socket.emit('assignedPlayer', { playerId, totalPlayers: room.players.length });
    // 广播房间内人数更新
    io.to(roomId).emit('updatePlayers', room.players.map(p => ({ name: p.name, playerId: p.playerId, ready: p.ready })));
    
    console.log(`[加入] ${playerName} 进入房间 ${roomId}, 身份: 玩家${playerId}, 当前人数: ${room.players.length}`);
  });

  // 2. 玩家准备 (对应前端 socket.emit('playerReady'))
  socket.on('playerReady', () => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    
    const player = room.players.find(p => p.id === socket.id);
    if (player && !player.ready) {
      player.ready = true;
      room.readyCount++;
      io.to(socket.data.roomId).emit('updatePlayers', room.players.map(p => ({ name: p.name, playerId: p.playerId, ready: p.ready })));
      
      // 3人全部准备则自动开始游戏
      if (room.readyCount === 3 && !room.gameStarted) {
        room.gameStarted = true;
        io.to(socket.data.roomId).emit('gameStart');
        console.log(`[开局] 房间 ${socket.data.roomId} 全员准备，游戏开始`);
      }
    }
  });

  // 3. 落子 (对应前端 socket.emit('makeMove', ...))
  socket.on('makeMove', (moveData) => {
    // 直接转发给房间内其他玩家，不做服务端校验（保持与你前端逻辑一致）
    socket.to(socket.data.roomId).emit('opponentMove', moveData);
  });

  // 4. 重新开始 (对应前端 socket.emit('restartGame'))
  socket.on('restartGame', () => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    // 重置准备状态
    room.players.forEach(p => p.ready = false);
    room.readyCount = 0;
    room.gameStarted = false;
    io.to(socket.data.roomId).emit('updatePlayers', room.players.map(p => ({ name: p.name, playerId: p.playerId, ready: p.ready })));
    io.to(socket.data.roomId).emit('gameRestarted');
  });

  // 5. 聊天消息 (对应前端 socket.emit('chatMessage', ...))
  socket.on('chatMessage', (msg) => {
    socket.to(socket.data.roomId).emit('chatMessage', msg);
  });

  // 6. 断线处理
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;
    
    const room = rooms[roomId];
    room.players = room.players.filter(p => p.id !== socket.id);
    if (room.players.length === 0) {
      delete rooms[roomId];
      console.log(`[销毁] 房间 ${roomId} 已清空`);
    } else {
      io.to(roomId).emit('updatePlayers', room.players.map(p => ({ name: p.name, playerId: p.playerId, ready: p.ready })));
      io.to(roomId).emit('playerDisconnected', { playerName: socket.data.playerName });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 五子棋后端已启动，端口: ${PORT}`));