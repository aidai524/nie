import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, createWakeup, createLogger, loadPairs, runRound } from "../src/index.js";
import { openStore } from "../src/store.js";
import { ConfigError } from "../src/config.js";

const PAIR_A = {
  id: "near:USDC>eth:USDC", label: "near:USDC → eth:USDC", fromKey: "near:USDC", toKey: "eth:USDC",
  fromAsset: "nep141:usdc.near", toAsset: "nep141:eth-usdc.omft.near",
  swapType: "EXACT_OUTPUT", amount: "1500", amountMinor: "1500000000",
  fromDecimals: 6, toDecimals: 6, slippageTolerance: 10, confidentiality: "advanced", deadlineMs: 600000,
  refundTo: "monitor.near", recipient: "0xADDR",
};
const PAIR_B = { ...PAIR_A, id: "near:USDC>sol:USDC", label: "near:USDC → sol:USDC", toKey: "sol:USDC", recipient: "soladdr" };

const CONFIG = {
  intervalSec: 60, concurrency: 5, requestTimeoutMs: 15000,
  quoteEndpoint: "https://q/v0/quote",
  tokensSources: { stableflow: "https://sf/pay/tokens", oneclick: "https://oc/v0/tokens" },
  defaults: { swapType: "EXACT_OUTPUT", slippageTolerance: 10, confidentiality: "advanced", deadlineMs: 600000 },
  defaultAmounts: { USDC: "1500" },
  addresses: { near: "monitor.near", eth: "0xADDR", sol: "soladdr" },
  pairs: [{ from: "near:USDC", to: "eth:USDC" }, { from: "near:USDC", to: "sol:USDC" }],
  detect: { priceDeviationPct: 10, minSamples: 5, realertMinutes: 30, rollingWindowMinutes: 60 },
  slack: { enabled: true, mention: "", digest: { enabled: false, hourLocal: 9 } },
  retention: { rawDays: 14, hourlyDays: 0 },
  server: { host: "127.0.0.1", port: 0, cors: "*", bearerToken: "" },
};

const QUIET = { info: () => {}, warn: () => {}, error: () => {} };
const T = (minutes) => new Date(Date.parse("2026-09-15T00:00:00.000Z") + minutes * 60000);

test("parseArgs 默认值", () => {
  assert.deepEqual(parseArgs([]), { once: false, notify: true, configPath: "config.json", dataPath: "data/monitor.db", help: false });
});

test("parseArgs 解析各个开关", () => {
  assert.deepEqual(parseArgs(["--once", "--no-notify", "--config", "a.json", "--data", "b.db"]), {
    once: true, notify: false, configPath: "a.json", dataPath: "b.db", help: false,
  });
  assert.equal(parseArgs(["--config=a.json"]).configPath, "a.json");
  assert.equal(parseArgs(["-h"]).help, true);
});

test("parseArgs 对未知参数报错", () => {
  assert.throws(() => parseArgs(["--wat"]), (e) => e instanceof ConfigError && e.message.includes("--wat"));
});

test("createWakeup 到点自行唤醒", async () => {
  const wakeup = createWakeup();
  const startedAt = Date.now();
  await wakeup.wait(20);
  assert.ok(Date.now() - startedAt >= 15);
});

test("createWakeup 被 interrupt 时立即唤醒（Ctrl-C 不用等满一分钟）", async () => {
  const wakeup = createWakeup();
  const startedAt = Date.now();
  setTimeout(() => wakeup.interrupt(), 5);
  await wakeup.wait(60000);
  assert.ok(Date.now() - startedAt < 1000);
});

test("createWakeup 的 wait(0) 立即返回", async () => {
  await createWakeup().wait(0);
});

test("createLogger 带上时间戳与级别", () => {
  const lines = [];
  const logger = createLogger({ log: (line) => lines.push(line) });
  logger.warn("attention");
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("[WARN]"));
  assert.ok(lines[0].includes("attention"));
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(lines[0]));
});

