import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTier, largestPassingTier, buildDepthIndex, buildRows, depthCell, depthCurveFor } from "../public/dashboard.js";

test("formatTier 覆盖 1M / 2.5M / 100k / 1.5k / 100", () => {
  assert.equal(formatTier(1000000), "1M");
  assert.equal(formatTier(2500000), "2.5M");
  assert.equal(formatTier(100000), "100k");
  assert.equal(formatTier(10000), "10k");
  assert.equal(formatTier(1000), "1k");
  assert.equal(formatTier(1500), "1.5k");
  assert.equal(formatTier(100), "100");
});

test("formatTier 对坏输入给破折号而不是 NaN", () => {
  assert.equal(formatTier(null), "—");
  assert.equal(formatTier(undefined), "—");
  assert.equal(formatTier("abc"), "—");
  assert.equal(formatTier(0), "—");
  assert.equal(formatTier(-100), "—");
});

test("formatTier 不把 1M 显示成 1.0M", () => {
  assert.equal(formatTier(1000000), "1M");
  assert.ok(!formatTier(1000000).includes(".0"));
});

const depthRow = (tierUsd, ok, extra = {}) => ({
  pairId: "near:USDC>eth:USDC", tierUsd, ok, amountInUsd: "100.41", amountOutUsd: "100.00",
  errorCode: ok ? null : "http_4xx", errorMessage: ok ? null : "No liquidity available", ...extra,
});

test("largestPassingTier 挑出能通过的最大档位，与输入顺序无关", () => {
  assert.equal(largestPassingTier([depthRow(100, true), depthRow(1000, true), depthRow(10000, false)]), 1000);
  assert.equal(largestPassingTier([depthRow(10000, false), depthRow(100, true), depthRow(1000, true)]), 1000);
  assert.equal(largestPassingTier([depthRow(1000000, true), depthRow(100, true)]), 1000000);
});

test("largestPassingTier 在全不通或空输入时给 null", () => {
  assert.equal(largestPassingTier([depthRow(1000, false), depthRow(100, false)]), null);
  assert.equal(largestPassingTier([]), null);
  assert.equal(largestPassingTier([depthRow(100, true), null, { pairId: "x" }]), 100, "坏行要跳过而不是崩");
});

test("buildDepthIndex 按币对归并，并给出每对的详情", () => {
  const index = buildDepthIndex([
    depthRow(100, true), depthRow(1000, false),
    { ...depthRow(100, true), pairId: "near:USDC>sol:USDC" },
    { ...depthRow(10000, true), pairId: "near:USDC>sol:USDC" },
  ]);
  assert.equal(index.size, 2);
  const eth = index.get("near:USDC>eth:USDC");
  assert.equal(eth.maxTierUsd, 100);
  assert.equal(eth.byTier.get(1000).errorMessage, "No liquidity available");
  assert.equal(index.get("near:USDC>sol:USDC").maxTierUsd, 10000);
});

test("buildDepthIndex 对空输入与坏行不崩", () => {
  assert.equal(buildDepthIndex([]).size, 0);
  assert.equal(buildDepthIndex([null, { noPairId: 1 }]).size, 0);
});

const PAIR_A = {
  id: "near:USDC>eth:USDC", label: "near:USDC → eth:USDC", fromKey: "near:USDC", toKey: "eth:USDC",
  fromDecimals: 6, toDecimals: 6, swapType: "EXACT_OUTPUT", amount: "1500",
};
const quote = (pairId, overrides = {}) => ({
  pairId, ts: "2026-09-15T06:00:00.000Z", ok: true, httpStatus: 201, latencyMs: 2290,
  amountIn: "1501955004", amountOut: "1500000000", amountInUsd: "1501.73", amountOutUsd: "1499.78",
  minAmountIn: "1500453048", minAmountOut: "1500000000", timeEstimate: 27, correlationId: "cid",
  errorCode: null, errorMessage: null, stateStatus: "ok", stateSince: "2026-09-15T06:00:00.000Z", stateFailures: 0,
  ...overrides,
});
const NOW = "2026-09-15T06:00:30.000Z";


const sweepDepth = (rows, overrides = {}) => ({
  enabled: true, ts: "2026-09-15T00:30:00.000Z", tiers: [100, 1000, 10000], rows, ...overrides,
});

test("depthCell：有数据时给最大可通档位（按参考 UI 渲染成美元额）", () => {
  const rows = [depthRow(100, true), depthRow(1000, true), depthRow(10000, false)];
  const depth = sweepDepth(rows);
  const index = buildDepthIndex(rows);
  const cell = depthCell({ pairId: "near:USDC>eth:USDC", depth, index });
  assert.equal(cell.text, "$1k", "参考 UI 的「可按」显示美元额，所以带 $ 前缀；值本身仍是真实档位");
  assert.ok(cell.title.includes("最大金额档位"));
});

