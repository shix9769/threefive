/**
 * Cloudflare Pages 高级模式（_worker.js）
 * ---------------------------------------------------------------------------
 * 为什么需要它：*.workers.dev 在国内被封（DNS 污染 + TCP 阻断），
 * 而 *.pages.dev 国内可以直连。所以：
 *   · 静态前端由 Pages 托管（pages.dev，国内可达）
 *   · /room/<房间号> 的 WebSocket 通过 Service Binding 转发给
 *     Worker「threefive-gomoku」，由它里面的 Durable Object 处理房间逻辑
 * 这样前端与联机后端都在同一个 pages.dev 源上，国内不用代理就能玩。
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 健康检查 + 联机 WebSocket 交给后台 Worker
    if (url.pathname === '/healthz' || /^\/room\/[a-z0-9]{3,12}$/.test(url.pathname)) {
      return env.BACKEND.fetch(request);
    }

    // 其余走 Pages 静态资源（index.html 等）
    return env.ASSETS.fetch(request);
  }
};
