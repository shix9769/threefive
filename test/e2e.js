'use strict';

/**
 * 端到端联机测试（原生 WebSocket 协议）
 * ---------------------------------------------------------------------------
 * 启动本地 Node 后端（server.js），用 ws 客户端完整模拟房主 + 多名房客的交互，
 * 覆盖建房 / 进房 / 转发 / 广播 / 定向消息 / 满员 / 踢人 / 掉线宽限 / 重连恢复。
 * 该协议与 Cloudflare Worker（src/worker.js）完全一致。
 *
 *   node test/e2e.js
 */

const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = Number(process.env.TEST_PORT) || 3999;
const GRACE_MS = 4000;
// 若设置了 E2E_BASE（例如 http://127.0.0.1:8787），则测试该外部后端（如 wrangler dev），
// 不自己启动 server.js。这样同一套用例可同时验证 Node 版与 Cloudflare Worker 版。
const EXTERNAL = process.env.E2E_BASE || '';
const BASE = EXTERNAL ? EXTERNAL.replace(/^http/, 'ws') : `ws://127.0.0.1:${PORT}`;
const HEALTH_URL = EXTERNAL || `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, label) {
  if (cond) { passed++; console.log('   \u2705 ' + label); }
  else { failed++; failures.push(label); console.log('   \u274c ' + label); }
}
function section(t) { console.log('\n\u25b6 ' + t); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(name, roomId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE}/room/${roomId}`);
    ws.__name = name;
    ws.__queue = [];     // 已到达、但当时还没有等待者的消息
    ws.__waiters = [];
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      // 先尝试交给等待者
      for (let i = 0; i < ws.__waiters.length; i++) {
        const w = ws.__waiters[i];
        if (!w.pred || w.pred(msg)) {
          ws.__waiters.splice(i, 1);
          clearTimeout(w.timer);
          w.resolve(msg);
          return;
        }
      }
      // 没人等就先入队，避免“消息早于 waiter”的竞态丢包
      ws.__queue.push(msg);
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function send(ws, obj) {
  ws.send(JSON.stringify(obj));
}

function waitFor(ws, pred, timeout = 4000) {
  // 队列里可能已经有更早到达的匹配消息，先消化它
  for (let i = 0; i < ws.__queue.length; i++) {
    if (!pred || pred(ws.__queue[i])) {
      return Promise.resolve(ws.__queue.splice(i, 1)[0]);
    }
  }
  return new Promise((resolve, reject) => {
    const w = {
      pred,
      resolve,
      timer: setTimeout(() => {
        const i = ws.__waiters.indexOf(w);
        if (i >= 0) ws.__waiters.splice(i, 1);
        reject(new Error(ws.__name + ' 等待消息超时'));
      }, timeout)
    };
    ws.__waiters.push(w);
  });
}

function waitClose(ws, timeout = 4000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), timeout);
    ws.once('close', () => { clearTimeout(t); resolve(true); });
  });
}

async function waitForHttp(retries = 60) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(`${HEALTH_URL}/healthz`);
      if (r.ok) return await r.json();
    } catch (_) {}
    await sleep(250);
  }
  throw new Error('服务器启动超时');
}