test("loadPairs 从两个 token 列表构造出币对", async () => {
  const stableflow = { code: 200, data: [
    { network: "near", symbol: "USDC", decimals: 6, contract_address: "usdc.near", support_payment: true, support_receive: true },
    { network: "eth", symbol: "USDC", decimals: 6, contract_address: "0xA0b8", support_payment: true, support_receive: true },
    { network: "sol", symbol: "USDC", decimals: 6, contract_address: "So1", support_payment: true, support_receive: true },
  ] };
  const oneclick = [{ blockchain: "near", contractAddress: "usdc.near", assetId: "nep141:usdc.near" }];
  const fetchImpl = async (url) => (String(url).includes("pay/tokens")
    ? { ok: true, status: 200, text: async () => JSON.stringify(stableflow) }
    : { ok: true, status: 200, text: async () => JSON.stringify(oneclick) });
  const pairs = await loadPairs({ config: CONFIG, fetchImpl, logger: QUIET });
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].id, "near:USDC>eth:USDC");
  assert.equal(pairs[0].amountMinor, "1500000000");
  assert.equal(pairs[1].id, "near:USDC>sol:USDC");
});

test("loadPairs 在 oneclick 挂掉时降级而不是失败", async () => {
  const stableflow = { code: 200, data: [
    { network: "near", symbol: "USDC", decimals: 6, contract_address: "usdc.near", support_payment: true, support_receive: true },
    { network: "eth", symbol: "USDC", decimals: 6, contract_address: "0xA0b8", support_payment: true, support_receive: true },
    { network: "sol", symbol: "USDC", decimals: 6, contract_address: "So1", support_payment: true, support_receive: true },
  ] };
  const warnings = [];
  const fetchImpl = async (url) => {
    if (String(url).includes("pay/tokens")) return { ok: true, status: 200, text: async () => JSON.stringify(stableflow) };
    throw new TypeError("oc down");
  };
  const pairs = await loadPairs({ config: CONFIG, fetchImpl, logger: { ...QUIET, warn: (m) => warnings.push(m) } });
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].fromAsset, "nep141:usdc.near", "应回退到本地拼接");
  assert.equal(warnings.length, 1);
});

test("loadPairs 在 StableFlow 列表格式异常时抛配置错误", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 500, message: "boom" }) });
  await assert.rejects(loadPairs({ config: CONFIG, fetchImpl, logger: QUIET }), ConfigError);
});

function makeCtx({ fetchImpl, now, store = openStore(":memory:"), notifier } = {}) {
  const pairs = [PAIR_A, PAIR_B];
  store.upsertPairs(pairs, "2026-09-15T00:00:00.000Z");
  const sent = [];
  return {
    sent,
    store,
    ctx: {
      config: CONFIG, pairs, store, logger: QUIET, fetchImpl, now,
      notifier: notifier ?? { send: async (text) => { sent.push(text); return { ok: true }; } },
      metrics: {},
    },
  };
}

const okFetch = (amountIn) => async (_url, init) => ({
  ok: true, status: 201,
  text: async () => JSON.stringify({
    correlationId: "cid",
    quote: {
      amountIn: String(amountIn), amountInFormatted: "x", amountInUsd: "1",
      amountOut: JSON.parse(init.body).amount, amountOutFormatted: "y", amountOutUsd: "1",
      minAmountIn: String(amountIn), minAmountOut: JSON.parse(init.body).amount, timeEstimate: 10,
    },
  }),
});
const failFetch = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ message: "tokenOut is not valid" }) });

test("runRound 成功时写入两行、状态为 ok、不发告警", async () => {
  const { ctx, store, sent } = makeCtx({ fetchImpl: okFetch(100), now: T(0) });
  const summary = await runRound(ctx);
  assert.equal(summary.ok, 2);
  assert.equal(summary.error, 0);
  assert.equal(summary.alertsSent, 0);
  assert.equal(store.getHistory({}).length, 2);
  assert.equal(store.getPairStates().get(PAIR_A.id).status, "ok");
  assert.equal(store.getPairStates().get(PAIR_A.id).lastOkTs, T(0).toISOString());
  assert.deepEqual(sent, []);
  store.close();
});

test("runRound 失败时写 error 状态、落 alerts 并发一条 Slack", async () => {
  const { ctx, store, sent } = makeCtx({ fetchImpl: failFetch, now: T(0) });
  const summary = await runRound(ctx);
  assert.equal(summary.error, 2);
  assert.equal(summary.alertsSent, 2);
  assert.equal(sent.length, 2);
  assert.ok(sent[0].includes("报价失败"));
  const state = store.getPairStates().get(PAIR_A.id);
  assert.equal(state.status, "error");
  assert.equal(state.consecutiveFailures, 1);
  assert.equal(state.lastAlertTs, T(0).toISOString());
  assert.equal(store.getAlerts({}).length, 2);
  store.close();
});

