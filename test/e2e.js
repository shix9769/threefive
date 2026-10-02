'use strict';

/**
 * 端到端联机测试
 * ---------------------------------------------------------------------------
 * 启动真实服务器，用 socket.io-client 完整模拟「房主 + 多个房客」的全部交互，
 * 覆盖建房 / 进房 / 落子转发 / 状态广播 / 定向消息 / 满员踢人 /
 * 主动离开 / 掉线宽限 / 断线会话恢复 等所有协议路径。
 *
 *   node test/e2e.js
 */

const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = Number(process.env.TEST_PORT) || 3999;
const GRACE_MS = 4000;
const URL = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, label) {
  if (cond) {
    passed++;
    console.log('   \u2705 ' + label);
  } else {
    failed++;
    failures.push(label);
    console.log('   \u274c ' + label);
  }
}
function section(title) {
  console.log('\n\u25b6 ' + title);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(name, opts) {
  const s = io(URL, Object.assign({ transports: ['websocket'], forceNew: true, reconnection: false }, opts));
  s.__name = name;
  return s;
}
function ready(sock) {
  if (sock.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(sock.__name + ' 连接超时')), 5000);
    sock.once('connect', () => { clearTimeout(t); resolve(); });
  });
}
function waitFor(sock, ev, pred, timeout = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { sock.off(ev, h); reject(new Error(sock.__name + ' 等待 ' + ev + ' 超时')); }, timeout);
    function h(data) {
      if (!pred || pred(data)) { clearTimeout(t); sock.off(ev, h); resolve(data); }
    }
    sock.on(ev, h);
  });
}
function never(sock, ev, ms = 500) {
  return new Promise((resolve) => {
    function h() { sock.off(ev, h); clearTimeout(t); resolve(false); }
    const t = setTimeout(() => { sock.off(ev, h); resolve(true); }, ms);
    sock.on(ev, h);
  });
}

