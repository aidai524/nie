import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { openStore } from "../src/store.js";
import { createServer } from "../src/server.js";

const PAIR = {
  id: "near:USDC>eth:USDC", label: "near:USDC → eth:USDC", fromKey: "near:USDC", toKey: "eth:USDC",
  fromAsset: "x", toAsset: "y", swapType: "EXACT_OUTPUT", amount: "1500",
  amountMinor: "1500000000", fromDecimals: 6, toDecimals: 6,
};
const row = (ts, overrides = {}) => ({
  ts, pairId: PAIR.id, ok: true, httpStatus: 201, latencyMs: 1000,
  amountIn: "1501.5", amountOut: "1500", ...overrides,
});

async function withServer({ bearerToken = "", health, cors = "*" } = {}, seed = () => {}) {
  const store = openStore(":memory:");
  store.upsertPairs([PAIR], "2026-09-15T00:00:00Z");
  seed(store);
  const config = { intervalSec: 60, server: { host: "127.0.0.1", port: 0, cors, bearerToken } };
  const server = createServer({
    store, config,
    healthSnapshot: health ?? (() => ({ startedAt: "2026-09-15T00:00:00.000Z", lastRoundTs: new Date().toISOString(), lastRoundDurationMs: 1200, consecutiveRoundErrors: 0, pairs: 1 })),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    config,
    async get(path, init) { return fetch(`${base}${path}`, init); },
    async close() { server.close(); await once(server, "close"); store.close(); },
  };
}

test("GET /health 新鲜时 200", async () => {
  const ctx = await withServer();
  const res = await ctx.get("/health");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.pairs, 1);
  await ctx.close();
});

test("GET /health 超过 3 倍 intervalSec 未采集时 503", async () => {
  const stale = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const ctx = await withServer({ health: () => ({ startedAt: stale, lastRoundTs: stale, lastRoundDurationMs: 1, consecutiveRoundErrors: 3, pairs: 1 }) });
  const res = await ctx.get("/health");
  assert.equal(res.status, 503);
  assert.equal((await res.json()).ok, false);
  await ctx.close();
});

test("GET /pairs 返回白名单及状态", async () => {
  const ctx = await withServer({}, (store) => {
    store.upsertPairState({ pairId: PAIR.id, status: "error", statusSince: "2026-09-15T00:00:00Z", consecutiveFailures: 2 });
  });
  const body = await (await ctx.get("/pairs")).json();
  assert.equal(body.pairs.length, 1);
  assert.equal(body.pairs[0].state.status, "error");
  await ctx.close();
});

test("GET /latest 返回每对最新一条，并支持 status 过滤", async () => {
  const ctx = await withServer({}, (store) => {
    store.insertQuotes([row("2026-09-15T00:00:00Z", { amountIn: "1" }), row("2026-09-15T00:01:00Z", { amountIn: "2" })]);
    store.upsertPairState({ pairId: PAIR.id, status: "error", statusSince: "2026-09-15T00:01:00Z", consecutiveFailures: 1 });
  });
  const all = await (await ctx.get("/latest")).json();
  assert.equal(all.latest.length, 1);
  assert.equal(all.latest[0].amountIn, "2");
  assert.equal((await (await ctx.get("/latest?status=error")).json()).latest.length, 1);
  assert.equal((await (await ctx.get("/latest?status=ok")).json()).latest.length, 0);
  await ctx.close();
});

test("GET /history 支持 limit 与时间窗", async () => {
  const ctx = await withServer({}, (store) => {
    store.insertQuotes([row("2026-09-15T00:00:00Z"), row("2026-09-15T00:01:00Z"), row("2026-09-15T00:02:00Z")]);
  });
  const limited = await (await ctx.get("/history?limit=2")).json();
  assert.equal(limited.rows.length, 2);
  assert.equal(limited.resolution, "raw");
  const from = await (await ctx.get("/history?from=2026-09-15T00:01:00Z")).json();
  assert.equal(from.rows.length, 2);
  await ctx.close();
});

test("GET /history 的 limit 非法时回退到默认值", async () => {
  const ctx = await withServer({}, (store) => {
    store.insertQuotes([row("2026-09-15T00:00:00Z"), row("2026-09-15T00:01:00Z")]);
  });
  assert.equal((await (await ctx.get("/history?limit=abc")).json()).rows.length, 2);
  assert.equal((await (await ctx.get("/history?limit=-5")).json()).rows.length, 2);
  await ctx.close();
});

test("GET /stats 支持 1h / 24h / 7d，非法 window 返回 400", async () => {
  const ctx = await withServer({}, (store) => {
    store.insertQuotes([row(new Date().toISOString(), { amountIn: "1501.5" })]);
  });
  const oneHour = await (await ctx.get("/stats?window=1h")).json();
  assert.equal(oneHour.window, "1h");
  assert.equal(oneHour.pairs.length, 1);
  assert.equal(oneHour.pairs[0].n, 1);
  assert.equal((await (await ctx.get("/stats?window=24h")).json()).resolution, "raw");
  assert.equal((await (await ctx.get("/stats?window=7d")).json()).resolution, "hourly", "7d 走小时聚合以免拉百万行原始数据");
  assert.equal((await ctx.get("/stats?window=bogus")).status, 400);
  await ctx.close();
});

test("GET /alerts 支持 limit", async () => {
  const ctx = await withServer({}, (store) => {
    store.insertAlert({ ts: "2026-09-15T00:00:00Z", pairId: PAIR.id, kind: "error", detail: { a: 1 }, notified: true });
    store.insertAlert({ ts: "2026-09-15T00:01:00Z", pairId: PAIR.id, kind: "recover", detail: {}, notified: true });
  });
  assert.equal((await (await ctx.get("/alerts")).json()).alerts.length, 2);
  assert.equal((await (await ctx.get("/alerts?limit=1")).json()).alerts.length, 1);
  await ctx.close();
});

test("未知端点返回 404，非 GET 返回 405", async () => {
  const ctx = await withServer();
  assert.equal((await ctx.get("/nope")).status, 404);
  assert.equal((await ctx.get("/health", { method: "POST" })).status, 405);
  await ctx.close();
});

test("带尾斜杠的路径也能匹配", async () => {
  const ctx = await withServer();
  assert.equal((await ctx.get("/health/")).status, 200);
  assert.equal((await ctx.get("/")).status, 404);
  await ctx.close();
});

test("CORS 头存在，OPTIONS 预检返回 204", async () => {
  const ctx = await withServer({ cors: "https://panel.example.com" });
  const res = await ctx.get("/health");
  assert.equal(res.headers.get("access-control-allow-origin"), "https://panel.example.com");
  const preflight = await ctx.get("/health", { method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, OPTIONS");
  await ctx.close();
});

test("配了 bearerToken 时未授权返回 401，带对了返回 200", async () => {
  const ctx = await withServer({ bearerToken: "s3cret" });
  assert.equal((await ctx.get("/health")).status, 401);
  assert.equal((await ctx.get("/health", { headers: { Authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await ctx.get("/health", { headers: { Authorization: "Bearer s3cret" } })).status, 200);
  await ctx.close();
});

test("没配 bearerToken 时不校验", async () => {
  const ctx = await withServer({ bearerToken: "" });
  assert.equal((await ctx.get("/health")).status, 200);
  await ctx.close();
});
