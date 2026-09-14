import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/store.js";

const PAIR_A = {
  id: "near:USDC>eth:USDC", label: "near:USDC → eth:USDC", fromKey: "near:USDC", toKey: "eth:USDC",
  fromAsset: "nep141:usdc.near", toAsset: "nep141:eth-usdc.omft.near", swapType: "EXACT_OUTPUT",
  amount: "1500", amountMinor: "1500000000", fromDecimals: 6, toDecimals: 6,
};
const PAIR_B = { ...PAIR_A, id: "near:USDC>sol:USDC", label: "near:USDC → sol:USDC", toKey: "sol:USDC", toAsset: "nep141:sol-usdc.omft.near" };

const row = (pairId, ts, overrides = {}) => ({
  ts, pairId, ok: true, httpStatus: 201, latencyMs: 1000,
  amountIn: "1501.5", amountOut: "1500", amountInUsd: "1501.4", amountOutUsd: "1500",
  minAmountIn: "1501.4", minAmountOut: "1500", timeEstimate: 27, correlationId: "cid",
  ...overrides,
});

function fresh() {
  const store = openStore(":memory:");
  store.upsertPairs([PAIR_A, PAIR_B], "2026-09-15T00:00:00Z");
  return store;
}

test("建表幂等：重复 openStore 同一文件不报错", () => {
  const store = openStore(":memory:");
  store.close();
});

test("upsertPairs 可反复调用，且把消失的币对置为 disabled 而不删历史", () => {
  const store = fresh();
  store.insertQuotes([row(PAIR_B.id, "2026-09-15T00:00:00Z")]);
  store.upsertPairs([PAIR_A], "2026-09-15T00:05:00Z");
  const pairs = store.getPairs();
  assert.equal(pairs.length, 2, "PAIR_B 的记录应保留");
  assert.equal(pairs.find((p) => p.id === PAIR_A.id).enabled, true);
  assert.equal(pairs.find((p) => p.id === PAIR_B.id).enabled, false);
  assert.equal(store.getHistory({ pairId: PAIR_B.id }).length, 1, "历史不该被删");
  store.close();
});

test("insertQuotes 写入并在失败时整体回滚", () => {
  const store = fresh();
  assert.equal(store.insertQuotes([row(PAIR_A.id, "2026-09-15T00:00:00Z")]), 1);
  assert.equal(store.insertQuotes([]), 0);
  // pair_id 为 undefined 会让 NOT NULL 约束失败
  assert.throws(() => store.insertQuotes([row(PAIR_A.id, "2026-09-15T00:01:00Z"), { ts: "x", pairId: null, ok: false }]), /NOT NULL|constraint/i);
  assert.equal(store.getHistory({ pairId: PAIR_A.id }).length, 1, "同一事务里的第一条也应回滚");
  store.close();
});

test("getRecentQuotes 倒序、按时间过滤、遵守 limit", () => {
  const store = fresh();
  store.insertQuotes([
    row(PAIR_A.id, "2026-09-15T00:00:00Z"),
    row(PAIR_A.id, "2026-09-15T00:01:00Z"),
    row(PAIR_A.id, "2026-09-15T00:02:00Z"),
  ]);
  const recent = store.getRecentQuotes(PAIR_A.id, "2026-09-15T00:00:00Z", 10);
  assert.deepEqual(recent.map((q) => q.ts), ["2026-09-15T00:02:00Z", "2026-09-15T00:01:00Z", "2026-09-15T00:00:00Z"]);
  assert.equal(store.getRecentQuotes(PAIR_A.id, "2026-09-15T00:01:00Z", 10).length, 2);
  assert.equal(store.getRecentQuotes(PAIR_A.id, "2026-09-15T00:00:00Z", 2).length, 2);
  assert.equal(store.getRecentQuotes("nope", "2026-09-15T00:00:00Z", 10).length, 0);
  store.close();
});