/* ------------------------------------------------------------------ */
async function waitForHttp(retries = 60) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(URL + '/healthz');
      if (r.ok) return await r.json();
    } catch (_) { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('服务器启动超时');
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), GRACE_MS: String(GRACE_MS) }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const serverLog = [];
  server.stdout.on('data', (d) => serverLog.push(String(d).trim()));
  server.stderr.on('data', (d) => serverLog.push('ERR ' + String(d).trim()));

  try {
    const health = await waitForHttp();
    console.log('服务器已启动:', JSON.stringify(health));

    /* ============================ 1. 建房 + 两人进房 ============================ */
    section('1. 房主建房，两名房客依次进入并拿到座位');

    const host = connect('host');
    await ready(host);
    const rrP = waitFor(host, 'roomReady', null, 3000);
    host.emit('createRoom', { roomId: 'room1' });
    const rr = await rrP;
    ok(rr && rr.roomId === 'room1' && rr.resumed === false, '房主收到 roomReady 且房间号正确');

    const g1 = connect('guest1');
    const g2 = connect('guest2');
    await Promise.all([ready(g1), ready(g2)]);

    // 房主先挂上分配座位的逻辑（模拟前端 hostHandleJoin）
    const seatOf = {};
    host.on('guestJoined', (p) => {
      const used = Object.values(seatOf);
      let seat = -1;
      for (let i = 1; i < 3; i++) if (!used.includes(i)) { seat = i; break; }
      if (seat === -1) {
        host.emit('kickGuest', { to: p.guestId, data: { type: 'full', mode: 'ffa3' } });
        return;
      }
      seatOf[p.guestId] = seat;
      host.emit('toGuest', { to: p.guestId, data: { type: 'welcome', seat } });
      host.emit('toGuests', { type: 'state', s: { board: [], turn: 0 } });
    });
    host.on('guestLeft', (p) => { delete seatOf[p.guestId]; });

    const w1 = waitFor(g1, 'guestMessage', (d) => d.type === 'welcome');
    const hj1 = waitFor(host, 'guestJoined');
    g1.emit('joinRoom', { roomId: 'room1' });
    const m1 = await w1;
    await hj1;
    ok(m1.seat === 1, '房客1 拿到座位 1');

    const w2 = waitFor(g2, 'guestMessage', (d) => d.type === 'welcome');
    g2.emit('joinRoom', { roomId: 'room1' });
    const m2 = await w2;
    ok(m2.seat === 2, '房客2 拿到座位 2');

    const st1 = await waitFor(g1, 'guestMessage', (d) => d.type === 'state');
    ok(st1.s && st1.s.turn === 0, '房客收到房主广播的 state（落子前状态）');

    /* ============================ 2. 落子转发 + 全场广播 ============================ */
    section('2. 房客落子消息转发给房主，房主广播状态给全场');

    const hostGot = waitFor(host, 'hostMessage', (p) => p.data && p.data.type === 'move');
    g1.emit('toHost', { type: 'move', idx: 112 });
    const hm = await hostGot;
    ok(hm.from === g1.id && hm.data.idx === 112, '房主收到来自房客1 的 move(112)，来源 socket.id 正确');

    const both1 = waitFor(g1, 'guestMessage', (d) => d.type === 'state' && d.s && d.s.lastMove === 112);
    const both2 = waitFor(g2, 'guestMessage', (d) => d.type === 'state' && d.s && d.s.lastMove === 112);
    host.emit('toGuests', { type: 'state', s: { board: [], turn: 1, lastMove: 112 } });
    const [b1, b2] = await Promise.all([both1, both2]);
    ok(b1 && b2, '房客1 与 房客2 同时收到广播（全场同步）');

    const hostSelf = await never(host, 'guestMessage', 400);
    ok(hostSelf === true, '房主自己不会收到自己的广播（避免重复渲染）');

    /* ============================ 3. 定向消息 ============================ */
    section('3. 定向消息只发给指定房客');
    const onlyG2 = waitFor(g2, 'guestMessage', (d) => d.type === 'ping');
    const g1Silent = never(g1, 'guestMessage', 400);
    host.emit('toGuest', { to: g2.id, data: { type: 'ping' } });
    await onlyG2;
    ok(true, '房客2 收到定向消息');
    ok(await g1Silent, '房客1 没有收到定向给房客2 的消息');

    /* ============================ 4. 满员踢人 ============================ */
    section('4. 座位不够时房主把多余玩家踢出房间');
    const g3 = connect('guest3');
    await ready(g3);
    const fullMsg = waitFor(g3, 'guestMessage', (d) => d.type === 'full');
    g3.emit('joinRoom', { roomId: 'room1' });
    const fm = await fullMsg;
    ok(fm.mode === 'ffa3', '第 3 名房客收到 full 消息并附带模式');
    await sleep(200);
    const g3Silent = never(g3, 'guestMessage', 500);
    host.emit('toGuests', { type: 'state', s: { note: 'after-kick' } });
    ok(await g3Silent, '被踢出的房客不再收到房间广播');
    g3.close();

    /* ============================ 5. 主动离开 ============================ */
    section('5. 房客主动离开，座位释放');
    const left = waitFor(host, 'guestLeft', (p) => p.guestId === g2.id);
    g2.emit('leaveRoom');
    await left;
    ok(true, '房主收到 guestLeft 通知');

    const g4 = connect('guest4');
    await ready(g4);
    const w4 = waitFor(g4, 'guestMessage', (d) => d.type === 'welcome');
    g4.emit('joinRoom', { roomId: 'room1' });
    const m4 = await w4;
    ok(m4.seat === 2, '新玩家可以顶上空出来的座位 2');
    g4.close();

    /* ============================ 6. 房间不存在 / 服务器满员 ============================ */
    section('6. 异常路径');
    const gx = connect('guestX');
    await ready(gx);
    const nf = waitFor(gx, 'roomNotFound');
    gx.emit('joinRoom', { roomId: 'nosuchroom' });
    ok((await nf).roomId === 'nosuchroom', '加入不存在的房间返回 roomNotFound');
    gx.close();

    const host2 = connect('host2');
    await ready(host2);
    const h2ready = waitFor(host2, 'roomReady');
    host2.emit('createRoom', { roomId: 'room2' });
    await h2ready;
    const four = [connect('f1'), connect('f2'), connect('f3'), connect('f4')];
    await Promise.all(four.map(ready));
    const overFull = Promise.race([
      ...four.map((f) => waitFor(f, 'roomFull', null, 3000).then(() => f.__name)),
      sleep(3500).then(() => null)
    ]);
    four.forEach((f) => f.emit('joinRoom', { roomId: 'room2' }));
    const rejected = await overFull;
    ok(rejected !== null, '服务器层 4 人上限生效，多出的连接被拒绝（' + rejected + ' 收到 roomFull）');
    four.forEach((f) => f.close());
    host2.close();

    /* ============================ 7. 房主掉线宽限 ============================ */
    section('7. 房主掉线：先通知，宽限期后才解散房间');
    const h3 = connect('host3');
    await ready(h3);
    const h3ready = waitFor(h3, 'roomReady');
    h3.emit('createRoom', { roomId: 'room3' });
    await h3ready;

    const c3 = connect('client3');
    await ready(c3);
    const wc = waitFor(c3, 'guestMessage', (d) => d.type === 'welcome');
    h3.on('guestJoined', (p) => h3.emit('toGuest', { to: p.guestId, data: { type: 'welcome', seat: 1 } }));
    c3.emit('joinRoom', { roomId: 'room3' });
    await wc;

    const offline = waitFor(c3, 'hostOffline', null, 3000);
    h3.disconnect();
    await offline;
    ok(true, '房客收到 hostOffline（而不是立刻解散）');

    // 宽限期内房间还在，且此时加入会收到 hostOffline 提示
    const probe = connect('probe');
    await ready(probe);
    const probeRes = await new Promise((resolve) => {
      probe.once('roomNotFound', resolve);
      probe.once('roomFull', () => resolve({ roomFull: true }));
      probe.emit('joinRoom', { roomId: 'room3' });
      setTimeout(() => resolve({ timeout: true }), 2000);
    });
    ok(probeRes.roomId === 'room3', '房主掉线期间房间仍保留（返回房间存在但房主离线）');
    probe.close();

    const gone = waitFor(c3, 'hostLeft', null, GRACE_MS + 4000);
    await gone;
    ok(true, '宽限期结束后房客收到 hostLeft（房间解散）');

    const after = connect('after');
    await ready(after);
    const nr = waitFor(after, 'roomNotFound', null, 3000);
    after.emit('joinRoom', { roomId: 'room3' });
    const nrData = await nr;
    ok(!nrData.hostOffline, '房间已彻底销毁（roomNotFound 且不再标记 hostOffline）');
    after.close();
    c3.close();
    host.close();
    g1.close();

    /* ============================ 8. 断线会话恢复 ============================ */
    section('8. 瞬时断网后自动恢复会话（connectionStateRecovery）');
    const hr = connect('hostRecover', { reconnection: true, reconnectionDelay: 300 });
    await ready(hr);
    const hrReady = waitFor(hr, 'roomReady');
    hr.emit('createRoom', { roomId: 'room4' });
    await hrReady;

    const cr = connect('clientRecover', { reconnection: true, reconnectionDelay: 300 });
    await ready(cr);
    hr.on('guestJoined', (p) => hr.emit('toGuest', { to: p.guestId, data: { type: 'welcome', seat: 1 } }));
    const wcr = waitFor(cr, 'guestMessage', (d) => d.type === 'welcome');
    cr.emit('joinRoom', { roomId: 'room4' });
    await wcr;
    const oldId = cr.id;

    // 房主被强行断掉底层传输（模拟地铁/切后台），客户端自动重连
    const recovered = new Promise((resolve) => hr.once('connect', () => resolve(hr.recovered)));
    hr.io.engine.close();
    const didRecover = await Promise.race([
      recovered,
      sleep(6000).then(() => 'timeout')
    ]);
    ok(didRecover === true, '房主断网重连后被服务端恢复了原会话（recovered=true）');

    const stillThere = waitFor(cr, 'guestMessage', (d) => d.type === 'state' && d.s && d.s.ping === 1, 3000);
    hr.emit('toGuests', { type: 'state', s: { ping: 1 } });
    await stillThere;
    ok(true, '恢复会话后房主仍能正常向房间广播');
    ok(cr.id === oldId, '房客的 socket.id 全程未变（未掉线）');

    hr.close();
    cr.close();

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
    server.kill('SIGKILL');
  }

  process.exit(failed ? 1 : 0);
}

main();
