# 多人五子棋（三人 / 四人 · 联机版）

三人自由战、四人自由战、四人 2v2 组队，纯浏览器联机，无需下载。

## 架构

```
┌─────────────────┐        WebSocket         ┌──────────────────────┐
│   Netlify        │  ◄────────────────────►  │   Render             │
│   public/        │   （房间 + 消息中转）      │   server.js          │
│   index.html     │                          │   (Socket.IO)        │
└─────────────────┘                          └──────────────────────┘
```

- **前端** `public/index.html`：纯静态页，含全部棋盘绘制与胜负判定逻辑。
  规则仍由「房主」浏览器权威计算，与之前保持一致。
- **后端** `server.js`：只做「房间管理 + 消息转发」，不存棋局、不做裁决。
- **通信**：全程一条 WebSocket 连接。**不依赖 WebRTC / NAT 打洞 / TURN**，
  因此在国内各种宽带、4G/5G 网络下都能稳定联机。
- **断线恢复**：开启 socket.io 的 `connectionStateRecovery`，手机切后台、
  地铁短暂断网会自动恢复会话，不会踢人。

## 目录结构

```
├── server.js            后端（Socket.IO 中继）
├── package.json         依赖与脚本
├── pnpm-lock.yaml       锁定依赖版本
├── render.yaml          Render Blueprint 一键部署配置
├── netlify.toml         Netlify 部署配置（发布 public/ 目录）
├── .node-version        固定 Node 20
├── public/
│   └── index.html       游戏前端（★ 唯一需要改配置的地方）
└── test/
    ├── e2e.js           端到端联机测试（22 项）
    └── logic.test.js    纯游戏规则测试（23 项）
```

## ★ 唯一需要改的配置

打开 `public/index.html`，顶部有一段：

```html
<script>
window.GOMOKU_SERVER = '';
</script>
```

- **本地测试**：留空 `''` 即可（自动连当前页面同源）。
- **线上部署**：改成你的 Render 后端地址，例如：

```html
window.GOMOKU_SERVER = 'https://threefive.onrender.com';
```

> 注意：不要带结尾的 `/`。改完把最新版 `public/index.html` 再发布到 Netlify 一次。

---

## 本地运行

```bash
# 安装依赖（任选其一）
pnpm install      # 或  npm install

# 启动（默认端口 3000）
node server.js
# 或  npm start
```

浏览器打开 `http://localhost:3000`。想要多人联机测试，开多个标签页或手机访问同一局域网 IP 即可。

运行测试：

```bash
node test/logic.test.js   # 纯规则测试
node test/e2e.js          # 端到端联机测试（会自动起一个测试服务）
```

---

## 部署（三步）

### 第 1 步：把代码推送到 GitHub

```bash
cd ~/Desktop/gomoku-server
git add -A
git commit -m "改用 Socket.IO 中继架构，支持远程联机"
git push -u origin main        # 或 master，以你本地分支为准
```

> 远端仓库 `https://github.com/shix9769/threefive.git` 目前是空的，首次 push 用 `-u` 建立关联。

### 第 2 步：Render 部署后端

**方式 A —— Blueprint 一键部署（推荐）**

1. 打开 <https://render.com>，注册/登录（建议用 GitHub 账号）。
2. 点 **New +** → **Blueprint**。
3. 关联 `shix9769/threefive` 仓库，Render 会读取 `render.yaml` 自动创建 Web 服务。
4. 等待部署完成，复制它给你的地址，形如 `https://threefive.onrender.com`。

**方式 B —— 手动创建 Web 服务**

1. Render 控制台点 **New +** → **Web Service**，关联仓库。
2. 按下面填：

| 配置项 | 值 |
|---|---|
| Build Command | `npm install` |
| Start Command | `npm start` |
| Instance Type | Free |

3. 等部署完成，记下 `https://<服务名>.onrender.com` 这个地址。

> 免费实例空闲约 15 分钟会休眠，下次访问有约 30~60 秒冷启动，属正常现象。
> 首次打开时如果报「无法连接服务器」，**等 1 分钟再刷新**即可。

### 第 3 步：Netlify 部署前端

1. 打开 <https://app.netlify.com>，用 GitHub 登录。
2. **Add new site** → **Import an existing project** → 选 `threefive` 仓库。
3. Netlify 会读取 `netlify.toml`（发布目录已设为 `public`）。若它要求手动填：
   - Build command：留空
   - Publish directory：`public`
4. Deploy 完成后，你会得到一个 `https://xxx.netlify.app` 地址。

> **可选**：也可以不进 Git 流程，直接打开 Netlify 的 **Sites** 页面，把本地 `public/`
> 文件夹整个拖进去（Drag & drop）。只是这样以后每次改代码要重新拖。

### 第 4 步：把后端地址写进前端（关键！）

1. 回到本地，打开 `public/index.html`，把 `window.GOMOKU_SERVER` 改成第 2 步拿到的 Render 地址。
2. 重新推送到 GitHub（Netlify 会自动重新部署），或重新拖拽到 Netlify。

---

## 怎么玩

1. 房主打开链接，页面会生成一个 4 位房间号，并把链接变成 `https://xxx.netlify.app#房间号`。
2. 点「分享链接」发给朋友；朋友点开即自动进房。
3. 房主在等待界面可选模式：**三人自由战 / 四人自由战 / 四人组队 2v2**。
4. 玩家到齐自动开局；先连成五子者胜。自由战中胜出者锁定名次，其余人继续对决直到排出全部名次。

---

## 常见问题（FAQ）

**Q：朋友打开链接一直「无法连接服务器」？**
A：先确认第 4 步的 `window.GOMOKU_SERVER` 已改成 Render 地址并重新发布前端；
Render 免费实例冷启动要 30~60 秒，多等一会儿刷新。

**Q：房主关掉页面会怎样？**
A：后端会保留房间约 90 秒，期间房主重开页面可恢复；超时后房客会看到「房间已解散」。

**Q：有人掉线卡住了？**
A：已修复。掉线玩家的轮次会自动顺延给下一个在线玩家，不会再整局卡死。

**Q：想自己改规则 / 棋盘大小？**
A：前端逻辑都在 `public/index.html` 里，`N`（棋盘 15）、`MODES`（玩法）都在文件开头的
游戏脚本内，改完重新发布前端即可，后端无需动。

**Q：Render 免费版会睡怎么办？**
A：这是免费版限制。保持有人在线游玩就不会休眠；或升级 Render 付费实例即常驻。
