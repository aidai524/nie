import { createServer as createHttpServer } from "node:http";

/** 非法 limit 回退到 fallback，过大则封顶，避免被人一句 ?limit=99999999 把库拉爆 */
function clampLimit(raw, fallback, maximum) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), maximum);
}

const STATS_WINDOWS = { "1h": 3600e3, "24h": 86400e3, "7d": 7 * 86400e3 };
const HOURLY_THRESHOLD_MS = 25 * 3600e3;

function handle({ url, send, store, config, healthSnapshot }) {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const query = url.searchParams;

  switch (path) {
    case "/health": {
      const health = healthSnapshot();
      const stale = !health.lastRoundTs || Date.now() - Date.parse(health.lastRoundTs) > config.intervalSec * 1000 * 3;
      send(stale ? 503 : 200, { ok: !stale, ...health });
      return;
    }
    case "/pairs":
      send(200, { pairs: store.getPairsWithState() });
      return;
    case "/latest": {
      const status = query.get("status");
      const latest = store.getLatestPerPair();
      send(200, { latest: status ? latest.filter((row) => row.stateStatus === status) : latest });
      return;
    }
    case "/history": {
      const resolution = query.get("res") === "hourly" ? "hourly" : "raw";
      const rows = store.getHistory({
        pairId: query.get("pair") ?? undefined,
        from: query.get("from") ?? undefined,
        to: query.get("to") ?? undefined,
        limit: clampLimit(query.get("limit"), 1000, 5000),
        resolution,
      });
      send(200, { resolution, rows });
      return;
    }
    case "/stats": {
      const window = query.get("window") ?? "1h";
      const windowMs = STATS_WINDOWS[window];
      if (!windowMs) {
        send(400, { error: `window 只支持 1h | 24h | 7d，收到 ${JSON.stringify(window)}` });
        return;
      }
      const sinceIso = new Date(Date.now() - windowMs).toISOString();
      const resolution = windowMs >= HOURLY_THRESHOLD_MS ? "hourly" : "raw";
      send(200, { window, since: sinceIso, ...store.getStats({ sinceIso, resolution }) });
      return;
    }
    case "/alerts":
      send(200, {
        alerts: store.getAlerts({
          limit: clampLimit(query.get("limit"), 100, 1000),
          since: query.get("since") ?? undefined,
        }),
      });
      return;
    default:
      send(404, { error: `未知端点 ${path}` });
  }
}

export function createServer({ store, config, healthSnapshot = () => ({}), logger = console }) {
  return createHttpServer((request, response) => {
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": config.server.cors,
      Vary: "Origin",
      "Cache-Control": "no-store",
    };
    const send = (status, payload) => {
      response.writeHead(status, headers);
      response.end(JSON.stringify(payload));
    };

    // Host 头是客户端可控且可能畸形的（非法端口、非法字符），new URL 会抛 TypeError。
    // 这一行原本在 try 之外：抛出去就是未捕获异常，一个畸形请求就能把整个监控进程带走
    // —— 而「进程是否还活着」正是这个服务要对外上报的东西。所以先解析、失败就回 400。
    let url;
    try {
      url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    } catch {
      send(400, { error: "请求 URL 无法解析" });
      return;
    }

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        ...headers,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "600",
      });
      response.end();
      return;
    }

    if (request.method !== "GET") {
      send(405, { error: `只支持 GET，收到 ${request.method}` });
      return;
    }

    if (config.server.bearerToken) {
      const provided = request.headers.authorization ?? "";
      if (provided !== `Bearer ${config.server.bearerToken}`) {
        send(401, { error: "未授权：需要 Authorization: Bearer <token>" });
        return;
      }
    }

    try {
      handle({ url, send, store, config, healthSnapshot });
    } catch (error) {
      logger.error(`[server] ${url.pathname} 处理失败: ${error?.stack ?? error?.message ?? error}`);
      send(500, { error: error?.message ?? "内部错误" });
    }
  });
}
