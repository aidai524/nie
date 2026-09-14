import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore, hourFloorIso, hourBucketsBetween } from "../src/store.js";

const PAIR = {
  id: "near:USDC>eth:USDC", label: "a → b", fromKey: "near:USDC", toKey: "eth:USDC",
  fromAsset: "x", toAsset: "y", swapType: "EXACT_OUTPUT", amount: "1500",
  amountMinor: "1500000000", fromDecimals: 6, toDecimals: 6,
};
const row = (ts, overrides = {}) => ({
  ts, pairId: PAIR.id, ok: true, latencyMs: 1000, amountIn: "100", amountOut: "99",
  ...overrides,
});

function fresh() {
  const store = openStore(":memory:");
  store.upsertPairs([PAIR], "2026-09-15T00:00:00Z");
  return store;
}

test("hourFloorIso 向下取整到整点", () => {
  assert.equal(hourFloorIso(new Date("2026-09-15T13:45:31.500Z")), "2026-09-15T13:00:00.000Z");
  assert.equal(hourFloorIso(new Date("2026-09-15T00:00:00.000Z")), "2026-09-15T00:00:00.000Z");
});

test("hourBucketsBetween 左闭右开且能跨天", () => {
  assert.deepEqual(
    hourBucketsBetween("2026-09-15T00:00:00.000Z", "2026-09-15T03:00:00.000Z"),
    ["2026-09-15T00:00:00.000Z", "2026-09-15T01:00:00.000Z", "2026-09-15T02:00:00.000Z"],
  );
  assert.deepEqual(hourBucketsBetween("2026-09-15T00:00:00.000Z", "2026-09-15T00:00:00.000Z"), []);
  assert.equal(hourBucketsBetween("2026-09-14T23:00:00.000Z", "2026-09-15T02:00:00.000Z").length, 3);
});

test("rollupHour 聚合出计数、分位与均值", () => {
  const store = fresh();
  store.insertQuotes([
    row("2026-09-15T00:00:00.000Z", { amountIn: "100", latencyMs: 1000 }),
    row("2026-09-15T00:30:00.000Z", { amountIn: "300", latencyMs: 3000 }),
    row("2026-09-15T00:59:59.999Z", { ok: false, errorCode: "timeout", amountIn: null, latencyMs: 2000 }),
  ]);
  const result = store.rollupHour("2026-09-15T00:00:00.000Z");
  assert.deepEqual(result, { pairs: 1, rows: 1 });
  const [bucket] = store.getHistory({ resolution: "hourly" });
  assert.equal(bucket.n, 3);
  assert.equal(bucket.okN, 2);
  assert.equal(bucket.amountInAvg, 200);
  assert.equal(bucket.amountInMin, 100);
  assert.equal(bucket.amountInMax, 300);
  assert.equal(bucket.latencyAvgMs, 2000);
  store.close();
});

test("rollupHour 幂等：重复跑不会重复累加", () => {
  const store = fresh();
  store.insertQuotes([row("2026-09-15T00:00:00.000Z"), row("2026-09-15T00:30:00.000Z")]);
  store.rollupHour("2026-09-15T00:00:00.000Z");
  store.rollupHour("2026-09-15T00:00:00.000Z");
  const [bucket] = store.getHistory({ resolution: "hourly" });
  assert.equal(bucket.n, 2, "第二次应覆盖而不是变成 4");
  store.close();
});

test("没数据的小时不产生空行", () => {
  const store = fresh();
  assert.deepEqual(store.rollupHour("2026-09-15T05:00:00.000Z"), { pairs: 0, rows: 0 });
  assert.equal(store.getHistory({ resolution: "hourly" }).length, 0);
  store.close();
});

test("rollupHours 覆盖一个区间，且跳过无数据的桶", () => {
  const store = fresh();
  store.insertQuotes([row("2026-09-15T00:10:00.000Z"), row("2026-09-15T02:10:00.000Z")]);
  const result = store.rollupHours("2026-09-15T00:00:00.000Z", "2026-09-15T03:00:00.000Z");
  assert.equal(result.hours, 2, "00 点与 02 点各一个桶");
  assert.equal(result.rows, 2);
  assert.equal(store.getHistory({ resolution: "hourly" }).length, 2);
  store.close();
});

test("getStats 的 hourly 分支能读回小时聚合（raw 只覆盖到 24h，7d 靠这条路径）", () => {
  const store = fresh();
  store.insertQuotes([
    row("2026-09-15T00:00:00.000Z", { amountIn: "100", latencyMs: 1000 }),
    row("2026-09-15T00:30:00.000Z", { amountIn: "300", latencyMs: 3000 }),
  ]);
  store.rollupHour("2026-09-15T00:00:00.000Z");
  const stats = store.getStats({ sinceIso: "2026-09-15T00:00:00.000Z", resolution: "hourly" });
  assert.equal(stats.resolution, "hourly");
  const [entry] = stats.pairs;
  assert.equal(entry.pairId, PAIR.id);
  assert.equal(entry.n, 2);
  assert.equal(entry.okN, 2);
  assert.equal(entry.okRate, 1);
  assert.equal(entry.metric.mean, 200);
  assert.equal(entry.metric.min, 100);
  assert.equal(entry.metric.max, 300);
  assert.equal(entry.latency.mean, 2000);
  store.close();
});

test("getStats 的 hourly 分支的计数来自小时桶而不是原始表（长窗口在原始数据被清理后才不掉数）", () => {
  const store = fresh();
  store.insertQuotes([
    row("2026-09-15T00:10:00.000Z"), // 会被聚合进小时桶
    row("2026-09-15T01:10:00.000Z"), // 故意不聚合，只存在于原始表
  ]);
  store.rollupHour("2026-09-15T00:00:00.000Z");
  const stats = store.getStats({ sinceIso: "2026-09-15T00:00:00.000Z", resolution: "hourly" });
  const [entry] = stats.pairs;
  assert.equal(entry.n, 1, "只应统计已聚合进小时桶的那一条；从原始表取会得 2");
  assert.equal(entry.okN, 1);
  assert.equal(entry.okRate, 1);
  store.close();
});

test("pruneRaw 只删窗口之前的数据", () => {
  const store = fresh();
  store.insertQuotes([
    row("2026-09-01T00:00:00.000Z"),
    row("2026-09-14T00:00:00.000Z"),
    row("2026-09-15T00:00:00.000Z"),
  ]);
  // cutoff 取整点：ts < cutoff 的删掉，等于或晚于的留下
  assert.equal(store.pruneRaw("2026-09-14T00:00:00.000Z"), 1);
  assert.deepEqual(store.getHistory({}).map((q) => q.ts),
    ["2026-09-15T00:00:00.000Z", "2026-09-14T00:00:00.000Z"]);
  store.close();
});

test("pruneHourly 只删窗口之前的小时桶", () => {
  const store = fresh();
  store.insertQuotes([row("2026-09-10T00:00:00.000Z"), row("2026-09-15T00:00:00.000Z")]);
  store.rollupHours("2026-09-10T00:00:00.000Z", "2026-09-15T01:00:00.000Z");
  assert.equal(store.getHistory({ resolution: "hourly" }).length, 2);
  assert.equal(store.pruneHourly("2026-09-14T00:00:00.000Z"), 1);
  assert.equal(store.getHistory({ resolution: "hourly" }).length, 1);
  store.close();
});
