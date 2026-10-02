'use strict';

/**
 * 纯游戏逻辑测试
 * ---------------------------------------------------------------------------
 * 从 index.html 里按名提取真实函数，验证：
 *   1. 棋盘尺寸（25×25）
 *   2. 四方向连五判定（横 / 竖 / 双斜 / 长连 / 不成五）
 *   3. 名次顺延 + 掉线座位跳过的 nextActive
 *   4. 颜色选择（colorOf / teamMate / colorAvailable / firstAvailableColor）
 *   5. stoneVal / seatColor / seatName 按颜色映射
 */

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// 从真实文件读棋盘尺寸，避免与文件脱节
const Nm = html.match(/var N = (\d+), TOTAL = N \* N;/);
if (!Nm) throw new Error('找不到棋盘尺寸定义');
const BOARD_N = parseInt(Nm[1], 10);

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

const FUNCS = [
  'freshState', 'seatCount', 'isTeam', 'stoneVal', 'seatColor', 'seatName',
  'rankOf', 'nextActive', 'findWinLine',
  'colorOf', 'teamMate', 'colorChoices', 'colorAvailable', 'firstAvailableColor',
  'assignDefaultColors'
];

const src = [
  'var N = ' + BOARD_N + ', TOTAL = N * N;',
  'var MODES = {',
  "  ffa3:  {seats:3, team:false, label:'三人自由战'},",
  "  ffa4:  {seats:4, team:false, label:'四人自由战'},",
  "  team4: {seats:4, team:true,  label:'四人组队 2v2'}",
  '};',
  'var COLORS = [',
  "  {key:'black', name:'黑方'},",
  "  {key:'white', name:'白方'},",
  "  {key:'red',   name:'红方'},",
  "  {key:'blue',  name:'蓝方'}",
  '];',
  'var S = null;',
  ...FUNCS.map(extract),
  'return { ' + FUNCS.join(', ') + ', MODES, COLORS, N, TOTAL, setS: function(s){ S = s; }, getS: function(){ return S; } };'
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

/* ---------------- 棋盘尺寸 ---------------- */
section('0. 棋盘尺寸');
ok(api.N === 25 && api.TOTAL === 625, '棋盘为 25×25（共 ' + api.TOTAL + ' 个交叉点）');

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

testWin([idx(0,0), idx(1,0), idx(2,0), idx(3,0), idx(4,0)], idx(2,0), '横向 5 连');
testWin([idx(0,0), idx(0,1), idx(0,2), idx(0,3), idx(0,4)], idx(0,2), '纵向 5 连');
testWin([idx(0,0), idx(1,1), idx(2,2), idx(3,3), idx(4,4)], idx(2,2), '主对角线 5 连');
testWin([idx(0,4), idx(1,3), idx(2,2), idx(3,1), idx(4,0)], idx(2,2), '副对角线 5 连');
testWin([idx(0,0), idx(1,0), idx(2,0), idx(3,0), idx(4,0), idx(5,0)], idx(3,0), '6 连长连也判胜');
testWin([idx(7,7), idx(8,7), idx(9,7), idx(10,7), idx(11,7)], idx(9,7), '任意位置横向 5 连');
// 边角位置（25 棋盘右下角）
testWin([idx(20,24), idx(21,24), idx(22,24), idx(23,24), idx(24,24)], idx(22,24), '右下角横向 5 连');

{
  const b = freshBoard();
  [idx(0,0), idx(1,0), idx(2,0), idx(3,0)].forEach((c) => { b[c] = 1; });
  api.setS({ board: b });
  ok(api.findWinLine(idx(2,0), 1) === null, '4 连不成胜');
}
{
  const b = freshBoard();
  [idx(1,0), idx(2,0), idx(3,0), idx(4,0)].forEach((c) => { b[c] = 1; }); // 缺 idx(0,0)
  api.setS({ board: b });
  ok(api.findWinLine(idx(2,0), 1) === null, '断开的 4 连不成胜');
}

/* ---------------- nextActive 顺延 ---------------- */
section('2. nextActive 名次顺延 / 掉线跳过');

function S3(ranks, connected) {
  return { mode: 'ffa3', ranks: ranks || [], connected: connected || [true, true, true], colors: [0, 1, 2, 3] };
}

api.setS(S3());
ok(api.nextActive(0) === 1, '三人战 0 之后轮到 1');
ok(api.nextActive(1) === 2, '三人战 1 之后轮到 2');
ok(api.nextActive(2) === 0, '三人战 2 之后回到 0');
api.setS(S3([0]));
ok(api.nextActive(0) === 1, '0 已锁定名次后，跳过 0 轮到 1');
api.setS(S3([], [true, false, true]));
ok(api.nextActive(0) === 2, '座位 1 掉线，从 0 直接跳到 2');
api.setS({ mode: 'ffa4', ranks: [], connected: [true, true, true, true], colors: [0, 1, 2, 3] });
ok(api.nextActive(3) === 0, '四人战 3 之后回到 0');

/* ---------------- 颜色选择 ---------------- */
section('3. colorOf / 颜色映射');

api.setS({ mode: 'ffa3', colors: [2, 0, 1, 3] });
ok(api.colorOf(0) === 2, 'colorOf 读取自定义颜色（座位 0 = 红）');
api.setS({ mode: 'ffa3', colors: undefined });
ok(api.colorOf(1) === 1, '老数据无 colors 时回退按座位（ffa 座位 1 = 白）');
api.setS({ mode: 'team4', colors: undefined });
ok(api.colorOf(3) === 1, '老数据无 colors 时回退按座位（team 座位 3 = 白）');

// stoneVal 自由战按颜色
api.setS({ mode: 'ffa4', colors: [2, 0, 1, 3] });
ok(api.stoneVal(0) === 3 && api.stoneVal(1) === 1 && api.stoneVal(2) === 2 && api.stoneVal(3) === 4,
  '自由战 stoneVal = 颜色+1（红=3、黑=1、白=2、蓝=4）');

// stoneVal 组队按颜色（黑=1、白=2）
api.setS({ mode: 'team4', colors: [0, 1, 1, 0] });
ok(api.stoneVal(0) === 1 && api.stoneVal(1) === 2 && api.stoneVal(2) === 2 && api.stoneVal(3) === 1,
  '组队 stoneVal 同色一致（黑=1、白=2）');

// seatColor 组队
api.setS({ mode: 'team4', colors: [0, 1, 1, 0] });
ok(api.seatColor(0).key === 'black' && api.seatColor(1).key === 'white' &&
   api.seatColor(2).key === 'white' && api.seatColor(3).key === 'black',
  '组队 seatColor 同色为同一颜色');

/* ---------------- seatName ---------------- */
section('4. seatName 按颜色命名');
api.setS({ mode: 'ffa3', colors: [2, 0, 1, 3] });
ok(api.seatName(0) === '红方' && api.seatName(1) === '黑方', '自由战 seatName 显示所选颜色名');

api.setS({ mode: 'team4', colors: [0, 1, 1, 0] });
ok(api.seatName(0) === '黑队·甲' && api.seatName(1) === '白队·甲' &&
   api.seatName(2) === '白队·乙' && api.seatName(3) === '黑队·乙',
  '组队 seatName 同色为同队、甲乙按座位序');

/* ---------------- teamMate ---------------- */
section('5. teamMate 同色队友');
api.setS({ mode: 'team4', colors: [0, 1, 1, 0] });
ok(api.teamMate(0) === 3 && api.teamMate(3) === 0, '黑队队友（座位 0/3）');
ok(api.teamMate(1) === 2 && api.teamMate(2) === 1, '白队队友（座位 1/2）');
api.setS({ mode: 'team4', colors: [0, 0, 1, 1] });
ok(api.teamMate(0) === 1 && api.teamMate(2) === 3, '队友按颜色而非固定座位（0/1 黑、2/3 白）');

/* ---------------- colorAvailable / firstAvailableColor ---------------- */
section('6. colorAvailable / firstAvailableColor');

// 自由战：每色唯一
api.setS({ mode: 'ffa3', joined: [true, true, true, false], colors: [0, 1, 2, 3] });
ok(api.colorAvailable(3, 1) === true, '自由战未占用的蓝可被选');
ok(api.colorAvailable(0, 1) === false, '自由战已占用的黑不可被选');

// 组队：每色最多 2 人
api.setS({ mode: 'team4', joined: [true, true, true, true], colors: [0, 1, 1, 0] });
ok(api.colorAvailable(1, 2) === true, '组队白队还有空位可加入');
ok(api.colorAvailable(0, 2) === false, '组队黑队已满 2 人不可再加');

// firstAvailableColor：房主占了红，新玩家应拿到黑
api.setS({ mode: 'ffa3', joined: [true, true, false, false], colors: [2, 1, 2, 3] });
ok(api.firstAvailableColor(2) === 0, '房主占红后，新玩家默认拿黑');

// assignDefaultColors
api.setS({ mode: 'ffa4', colors: [2, 0, 1, 3] });
api.assignDefaultColors();
ok(JSON.stringify(api.getS().colors) === '[0,1,2,3]', 'assignDefaultColors 自由战重置为 黑白红蓝');
api.setS({ mode: 'team4', colors: [2, 0, 1, 3] });
api.assignDefaultColors();
ok(JSON.stringify(api.getS().colors) === '[0,1,0,1]', 'assignDefaultColors 组队重置为 黑黑白白');

/* ---------------- rankOf / seatCount ---------------- */
section('7. 其它辅助函数');
api.setS({ mode: 'ffa3' });
ok(api.seatCount() === 3 && api.isTeam() === false, 'ffa3 = 3 座，非组队');
api.setS({ mode: 'team4' });
ok(api.seatCount() === 4 && api.isTeam() === true, 'team4 = 4 座，组队');
api.setS({ ranks: [2, 0] });
ok(api.rankOf(2) === 0 && api.rankOf(0) === 1 && api.rankOf(1) === -1, 'rankOf 名次索引正确');

console.log('\n' + '='.repeat(60));
console.log(`逻辑测试： ${passed} 通过 / ${failed} 失败`);
console.log('='.repeat(60));
process.exit(failed ? 1 : 0);
