'use strict';

/**
 * 纯游戏逻辑测试
 * ---------------------------------------------------------------------------
 * 从 index.html 里按名提取真实函数，验证：
 *   1. 四方向连五判定（横 / 竖 / 双斜 / 长连 / 不成五）
 *   2. 名次顺延 + 掉线座位跳过的 nextActive
 *   3. stoneVal / rankOf 等辅助函数
 */

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

function extract(name) {
  const start = html.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('未找到函数: ' + name);
  const open = html.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    const ch = html[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error('函数括号不匹配: ' + name);
}

const src = [
  'var N = 15, TOTAL = N * N;',
  'var MODES = {',
  "  ffa3:  {seats:3, team:false, label:'三人自由战'},",
  "  ffa4:  {seats:4, team:false, label:'四人自由战'},",
  "  team4: {seats:4, team:true,  label:'四人组队 2v2'}",
  '};',
  'var S = null;',
  extract('freshState'),
  extract('seatCount'),
  extract('isTeam'),
  extract('stoneVal'),
  extract('rankOf'),
  extract('nextActive'),
  extract('findWinLine'),
  'return { freshState, seatCount, isTeam, stoneVal, rankOf, nextActive, findWinLine, MODES, N, TOTAL, setS: function(s){ S = s; } };'
].join('\n');

const api = new Function(src)();

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('   \u2705 ' + label); }
  else { failed++; console.log('   \u274c ' + label); }
}
function section(t) { console.log('\n\u25b6 ' + t); }
function idx(x, y) { return y * api.N + x; }

/* ---------------- 连五判定 ---------------- */
section('1. findWinLine 四方向连五判定');

function freshBoard() { return new Array(api.TOTAL).fill(0); }
function testWin(cells, at, label) {
  const b = freshBoard();
  cells.forEach((c) => { b[c] = 1; });
  api.setS({ board: b });
  const r = api.findWinLine(at, 1);
  const got = r ? r.slice().sort((a, b) => a - b).join(',') : null;
  const want = cells.slice().sort((a, b) => a - b).join(',');
  ok(got === want, label);
}

testWin([0, 1, 2, 3, 4], 2, '横向 5 连');
testWin([0, 15, 30, 45, 60], 30, '纵向 5 连');
testWin([0, 16, 32, 48, 64], 32, '主对角线 5 连');
testWin([4, 18, 32, 46, 60], 32, '副对角线 5 连');
testWin([0, 1, 2, 3, 4, 5], 3, '6 连长连也判胜');
testWin([idx(7, 7), idx(8, 7), idx(9, 7), idx(10, 7), idx(11, 7)], idx(9, 7), '任意位置横向 5 连');

// 不成五
{
  const b = freshBoard();
  [0, 1, 2, 3].forEach((c) => { b[c] = 1; });
  api.setS({ board: b });
  ok(api.findWinLine(2, 1) === null, '4 连不成胜');
}
// 被挡住的五连
{
  const b = freshBoard();
  [1, 2, 3, 4].forEach((c) => { b[c] = 1; }); // 缺 0
  api.setS({ board: b });
  ok(api.findWinLine(2, 1) === null, '断开的 4 连不成胜');
}

/* ---------------- nextActive 顺延 ---------------- */
section('2. nextActive 名次顺延 / 掉线跳过');

function S3(ranks, connected) {
  return { mode: 'ffa3', ranks: ranks || [], connected: connected || [true, true, true] };
}

api.setS(S3());
ok(api.nextActive(0) === 1, '三人战 0 之后轮到 1');
ok(api.nextActive(1) === 2, '三人战 1 之后轮到 2');
ok(api.nextActive(2) === 0, '三人战 2 之后回到 0');

api.setS(S3([0]));
ok(api.nextActive(0) === 1, '0 已锁定名次后，跳过 0 轮到 1');

api.setS(S3([1], [true, true, true]));
ok(api.nextActive(0) === 2, '1 已锁定名次，从 0 顺延跳过 1 到 2');

api.setS(S3([], [true, false, true]));
ok(api.nextActive(0) === 2, '座位 1 掉线，从 0 直接跳到 2');

api.setS(S3([1], [true, false, true]));
ok(api.nextActive(0) === 2, '座位 1 掉线且已锁定，从 0 跳到 2');

api.setS(S3([2], [true, false, true]));
ok(api.nextActive(0) === 0, '其余座位都不可用，保持原座位（等待玩家回归）');

// 四人战顺延
api.setS({ mode: 'ffa4', ranks: [], connected: [true, true, true, true] });
ok(api.nextActive(3) === 0, '四人战 3 之后回到 0');

/* ---------------- 辅助函数 ---------------- */
section('3. stoneVal / rankOf / seatCount');

api.setS({ mode: 'ffa3' });
ok(api.seatCount() === 3, 'ffa3 = 3 座');
ok(api.isTeam() === false, 'ffa3 非组队');
ok(api.stoneVal(0) === 1 && api.stoneVal(1) === 2 && api.stoneVal(2) === 3, 'ffa3 棋子值 1/2/3');

api.setS({ mode: 'team4' });
ok(api.seatCount() === 4 && api.isTeam() === true, 'team4 = 4 座且为组队');
ok(api.stoneVal(0) === 1 && api.stoneVal(1) === 2 && api.stoneVal(2) === 1 && api.stoneVal(3) === 2, 'team4 队友同色（0/2=1，1/3=2）');

api.setS({ ranks: [2, 0] });
ok(api.rankOf(2) === 0 && api.rankOf(0) === 1 && api.rankOf(1) === -1, 'rankOf 名次索引正确');

console.log('\n' + '='.repeat(60));
console.log(`逻辑测试： ${passed} 通过 / ${failed} 失败`);
console.log('='.repeat(60));
process.exit(failed ? 1 : 0);
