# 多人五子棋（25×25 · 三人 / 四人 · 可自选颜色）

三人自由战、四人自由战、四人 2v2 组队；**25×25 大棋盘**；支持**自选棋子颜色**；纯浏览器联机，无需下载。

## 🌐 线上地址

**<https://threefive-gomoku-web.pages.dev>**

直接打开就能玩，国内**不需要代理**。房主把地址发给朋友即可（点「分享链接」会自动带上房间号）。

---

## 架构：为什么前端放 Pages、后端放 Worker

```
   浏览器
     │  https://threefive-gomoku-web.pages.dev/            → 前端页面（Cloudflare Pages）
     │  wss://threefive-gomoku-web.pages.dev/room/ab12     → 联机中继（同源，无跨域）
     ▼
┌──────────────────── Cloudflare Pages（pages.dev）────────────────────┐
│  index.html        前端（静态）                                       │
│  _worker.js        高级模式 Worker：/room/* 经 Service Binding 转发    │
└───────────────────────────────┬──────────────────────────────────────┘
                                ▼  Service Binding
┌──────────────── Cloudflare Worker「threefive-gomoku」─────────────────┐
│  Durable Object「Room」：每个房间一个实例                              │
│   · 记录房主 / 房客连接   · 转发落子与广播棋局状态   · 掉线 90 秒可重连   │
└──────────────────────────────────────────────────────────────────────┘
```

**⚠️ 关键坑（踩过）**：`*.workers.dev` 在国内**被 DNS 污染 + TCP 阻断**（即使拿到真实
Cloudflare IP 也连不上，`curl --resolve` 同样 000）。而 `*.pages.dev` 国内可以直连。
所以前端放在 Pages，再通过 **Service Binding** 把 WebSocket 转发给定义 Durable Object 的
Worker —— 两者在 Cloudflare 内部通信，不经过公网，也就绕开了封锁。

**其他好处**：完全免费、**不需要信用卡**、永久在线（不像 Render 要绑卡、Glitch 会休眠）；
全程原生 WebSocket，不依赖 WebRTC / NAT 打洞 / TURN；规则裁决在房主浏览器里，服务器只转发。

## 目录结构

```
├── src/worker.js            Cloudflare Worker + Durable Object「Room」（生产后端）
├── public/
│   ├── index.html           游戏前端（唯一真源）
│   └── _worker.js           Pages 高级模式 Worker（转发 /room/* 给上面的 Worker）
├── pages/wrangler.toml      Pages 项目配置（含 Service Binding）
├── wrangler.toml            Worker 配置（Durable Object 绑定 + 迁移）
├── server.js                本地 Node 后端（原生 WebSocket，同一套协议，用于本地开发/自建）
├── package.json             依赖与脚本
├── Dockerfile / Procfile    自建 Node 后端时用
└── test/
    ├── logic.test.js        纯游戏规则（37 项）
    ├── e2e.js               联机协议（16 项，可打本机 Node / Worker / 线上站点）
    └── frontend.test.js     前端集成（14 项，加载真实 index.html 脚本跑联机）
```

前后端使用**同一套 JSON 协议**（见 `src/worker.js` 顶部注释），所以本地 Node 版、Worker 版、
线上 Pages 版行为一致，测试用例可以互打。

---

## 本地运行

