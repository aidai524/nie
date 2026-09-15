import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/store.js";

const PAIR = {
  id: "near:USDC>eth:USDC", label: "near:USDC → eth:USDC", fromKey: "near:USDC", toKey: "eth:USDC",
  fromAsset: "a", toAsset: "b", swapType: "EXACT_OUTPUT", amount: "1500", amountMinor: "1500000000",
  fromDecimals: 6, toDecimals: 6,
};
const TIERS = [100, 1000, 10000, 100000, 1000000];

const row = (ts, tierUsd, overrides = {}) => ({
  ts, pairId: PAIR.id, tierUsd, ok: true, httpStatus: 201, latencyMs: 1300,
  amountMinor: String(tierUsd) + "000000", amountIn: "100410645", amountOut: "100000000",
  amountInUsd: "100.41", amountOutUsd: "100.00", minAmountOut: "100000000",
  timeEstimate: 27, correlationId: "cid",
  ...overrides,
});

function fresh() {
  const store = openStore(":memory:");
  store.upsertPairs([PAIR], "2026-09-15T00:00:00Z");
  return store;
}

test("depth_quotes 表存在，写入后能按 (pair, tier) 读回", () => {
  const store = fresh();
  store.insertDepthQuotes([row("2026-09-15T00:00:00.000Z", 100), row("2026-09-15T00:00:00.000Z", 1000)]);
  const sweep = store.getLatestSweep();
  assert.equal(sweep.ts, "2026-09-15T00:00:00.000Z");
  assert.deepEqual(sweep.rows.map((r) => r.tierUsd), [100, 1000], "tierUsd 是数字且按档位升序");
  assert.equal(sweep.rows[0].pairId, PAIR.id);
  assert.equal(sweep.rows[0].ok, true, "ok 读回来是布尔");
  assert.equal(sweep.rows[0].amountInUsd, "100.41", "金额保持字符串");
  store.close();
});

test("getLatestSweep 只返回最近一次扫描的行，不混入更早的", () => {
  const store = fresh();
  store.insertDepthQuotes([row("2026-09-15T00:00:00.000Z", 100), row("2026-09-15T00:00:00.000Z", 1000)]);
  store.insertDepthQuotes([row("2026-09-15T00:15:00.000Z", 100)]);
  const sweep = store.getLatestSweep();
  assert.equal(sweep.ts, "2026-09-15T00:15:00.000Z");
  assert.equal(sweep.rows.length, 1, "不能把上一轮的 1000 档也算进来");
  store.close();
});

test("getLatestSweep 在空表上返回 ts: null 而不是抛错或 undefined", () => {
  const store = fresh();
  assert.deepEqual(store.getLatestSweep(), { ts: null, rows: [] });
  store.close();
});

test("insertDepthQuotes 整批单事务：一行失败则全部回滚", () => {
  const store = fresh();
  assert.equal(store.insertDepthQuotes([row("2026-09-15T00:00:00.000Z", 100)]), 1);
  assert.equal(store.insertDepthQuotes([]), 0);
  assert.throws(
    () => store.insertDepthQuotes([row("2026-09-15T00:15:00.000Z", 100), { ts: "x", pairId: null, tierUsd: 1, ok: false }]),
    /NOT NULL|constraint/i,
  );
  assert.equal(store.getLatestSweep().rows.length, 1, "失败那批的第一行也应回滚");
  store.close();
});

test("insertDepthQuotes 把 errorMessage 截断到 500", () => {
  const store = fresh();
  store.insertDepthQuotes([row("2026-09-15T00:00:00.000Z", 1000000, {
    ok: false, errorCode: "http_4xx", errorMessage: "x".repeat(900),
  })]);
  const [entry] = store.getLatestSweep().rows;
  assert.equal(entry.errorMessage.length, 500);
  assert.equal(entry.ok, false);
  assert.equal(entry.errorCode, "http_4xx");
  store.close();
});

test("pruneDepth 只删 cutoff 之前的行", () => {
  const store = fresh();
  store.insertDepthQuotes([
    row("2026-09-01T00:00:00.000Z", 100),
    row("2026-09-14T00:00:00.000Z", 100),
    row("2026-09-15T00:00:00.000Z", 100),
  ]);
  // cutoff 落在两行之间：09-01 与 09-14T00:00 都早于它，所以删 2 行
  assert.equal(store.pruneDepth("2026-09-14T12:00:00.000Z"), 2);
  const sweep = store.getLatestSweep();
  assert.equal(sweep.ts, "2026-09-15T00:00:00.000Z", "最近的还在");
  assert.equal(sweep.rows.length, 1, "只剩 09-15 这一行");
  store.close();
});

test("深度数据与哨兵报价互不干扰", () => {
  const store = fresh();
  store.insertQuotes([{
    ts: "2026-09-15T00:00:00.000Z", pairId: PAIR.id, ok: true, httpStatus: 201, latencyMs: 1000,
    amountIn: "1501660000", amountOut: "1500000000", amountInUsd: "1501", amountOutUsd: "1500",
  }]);
  store.insertDepthQuotes([row("2026-09-15T00:00:05.000Z", 1000000, {
    ok: false, errorCode: "http_4xx", errorMessage: "No liquidity available",
  })]);
  assert.equal(store.getHistory({}).length, 1, "哨兵的 quotes 只有 1 条");
  assert.equal(store.getLatestPerPair()[0].ok, true, "/latest 用到的仍是最好的那条哨兵行，没被深度行污染");
  assert.equal(store.getLatestSweep().rows.length, 1, "深度表独立");
  store.close();
});