async function main() {
  let server = null;
  const serverLog = [];
  if (!EXTERNAL) {
    server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: Object.assign({}, process.env, { PORT: String(PORT), GRACE_MS: String(GRACE_MS) }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', (d) => serverLog.push(String(d).trim()));
    server.stderr.on('data', (d) => serverLog.push('ERR ' + String(d).trim()));
  } else {
    serverLog.push('(外部后端模式：' + EXTERNAL + ')');
  }

  try {
    const health = await waitForHttp();
    console.log('服务器已启动:', JSON.stringify(health));

    /* ============================ 1. 建房 + 进房 ============================ */
    section('1. 房主建房，两名房客进入');

    const host = await connect('host', 'room1');
    const rrP = waitFor(host, (m) => m.t === 'roomReady');
    send(host, { t: 'host', clientId: 'host-1' });
    const rr = await rrP;
    ok(rr && rr.t === 'roomReady', '房主收到 roomReady');

    const g1 = await connect('guest1', 'room1');
    const gj1 = waitFor(host, (m) => m.t === 'guestJoined' && m.guestId === 'g-1');
    send(g1, { t: 'guest', clientId: 'g-1' });
    const gj1m = await gj1;
    ok(gj1m.guestId === 'g-1', '房主收到 guestJoined(g-1)');

    const g2 = await connect('guest2', 'room1');
    const gj2 = waitFor(host, (m) => m.t === 'guestJoined' && m.guestId === 'g-2');
    send(g2, { t: 'guest', clientId: 'g-2' });
    await gj2;
    ok(true, '房主收到 guestJoined(g-2)');

    /* ============================ 2. 房主分配座位 + 广播 ============================ */
    section('2. 房主欢迎 + 全场广播同步');

    // 模拟前端 hostHandleJoin：给 g-1 座位 1，g-2 座位 2，然后广播 state
    send(host, { t: 'toGuest', to: 'g-1', data: { type: 'welcome', seat: 1 } });
    send(host, { t: 'toGuest', to: 'g-2', data: { type: 'welcome', seat: 2 } });

    const w1 = await waitFor(g1, (m) => m.t === 'guestMessage' && m.data.type === 'welcome');
    const w2 = await waitFor(g2, (m) => m.t === 'guestMessage' && m.data.type === 'welcome');
    ok(w1.data.seat === 1 && w2.data.seat === 2, '两名房客各自拿到座位');

    const b1 = waitFor(g1, (m) => m.t === 'guestMessage' && m.data.type === 'state');
    const b2 = waitFor(g2, (m) => m.t === 'guestMessage' && m.data.type === 'state');
    send(host, { t: 'toGuests', data: { type: 'state', s: { turn: 0 } } });
    await Promise.all([b1, b2]);
    ok(true, '房主 toGuests 广播，两名房客都收到 state');

    /* ============================ 3. 房客 -> 房主 转发 ============================ */
    section('3. 房客消息转发给房主');
    const hm = waitFor(host, (m) => m.t === 'toHost' && m.from === 'g-1');
    send(g1, { t: 'toHost', data: { type: 'move', idx: 112 } });
    const hmMsg = await hm;
    ok(hmMsg.data.idx === 112, '房主收到房客 g-1 的 move(112)，from 正确');

    /* ============================ 4. 定向消息 ============================ */
    section('4. 定向消息只发给指定房客');
    const onlyG2 = waitFor(g2, (m) => m.t === 'guestMessage' && m.data.type === 'ping');
    send(host, { t: 'toGuest', to: 'g-2', data: { type: 'ping' } });
    await onlyG2;
    ok(true, '定向消息到达 g-2');

    /* ============================ 5. 满员（第 4 个房客） ============================ */
    section('5. 满员拒绝');
    const g3 = await connect('guest3', 'room1');
    send(g3, { t: 'guest', clientId: 'g-3' });
    const w3 = waitFor(g3, (m) => m.t === 'guestMessage' && m.data.type === 'welcome');
    send(host, { t: 'toGuest', to: 'g-3', data: { type: 'welcome', seat: 3 } });
    await w3;
    ok(true, '第 3 名房客（第 4 人）也进来了');

    const g4 = await connect('guest4', 'room1');
    const full = waitFor(g4, (m) => m.t === 'roomFull');
    send(g4, { t: 'guest', clientId: 'g-4' });
    await full;
    ok(true, '第 5 人收到 roomFull（服务器层 4 人上限）');
    g4.close();

    /* ============================ 6. 踢人 ============================ */
    section('6. 房主踢人');
    const kicked = waitFor(g3, (m) => m.t === 'guestMessage' && m.data.type === 'kicked');
    send(host, { t: 'kick', to: 'g-3', data: { type: 'kicked' } });
    await kicked;
    ok(true, '被踢房客收到 kicked 消息');

    /* ============================ 7. 房客主动离开 ============================ */
    section('7. 房客主动离开');
    const left = waitFor(host, (m) => m.t === 'guestLeft' && m.guestId === 'g-2');
    send(g2, { t: 'leave' });
    await left;
    ok(true, '房主收到 guestLeft(g-2)');
    g2.close();

    /* ============================ 8. 房间不存在 ============================ */
    section('8. 房间不存在');
    const nx = await connect('guestX', 'nosuchroom');
    const nf = waitFor(nx, (m) => m.t === 'roomNotFound');
    send(nx, { t: 'guest', clientId: 'x-1' });
    await nf;
    ok(true, '加入无房主的房间返回 roomNotFound');
    nx.close();

    /* ============================ 9. 房主掉线宽限 + 重连 ============================ */
    section('9. 房主掉线宽限与重连恢复');

    const h2 = await connect('host2', 'room2');
    const rr2 = waitFor(h2, (m) => m.t === 'roomReady');
    send(h2, { t: 'host', clientId: 'h2' });
    await rr2;

    const c2 = await connect('client2', 'room2');
    const cj = waitFor(h2, (m) => m.t === 'guestJoined' && m.guestId === 'c2');
    send(c2, { t: 'guest', clientId: 'c2' });
    await cj;
    const cw = waitFor(c2, (m) => m.t === 'guestMessage' && m.data.type === 'welcome');
    send(h2, { t: 'toGuest', to: 'c2', data: { type: 'welcome', seat: 1 } });
    await cw;

    // 房主掉线（强制断开传输）
    const offline = waitFor(c2, (m) => m.t === 'hostOffline', null, 3000);
    h2.terminate();
    await offline;
    ok(true, '房客收到 hostOffline');

    // 房主用同一 clientId 重连，应恢复（宽限期内）
    const h2b = await connect('host2-rejoin', 'room2');
    const rr2b = waitFor(h2b, (m) => m.t === 'roomReady');
    send(h2b, { t: 'host', clientId: 'h2' });
    await rr2b;
    const online = waitFor(c2, (m) => m.t === 'hostOnline', null, 3000);
    await online;
    ok(true, '房主同 clientId 重连恢复，房客收到 hostOnline');

    // 恢复后房主仍能广播
    const still = waitFor(c2, (m) => m.t === 'guestMessage' && m.data.type === 'state' && m.data.s && m.data.s.ping === 1);
    send(h2b, { t: 'toGuests', data: { type: 'state', s: { ping: 1 } } });
    await still;
    ok(true, '恢复后房主仍能正常广播');

    // 房主彻底离开 -> 房客收到 hostLeft
    const gone = waitFor(c2, (m) => m.t === 'hostLeft', null, 3000);
    send(h2b, { t: 'leave' });
    await gone;
    ok(true, '房主主动离开，房客收到 hostLeft');

    h2b.close();
    c2.close();
    host.close();
    g1.close();

    /* ============================ 汇总 ============================ */
    console.log('\n' + '='.repeat(62));
    console.log(`测试结果： ${passed} 通过 / ${failed} 失败`);
    if (failed) {
      console.log('失败项：');
      failures.forEach((f) => console.log('  - ' + f));
    }
    console.log('='.repeat(62));
  } catch (err) {
    console.error('\n💥 测试中断:', err && err.message);
    failed++;
    console.log('--- 服务器日志尾部 ---');
    console.log(serverLog.slice(-25).join('\n'));
  } finally {
    if (server) server.kill('SIGKILL');
  }

  process.exit(failed ? 1 : 0);
}

main();
