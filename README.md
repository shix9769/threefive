# 多人五子棋（25×25 · 三人 / 四人 · 可自选颜色）

三人自由战、四人自由战、四人 2v2 组队；**25×25 大棋盘**；支持**自选棋子颜色**；纯浏览器联机，无需下载。

## 架构：一个 Worker 同时托管前端 + 联机后端

```
   浏览器
     │  https://threefive-gomoku.<子域>.workers.dev/         → 返回前端页面
     │  wss://threefive-gomoku.<子域>.workers.dev/room/ab12  → 联机中继
     ▼
┌──────────────────────────── Cloudflare Worker ────────────────────────────┐
│  fetch()                                                                  │
│   ├─ /                → public/index.html（前端，已打进 Worker）            │
│   ├─ /healthz         → 健康检查                                            │
│   └─ /room/<房间号>    → Durable Object「Room」实例（每个房间一个）           │
│                          · 记录房主 / 房客连接                              │
│                          · 转发落子、广播棋局状态                            │
│                          · 掉线 90 秒内可重连恢复                            │
└───────────────────────────────────────────────────────────────────────────┘
```

**为什么选它**：Cloudflare Workers 免费版 **不需要信用卡**、**永久在线**（不像 Render / Glitch 免费版要绑卡或会休眠）、国内可访问，而且前后端同源，一条命令就能部署。

- 通信走**原生 WebSocket**，不依赖 WebRTC / NAT 打洞 / TURN，国内各种网络都稳。
- 规则裁决仍在**房主浏览器**里（房主权威），服务器只做房间与消息转发。
- `Durable Object` 每个房间一个实例，天然隔离，房间空了自动回收。

## 目录结构

```
├── src/worker.js         Cloudflare Worker + Durable Object（生产后端）
├── server.js             本地 Node 后端（原生 WebSocket，同一套协议，用于本地开发/自建）
├── wrangler.toml         Cloudflare 部署配置
├── public/index.html     游戏前端（Worker 会把它打进包里同源托管）
├── package.json          依赖与脚本
├── pnpm-workspace.yaml   允许 pnpm 构建 esbuild / workerd 原生二进制
├── Dockerfile
├── Procfile              自建 Node 后端时用（任意容器平台）
├── netlify.toml          仅当你想把前端单独放到 Netlify 时才用
└── test/
    ├── logic.test.js     纯游戏规则（37 项）
    ├── e2e.js            联机协议（16 项，可打本机 Node 或 Cloudflare Worker）
    └── frontend.test.js  前端集成（14 项，加载真实 index.html 脚本跑联机）
```

前后端使用**同一套 JSON 协议**（见 `src/worker.js` 顶部注释），所以本地 Node 版和线上 Worker 版行为一致，测试用例可以复用。

---

## 本地运行

需要 **Node.js 18+**（[官网下载](https://nodejs.org/)；国内可用 [npmmirror 镜像](https://npmmirror.com/mirrors/node/)）。

```bash
pnpm install        # 或 npm install
npm start           # 启动本地后端，同时托管前端
```

浏览器打开 <http://localhost:3000>，开多个标签页就能本地联机测试。

想让手机在同一 WiFi 下参与，用电脑的局域网 IP 访问，例如 `http://192.168.1.5:3000`。

跑测试：

```bash
npm test                # 规则 + 协议 + 前端集成，共 67 项
npm run dev:cf          # 起本地 Cloudflare Worker 运行时（wrangler dev）
npm run test:worker     # 另开终端，用同一套协议测试打 Worker
```

---

## 部署到 Cloudflare Workers（推荐，一条命令）

### 前置

1. **Node.js 18+**（同上）。
2. **免费 Cloudflare 账号**：<https://dash.cloudflare.com/sign-up> —— 只需邮箱，**不需要信用卡**。

### 部署

在仓库目录执行：

```bash
npx wrangler login     # 会自动打开浏览器，点授权即可
npx wrangler deploy
```

看到 `Deployed threefive-gomoku triggers` 那一行里的地址，形如：

```
https://threefive-gomoku.你的子域.workers.dev
```

**这个地址就是完整游戏**：直接打开就能玩，不用再配任何东西。

> `npx wrangler deploy` 会自动读取 `wrangler.toml`、把 `public/index.html` 打进 Worker、创建 Durable Object，全程无需手改配置。

### 部署后自测

```bash
curl https://threefive-gomoku.你的子域.workers.dev/healthz
# 期望输出 {"ok":true,"rooms":0}
```

---

## 备选方案

### A. 前端单独放 Netlify，后端在 Workers

如果你更喜欢 Netlify 的静态托管：

1. Netlify 导入本仓库，发布目录设为 `public`（仓库已带 `netlify.toml`）。
2. 把 `public/index.html` 顶部的 `window.GOMOKU_SERVER` 改成你的 Worker 地址：

```js
window.GOMOKU_SERVER = 'https://threefive-gomoku.你的子域.workers.dev';
```

3. 重新部署前端。后端仍在 Workers 上，跨域没问题（Worker 已允许任意来源）。

### B. 完全自建（自己的电脑 / 任意服务器）

`server.js` 是和 Worker 同协议的 Node 版，任何能跑 Node 的地方都能用：

```bash
npm install && npm start      # 默认 3000 端口
```

- 有公网服务器：直接跑，把 `window.GOMOKU_SERVER` 指过去。
- 只有自己的电脑：配合内网穿透（如 `cloudflared tunnel --url http://localhost:3000`）把端口暴露出去，注意电脑要保持开机。

---

## 怎么玩

1. 打开部署好的地址，页面会生成一个 4 位房间号，地址变成 `...#房间号`。
2. 点「分享链接」发给朋友；朋友点开即自动进房。
3. 房主在等待界面选模式：**三人自由战 / 四人自由战 / 四人组队 2v2**；每位玩家点色块选自己的棋子颜色（自由战四色不重复；组队时颜色即队伍，同色为队友）。
4. 玩家到齐自动开局；先连成五子者胜。自由战中胜出者锁定名次，其余人继续对决，直到排出全部名次。

键盘也能下：方向键移动，回车 / 空格落子。

---

## 常见问题

**Q：Cloudflare 免费版够用吗？会收费吗？**
A：够。免费版每天 10 万次请求，本游戏一次对局只有几十次消息，完全用不完；Cloudflare 免费版不需要绑卡，不会自动扣费。

**Q：页面打不开 / 一直「无法连接服务器」？**
A：先 `curl <你的地址>/healthz` 看后端是否正常。若前端单独部署到别处，检查 `window.GOMOKU_SERVER` 是否填对（不带结尾斜杠）。

**Q：房主关掉页面会怎样？**
A：后端保留房间约 90 秒，期间房主刷新/重连可恢复；超时后房客看到「房间已解散」。

**Q：有人掉线会卡住吗？**
A：不会。掉线玩家的轮次会自动顺延给下一个在线玩家；90 秒内重连（同一标签页）还能回到原座位。

**Q：想改棋盘大小 / 颜色 / 玩法？**
A：都在 `public/index.html` 开头的游戏脚本里：`N`（棋盘尺寸，默认 25）、`COLORS`（颜色）、`MODES`（玩法）。改完 `npx wrangler deploy` 重新部署即可，后端不用动。

**Q：手机屏幕小，25×25 太密？**
A：可以旋转横屏，或把 `N` 改小后重新部署。