test("runRound 连续失败时第二轮被抑制，alerts 仍然落库", async () => {
  const { ctx, store, sent } = makeCtx({ fetchImpl: failFetch, now: T(0) });
  await runRound(ctx);
  ctx.now = T(1);
  const second = await runRound(ctx);
  assert.equal(second.alertsSent, 0, "T(0) → T(1) 只过了一分钟，仍在 realertMinutes 内");
  assert.equal(sent.length, 2, "只有第一轮发了");
  assert.equal(store.getAlerts({}).length, 4, "两轮各落两条事件，只是没推");
  assert.equal(store.getPairStates().get(PAIR_A.id).consecutiveFailures, 2);
  store.close();
});

test("runRound 超过 realertMinutes 后重新提醒", async () => {
  const { ctx, store, sent } = makeCtx({ fetchImpl: failFetch, now: T(0) });
  await runRound(ctx);
  ctx.now = T(31);
  const second = await runRound(ctx);
  assert.equal(second.alertsSent, 2);
  assert.equal(sent.length, 4);
  store.close();
});

test("runRound 从 error 恢复时发 recover 并清零连续失败", async () => {
  const { ctx, store, sent } = makeCtx({ fetchImpl: failFetch, now: T(0) });
  await runRound(ctx);
  ctx.fetchImpl = okFetch(100);
  ctx.now = T(1);
  await runRound(ctx);
  assert.equal(sent.length, 4, "2 条 error + 2 条 recover");
  assert.ok(sent[2].includes("已恢复"));
  const state = store.getPairStates().get(PAIR_A.id);
  assert.equal(state.status, "ok");
  assert.equal(state.consecutiveFailures, 0);
  store.close();
});

test("runRound 用写入前的历史做基准，所以第六轮才开始判偏离", async () => {
  const { ctx, store, sent } = makeCtx({ fetchImpl: okFetch(100), now: T(0) });
  for (let round = 0; round < 5; round += 1) {
    ctx.fetchImpl = okFetch(100);
    ctx.now = T(round);
    const summary = await runRound(ctx);
    assert.equal(summary.deviant, 0, `第 ${round + 1} 轮样本不足，不应判偏离`);
  }
  // 此时库里已有 5 条历史；下一轮给出 200 的 amountIn，基准中位数 100 → 偏离 100%
  ctx.fetchImpl = okFetch(200);
  ctx.now = T(5);
  const summary = await runRound(ctx);
  assert.equal(summary.deviant, 2);
  assert.equal(sent.length, 2);
  assert.ok(sent[0].includes("报价偏离"));
  assert.equal(store.getPairStates().get(PAIR_A.id).status, "deviant");
  assert.equal(store.getPairStates().get(PAIR_A.id).lastMetric, 200);
  store.close();
});

test("runRound 把请求体发到配置的端点，并带上 dry", async () => {
  const seen = [];
  const { ctx, store } = makeCtx({
    now: T(0),
    fetchImpl: async (url, init) => { seen.push({ url, body: JSON.parse(init.body) }); return okFetch(100)(url, init); },
  });
  await runRound(ctx);
  assert.equal(seen.length, 2);
  assert.equal(new Set(seen.map((s) => s.url)).size, 1);
  assert.equal(seen[0].url, CONFIG.quoteEndpoint);
  assert.ok(seen.every((s) => s.body.dry === true), "每一条都必须带 dry，否则代理返回 400");
  assert.ok(seen.every((s) => s.body.amount === "1500000000"));
  store.close();
});

test("runRound 在 Slack 发送失败时不把它算作已告警", async () => {
  const failing = { send: async () => ({ ok: false, error: "boom" }) };
  const { ctx, store } = makeCtx({ fetchImpl: failFetch, now: T(0), notifier: failing });
  const summary = await runRound(ctx);
  assert.equal(summary.alertsSent, 0);
  assert.equal(store.getPairStates().get(PAIR_A.id).lastAlertTs, null, "发送失败则不应记录提醒时间，下一轮重试");
  assert.equal(store.getAlerts({}).every((alert) => alert.notified === false), true);
  store.close();
});

test("runRound 更新 metrics 供 /health 读取", async () => {
  const { ctx, store } = makeCtx({ fetchImpl: okFetch(100), now: T(0) });
  await runRound(ctx);
  assert.equal(ctx.metrics.lastRoundTs, T(0).toISOString());
  assert.equal(typeof ctx.metrics.lastRoundDurationMs, "number");
  store.close();
});