test("errorMessage 截断到 500 字符", () => {
  const store = fresh();
  store.insertQuotes([row(PAIR_A.id, "2026-09-15T00:00:00Z", { ok: false, errorCode: "http_4xx", errorMessage: "x".repeat(900) })]);
  assert.equal(store.getRecentQuotes(PAIR_A.id, "2026-09-15T00:00:00Z", 1)[0].errorMessage.length, 500);
  store.close();
});

test("pair_state 往返，且 ok 字段是布尔", () => {
  const store = fresh();
  assert.equal(store.getPairStates().size, 0);
  store.upsertPairState({
    pairId: PAIR_A.id, status: "error", statusSince: "2026-09-15T00:00:00Z",
    lastOkTs: "2026-09-14T23:59:00Z", lastAlertTs: "2026-09-15T00:00:00Z",
    consecutiveFailures: 2, lastMetric: 1501.5,
  });
  const state = store.getPairStates().get(PAIR_A.id);
  assert.equal(state.status, "error");
  assert.equal(state.consecutiveFailures, 2);
  assert.equal(state.lastMetric, 1501.5);
  store.upsertPairState({ ...state, status: "ok", consecutiveFailures: 0 });
  assert.equal(store.getPairStates().get(PAIR_A.id).status, "ok");
  store.close();
});

test("insertQuotes 写入的行读回来是布尔 ok", () => {
  const store = fresh();
  store.insertQuotes([row(PAIR_A.id, "2026-09-15T00:00:00Z"), row(PAIR_A.id, "2026-09-15T00:01:00Z", { ok: false })]);
  const [newest, oldest] = store.getRecentQuotes(PAIR_A.id, "2026-09-15T00:00:00Z", 10);
  assert.equal(newest.ok, false);
  assert.equal(oldest.ok, true);
  assert.equal(oldest.amountIn, "1501.5");
  store.close();
});

test("alerts 写入、过滤、标记已通知", () => {
  const store = fresh();
  const id = store.insertAlert({ ts: "2026-09-15T00:00:00Z", pairId: PAIR_A.id, kind: "error", detail: { errorCode: "http_4xx" }, notified: false });
  store.insertAlert({ ts: "2026-09-15T00:10:00Z", pairId: PAIR_B.id, kind: "recover", detail: {}, notified: true });
  assert.equal(store.getAlerts({}).length, 2);
  assert.equal(store.getAlerts({ since: "2026-09-15T00:05:00Z" }).length, 1);
  assert.equal(store.getAlerts({ limit: 1 }).length, 1);
  assert.equal(store.getAlerts({}).find((a) => a.id === id).notified, false);
  store.markAlertNotified(id, true);
  assert.equal(store.getAlerts({}).find((a) => a.id === id).notified, true);
  store.close();
});

test("getLatestPerPair 每对只返回最新一条并带上状态", () => {
  const store = fresh();
  store.insertQuotes([
    row(PAIR_A.id, "2026-09-15T00:00:00Z"),
    row(PAIR_B.id, "2026-09-15T00:00:30Z"),
    row(PAIR_A.id, "2026-09-15T00:01:00Z", { amountIn: "1600" }),
  ]);
  store.upsertPairState({ pairId: PAIR_A.id, status: "deviant", statusSince: "2026-09-15T00:01:00Z", lastOkTs: null, lastAlertTs: null, consecutiveFailures: 0, lastMetric: 1600 });
  const latest = store.getLatestPerPair();
  assert.equal(latest.length, 2);
  const a = latest.find((r) => r.pairId === PAIR_A.id);
  assert.equal(a.amountIn, "1600");
  assert.equal(a.stateStatus, "deviant");
  assert.equal(latest.find((r) => r.pairId === PAIR_B.id).stateStatus, null, "尚无状态的对应为 null");
  store.close();
});

test("getHistory 支持 pairId / 时间窗 / limit 组合", () => {
  const store = fresh();
  store.insertQuotes([
    row(PAIR_A.id, "2026-09-15T00:00:00Z"),
    row(PAIR_A.id, "2026-09-15T01:00:00Z"),
    row(PAIR_B.id, "2026-09-15T02:00:00Z"),
  ]);
  assert.equal(store.getHistory({}).length, 3, "无过滤条件时返回全部");
  assert.equal(store.getHistory({ pairId: PAIR_A.id }).length, 2);
  assert.equal(store.getHistory({ from: "2026-09-15T00:30:00Z" }).length, 2);
  assert.equal(store.getHistory({ to: "2026-09-15T01:30:00Z" }).length, 2);
  assert.equal(store.getHistory({ pairId: PAIR_A.id, from: "2026-09-15T00:30:00Z", limit: 1 }).length, 1);
  store.close();
});

