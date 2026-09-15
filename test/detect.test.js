import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, priceMetric, STATUS } from "../src/detect.js";

const DETECT = { priceDeviationPct: 10, minSamples: 5, realertMinutes: 30, rollingWindowMinutes: 60 };

const ok = (amountIn, extra = {}) => ({ ok: true, swapType: "EXACT_OUTPUT", amountIn: String(amountIn), amountOut: "1500", ...extra });
const failed = (extra = {}) => ({ ok: false, errorCode: "http_4xx", errorMessage: "tokenOut is not valid", httpStatus: 400, ...extra });
const historyOf = (...amounts) => amounts.map((a) => ok(a));
const stable = historyOf(100, 100, 100, 100, 100);

const run = (quote, { history = stable, prevStatus = STATUS.OK } = {}) =>
  evaluate({ quote, history, prevStatus, detect: DETECT });

test("priceMetric 按 swapType 取不同侧", () => {
  assert.equal(priceMetric({ ok: true, amountIn: "100", amountOut: "99" }, "EXACT_OUTPUT"), 100);
  assert.equal(priceMetric({ ok: true, amountIn: "100", amountOut: "99" }, "EXACT_INPUT"), 99);
});

test("priceMetric 对失败行与不可解析值返回 null", () => {
  assert.equal(priceMetric({ ok: false, amountIn: "100" }, "EXACT_OUTPUT"), null);
  assert.equal(priceMetric({ ok: true, amountIn: "abc" }, "EXACT_OUTPUT"), null);
  assert.equal(priceMetric({ ok: true }, "EXACT_OUTPUT"), null);
});

test("硬失败 → error，且首次为 isNew", () => {
  const out = run(failed(), { prevStatus: STATUS.OK });
  assert.equal(out.status, STATUS.ERROR);
  assert.equal(out.event.kind, "error");
  assert.equal(out.event.isNew, true);
  assert.equal(out.event.detail.errorCode, "http_4xx");
  assert.ok(out.event.detail.errorMessage.includes("tokenOut"));
  assert.equal(out.event.detail.httpStatus, 400);
});

test("持续失败时仍产出 event 但 isNew 为 false（由 notify 负责克制）", () => {
  const out = run(failed(), { prevStatus: STATUS.ERROR });
  assert.equal(out.status, STATUS.ERROR);
  assert.equal(out.event.kind, "error");
  assert.equal(out.event.isNew, false);
});

test("从没观测过（prevStatus 为 null）且失败时也算 isNew", () => {
  const out = run(failed(), { prevStatus: null });
  assert.equal(out.event.isNew, true);
});

test("样本不足时不判定偏离", () => {
  const out = run(ok(999), { history: historyOf(100, 100, 100, 100) });
  assert.equal(out.status, STATUS.OK);
  assert.equal(out.sampleCount, 4);
  assert.equal(out.deviationPct, null);
  assert.equal(out.event, null);
});

test("样本数刚好达到 minSamples 时开始判定", () => {
  const out = run(ok(200), { history: historyOf(100, 100, 100, 100, 100) });
  assert.equal(out.sampleCount, 5);
  assert.equal(out.status, STATUS.DEVIANT);
  assert.equal(out.deviationPct, 100);
});

test("无历史（冷启动）时恒为 ok", () => {
  const out = run(ok(12345), { history: [], prevStatus: null });
  assert.equal(out.status, STATUS.OK);
  assert.equal(out.event, null);
});

test("基准里忽略失败行", () => {
  const history = [ok(100), ok(100), ok(100), ok(100), failed(), failed()];
  const out = run(ok(105), { history });
  assert.equal(out.sampleCount, 4, "只有 4 条成功样本，不足 5 条");
  assert.equal(out.status, STATUS.OK);
  assert.equal(out.deviationPct, null);
});

test("偏离在阈值内不判异常", () => {
  const out = run(ok(109));
  assert.equal(out.status, STATUS.OK);
  assert.equal(out.deviationPct, 9);
  assert.equal(out.event, null);
});

test("偏离刚好等于阈值不判异常（严格大于才算）", () => {
  assert.equal(run(ok(110)).status, STATUS.OK);
  assert.equal(run(ok(110.01)).status, STATUS.DEVIANT);
});

test("变便宜（负向偏离）同样判异常", () => {
  const out = run(ok(50));
  assert.equal(out.status, STATUS.DEVIANT);
  assert.equal(out.deviationPct, -50);
  assert.equal(out.event.kind, "deviation");
  assert.equal(out.event.isNew, true);
});

test("偏离事件带上 metric / baseline / sampleCount", () => {
  const out = run(ok(200));
  assert.deepEqual(out.event.detail, { metric: 200, baseline: 100, deviationPct: 100, sampleCount: 5 });
});

test("EXACT_INPUT 币对用 amountOut 判定（回归）", () => {
  const history = [1, 2, 3, 4, 5].map((n) => ({ ok: true, swapType: "EXACT_INPUT", amountIn: "1000", amountOut: String(99 + n) }));
  // amountOut 基准中位数 102；当前 amountIn 恒定 1000、amountOut 1000 → 偏离 880%
  const out = evaluate({
    quote: { ok: true, swapType: "EXACT_INPUT", amountIn: "1000", amountOut: "1000" },
    history, prevStatus: STATUS.OK, detect: DETECT,
  });
  assert.equal(out.status, STATUS.DEVIANT);
  assert.equal(out.baseline, 102);
  assert.equal(out.metric, 1000);
});

test("从 error 恢复到 ok 产出 recover 事件", () => {
  const out = run(ok(100), { prevStatus: STATUS.ERROR });
  assert.equal(out.status, STATUS.OK);
  assert.equal(out.event.kind, "recover");
  assert.equal(out.event.isNew, true);
});

test("从 deviant 恢复到 ok 产出 recover 事件", () => {
  const out = run(ok(100), { prevStatus: STATUS.DEVIANT });
  assert.equal(out.event.kind, "recover");
});

test("一直 ok 时不产出事件", () => {
  assert.equal(run(ok(100), { prevStatus: STATUS.OK }).event, null);
});

test("从 error 直接变成 deviant 会产出 deviation 事件", () => {
  const out = run(ok(500), { prevStatus: STATUS.ERROR });
  assert.equal(out.status, STATUS.DEVIANT);
  assert.equal(out.event.kind, "deviation");
  assert.equal(out.event.isNew, true);
});

test("当前报价金额不可解析时状态为 ok 且不判定，但能从 error 恢复", () => {
  const out = run({ ok: true, swapType: "EXACT_OUTPUT", amountIn: "abc", amountOut: "1500" }, { prevStatus: STATUS.ERROR });
  assert.equal(out.metric, null);
  assert.equal(out.status, STATUS.OK);
  assert.equal(out.event.kind, "recover");
});

test("阈值可配：调大到 200 后同样的偏离不再报警", () => {
  const out = evaluate({ quote: ok(200), history: stable, prevStatus: STATUS.OK, detect: { ...DETECT, priceDeviationPct: 200 } });
  assert.equal(out.status, STATUS.OK);
  assert.equal(out.deviationPct, 100);
});

test("失败行缺少 errorCode 时给 unknown，不会崩", () => {
  const out = run({ ok: false }, { prevStatus: null });
  assert.equal(out.event.detail.errorCode, "unknown");
  assert.equal(out.event.detail.httpStatus, null);
});
