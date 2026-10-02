# 多人五子棋后端 —— 通用容器镜像
# 适用：Zeabur / Koyeb / Railway / Fly.io 等所有基于容器的平台
FROM node:20-alpine

WORKDIR /app

# 先复制依赖清单，利用镜像层缓存
COPY package.json ./
RUN npm install --omit=dev

# 复制其余代码
COPY . .

ENV PORT=3000
EXPOSE 3000

# 启动命令（走 package.json 的 start 脚本：node server.js）
CMD ["npm", "start"]