test("meta JSON 往返，缺失时给 fallback", () => {
  const store = fresh();
  assert.equal(store.getMeta("missing"), undefined);
  assert.equal(store.getMeta("missing", 42), 42);
  store.setMeta("last_rollup_hour", "2026-09-15T00:00:00Z");
  store.setMeta("count", 7);
  assert.equal(store.getMeta("last_rollup_hour"), "2026-09-15T00:00:00Z");
  assert.equal(store.getMeta("count"), 7);
  store.setMeta("count", 8);
  assert.equal(store.getMeta("count"), 8, "重复 setMeta 应覆盖");
  store.close();
});

test("getStats（raw 分辨率）算成功率、价格中位数与 p95", () => {
  const store = fresh();
  const at = (m) => `2026-09-15T00:${String(m).padStart(2, "0")}:00Z`;
  store.insertQuotes([
    row(PAIR_A.id, at(0), { amountIn: "100", latencyMs: 1000 }),
    row(PAIR_A.id, at(1), { amountIn: "200", latencyMs: 2000 }),
    row(PAIR_A.id, at(2), { amountIn: "300", latencyMs: 3000 }),
    row(PAIR_A.id, at(3), { amountIn: "400", latencyMs: 4000 }),
    row(PAIR_A.id, at(4), { ok: false, errorCode: "http_4xx", errorMessage: "nope" }),
  ]);
  const stats = store.getStats({ sinceIso: "2026-09-15T00:00:00Z", resolution: "raw" });
  assert.equal(stats.resolution, "raw");
  const a = stats.pairs.find((p) => p.pairId === PAIR_A.id);
  assert.equal(a.n, 5);
  assert.equal(a.okN, 4);
  assert.equal(a.okRate, 0.8);
  assert.equal(a.metric.median, 250);
  assert.equal(a.metric.p95, 400);
  assert.equal(a.metric.min, 100);
  assert.equal(a.metric.max, 400);
  assert.equal(a.latency.median, 2500);
  assert.equal(a.latency.p95, 4000);
  store.close();
});

test("getStats 对 EXACT_INPUT 币对改用 amountOut 作为价格侧", () => {
  const store = openStore(":memory:");
  const pair = { ...PAIR_A, id: "near:USDC>sol:USDC", swapType: "EXACT_INPUT" };
  store.upsertPairs([pair], "2026-09-15T00:00:00Z");
  store.insertQuotes([
    row(pair.id, "2026-09-15T00:00:00Z", { amountIn: "100", amountOut: "999" }),
    row(pair.id, "2026-09-15T00:01:00Z", { amountIn: "100", amountOut: "1001" }),
  ]);
  const [stat] = store.getStats({ sinceIso: "2026-09-15T00:00:00Z", resolution: "raw" }).pairs;
  assert.equal(stat.metric.median, 1000, "应取 amountOut 而不是 amountIn");
  store.close();
});

test("getStats 只统计窗口内且 ok=1 的数据算中位数，但成功率算全部", () => {
  const store = fresh();
  store.insertQuotes([
    row(PAIR_A.id, "2026-09-14T23:00:00Z", { amountIn: "9999" }),
    row(PAIR_A.id, "2026-09-15T00:00:00Z", { amountIn: "100" }),
    row(PAIR_A.id, "2026-09-15T00:01:00Z", { amountIn: "200" }),
  ]);
  const [stat] = store.getStats({ sinceIso: "2026-09-15T00:00:00Z", resolution: "raw" }).pairs;
  assert.equal(stat.n, 2, "窗口外的行不计入成功率的分子分母");
  assert.equal(stat.metric.median, 150);
  store.close();
});