test("depthCell：全档不通给破折号，没扫过给问号，关闭给破折号", () => {
  const dead = [depthRow(100, false), depthRow(1000, false)];
  const deadDepth = sweepDepth(dead);
  assert.equal(depthCell({ pairId: "near:USDC>eth:USDC", depth: deadDepth, index: buildDepthIndex(dead) }).text, "—");

  const notYet = sweepDepth([], { ts: null });
  const cell = depthCell({ pairId: "near:USDC>eth:USDC", depth: notYet, index: new Map() });
  assert.equal(cell.text, "?");
  assert.ok(cell.title.includes("还没有扫描过"));

  const off = sweepDepth([], { enabled: false });
  const offCell = depthCell({ pairId: "near:USDC>eth:USDC", depth: off, index: new Map() });
  assert.equal(offCell.text, "—");
  assert.ok(offCell.title.includes("关闭"));
});

test("depthCell：接口没取到时（depth 为 null）给问号，不崩", () => {
  assert.equal(depthCell({ pairId: "x", depth: null, index: new Map() }).text, "?");
  assert.equal(depthCell({ pairId: "x", depth: undefined, index: undefined }).text, "?");
});

test("depthCell：该对本次没被扫描时给问号，而不是声称「都做不了」", () => {
  // 扫描跑过了（ts 非 null），但 rows 里没有这一对 —— 它因为一小时内没有成功报价而无法折算金额。
  // 显示「—」会读成「所有档位都做不了」，那是谎报；实际是「本次没测它」。
  const rows = [depthRow(100, true, { pairId: "other:PAIR" })];
  const depth = sweepDepth(rows);
  const cell = depthCell({ pairId: "near:USDC>eth:USDC", depth, index: buildDepthIndex(rows) });
  assert.equal(cell.text, "?");
  assert.ok(cell.title.includes("没有被扫描"), `tooltip 应说明未被扫描，实际: ${cell.title}`);
});

test("depthCell：真的所有档位都不通时才是破折号", () => {
  const rows = [depthRow(100, false), depthRow(1000, false)];
  const depth = sweepDepth(rows);
  const cell = depthCell({ pairId: "near:USDC>eth:USDC", depth, index: buildDepthIndex(rows) });
  assert.equal(cell.text, "—");
  assert.ok(cell.title.includes("所有档位都没有报价"));
});

test("depthCurveFor 按档位升序给出曲线，含成本与对方原文", () => {
  const rows = [
    depthRow(1000, false, { amountInUsd: null, amountOutUsd: null }),
    depthRow(100, true, { amountInUsd: "100.41", amountOutUsd: "100.00" }),
  ];
  const depth = sweepDepth(rows);
  const curve = depthCurveFor({ pairId: "near:USDC>eth:USDC", depth, index: buildDepthIndex(rows) });
  assert.deepEqual(curve.map((point) => point.tierText), ["$100", "$1k"], "必须按档位升序，不是输入顺序");
  assert.equal(curve[0].ok, true);
  assert.equal(curve[0].costText, "0.41%");
  assert.equal(curve[1].ok, false);
  assert.equal(curve[1].costText, "—", "不通的档位没有成本可言");
  assert.equal(curve[1].note, "No liquidity available");
  // 详情里整行显示用的拼好文本也在纯函数区生成（渲染层只 join），所以它有测试
  assert.equal(curve[0].text, "$100 · 可通 · 0.41%");
  assert.equal(curve[1].text, "$1k · 不通 · No liquidity available");
});

test("depthCurveFor 在没有数据时给空数组", () => {
  assert.deepEqual(depthCurveFor({ pairId: "x", depth: null, index: new Map() }), []);
  assert.deepEqual(depthCurveFor({ pairId: "x", depth: sweepDepth([], { ts: null }), index: new Map() }), []);
});

test("buildRows 带上 depth 时给出可按列与曲线", () => {
  const rows = [depthRow(100, true), depthRow(1000, false)];
  const built = buildRows({
    pairs: [PAIR_A], latest: [quote(PAIR_A.id)], stats: [], depth: sweepDepth(rows), nowIso: NOW,
  });
  assert.equal(built[0].depthText, "$100");
  assert.equal(built[0].depthCurve.length, 2);
});

test("buildRows 不带 depth 时行为与加这个功能之前一致（既有用例不受影响）", () => {
  const built = buildRows({ pairs: [PAIR_A], latest: [quote(PAIR_A.id)], stats: [], nowIso: NOW });
  assert.equal(built[0].depthText, "?");
  assert.deepEqual(built[0].depthCurve, []);
});