需要 **Node.js 18+**（[官网](https://nodejs.org/)；国内可用 [npmmirror 镜像](https://npmmirror.com/mirrors/node/)）。

```bash
pnpm install        # 或 npm install
npm start           # 启动本地后端，同时托管前端
```

浏览器打开 <http://localhost:3000>，开多个标签页即可本地联机。手机同 WiFi 可用电脑局域网 IP 访问。

```bash
npm test            # 规则 + 协议 + 前端集成，共 67 项
npm run test:live   # 直接拿线上站点跑协议 + 前端集成，共 30 项
```

---

## 部署（两步）

前置：Node.js 18+ 和**免费 Cloudflare 账号**（<https://dash.cloudflare.com/sign-up>，邮箱注册，**不用绑卡**）。

### 第 1 步：部署 Worker（Durable Object 宿主）

```bash
npx wrangler login     # 浏览器授权
npx wrangler deploy    # 得到 threefive-gomoku.<你的子域>.workers.dev
```

> 若报 `You need a workers.dev subdomain`，去 <https://dash.cloudflare.com> 打开一次
> **Workers & Pages** 页面即可自动开通子域，然后重跑。

### 第 2 步：部署 Pages（这才是给朋友访问的地址）

```bash
npm run deploy:web
```

首次需要先建项目（只做一次）：<https://dash.cloudflare.com> → **Workers & Pages** →
**Create** → **Pages** → 项目名填 `threefive-gomoku-web`。

完成后得到 **<https://threefive-gomoku-web.pages.dev>**，这就是最终地址。

> `pages/wrangler.toml` 里已经配好 `[[services]]` 绑定，指向第 1 步的 Worker，
> 所以 Pages 上的 `/room/*` 会自动转发过去，**无需再手工配置任何东西**。

---

## 备选方案

### A. 前端另放 Netlify（后端仍在 Cloudflare）

把 `public/index.html` 顶部改成后端地址，再把 `public/` 发到 Netlify：

```js
window.GOMOKU_SERVER = 'https://threefive-gomoku-web.pages.dev';
```

> 注意：仍然要填 **pages.dev** 地址，不能填 workers.dev（国内访问不了）。
> 只有当你确定朋友都能访问 workers.dev 时才填它。

### B. 完全自建

`server.js` 是和 Worker 同协议的 Node 版：

```bash
npm install && npm start      # 默认 3000 端口
```

有公网服务器就直接跑；只有自己的电脑就配合内网穿透
（`cloudflared tunnel --url http://localhost:3000`，`trycloudflare.com` 国内实测可直连），
但电脑要保持开机。

---

## 怎么玩

1. 打开 <https://threefive-gomoku-web.pages.dev>，页面生成 4 位房间号，地址变成 `...#房间号`。
2. 点「分享链接」发给朋友；朋友点开自动进房。
3. 房主在等待界面选模式：**三人自由战 / 四人自由战 / 四人组队 2v2**；每位玩家点色块选自己的棋子颜色（自由战四色不重复；组队时颜色即队伍，同色为队友）。
4. 玩家到齐自动开局；先连成五子者胜。自由战中胜出者锁定名次，其余人继续对决，直到排出全部名次。

键盘也能下：方向键移动，回车 / 空格落子。

---

## 常见问题

**Q：免费吗？会扣费吗？**
A：不会。Workers 和 Pages 免费版都不需要绑卡；免费额度（Workers 每天 10 万次请求、Pages 无限静态请求）
对这个游戏绰绰有余。

**Q：为什么不用 workers.dev 的地址？**
A：`*.workers.dev` 在国内被封锁（DNS 污染 + TCP 阻断），朋友不开代理打不开。
`*.pages.dev` 国内可直连，所以最终地址是 pages.dev 的那个。

**Q：页面打不开 / 一直「无法连接服务器」？**
A：先 `curl https://threefive-gomoku-web.pages.dev/healthz`，应返回 `{"ok":true,"rooms":0}`。
若前端另放别处，检查 `window.GOMOKU_SERVER` 是否填对（不带结尾斜杠）。

**Q：房主关掉页面会怎样？**
A：后端保留房间约 90 秒，期间房主刷新/重连可恢复；超时后房客看到「房间已解散」。

**Q：有人掉线会卡住吗？**
A：不会。掉线玩家的轮次会自动顺延给下一个在线玩家；同一标签页重连还能回到原座位。

**Q：想改棋盘大小 / 颜色 / 玩法？**
A：都在 `public/index.html` 开头的游戏脚本里：`N`（棋盘 25）、`COLORS`、`MODES`。
改完 `npm run deploy:web` 重新部署即可（后端不用动）。

**Q：手机屏幕小，25×25 太密？**
A：可横屏，或把 `N` 改小后重新部署。
