import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, createWakeup, createLogger, loadPairs, runRound, runMaintenance, main } from "../src/index.js";
import { hourFloorIso, openStore } from "../src/store.js";
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

test("基准必须取自本轮写入之前，否则本次偏离会被自己抹平（回归）", async () => {
  const { ctx, store } = makeCtx({ fetchImpl: okFetch(100), now: T(0) });
  // minSamples 降到 1、阈值放到 80%：这样「基准含不含当前样本」会给出截然不同的结论。
  // 用默认的 minSamples=5 和 10% 是不行的 —— 样本池里多一条 200，中位数仍然是 100，两种顺序都判 deviant。
  ctx.config = { ...CONFIG, detect: { ...CONFIG.detect, minSamples: 1, priceDeviationPct: 80 } };
  await runRound(ctx);
  ctx.fetchImpl = okFetch(200);
  ctx.now = T(1);
  const summary = await runRound(ctx);
  // 正确顺序：基准 = median([100]) = 100，偏离 = +100% > 80% → deviant
  // 若先写入再读：基准 = median([100, 200]) = 150，偏离 = +33.3% < 80% → 不判
  assert.equal(summary.deviant, 2, "基准必须先于本轮写入读取");
  store.close();
});

const rawRow = (ts, overrides = {}) => ({
  ts, pairId: PAIR_A.id, ok: true, latencyMs: 1000, amountIn: "100", amountOut: "1500", ...overrides,
});

// 用本地时间构造 now，因为日汇总的 hourLocal 是本地小时
const localHour = (hour, minute = 0) => {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date;
};

const maintenanceCtx = (store, { now, digest, notifier }) => ({
  store,
  notifier: notifier ?? { send: async () => ({ ok: true }) },
  logger: QUIET,
  now,
  config: {
    ...CONFIG,
    slack: { enabled: true, mention: "", digest },
    retention: { rawDays: 14, hourlyDays: 0 },
  },
});

test("runMaintenance：整点未变时不聚合，但日汇总照常独立评估", async () => {
  const store = openStore(":memory:");
  store.upsertPairs([PAIR_A], "2026-09-15T00:00:00.000Z");
  store.insertQuotes([rawRow("2026-09-15T00:10:00.000Z")]);
  const now = localHour(9, 5);
  store.setMeta("rolled_up_to_hour", hourFloorIso(now));
  const sent = [];
  await runMaintenance(maintenanceCtx(store, {
    now,
    digest: { enabled: true, hourLocal: 9 },
    notifier: { send: async (text) => { sent.push(text); return { ok: true }; } },
  }));
  assert.equal(store.getHistory({ resolution: "hourly" }).length, 0, "整点没变就不该聚合");
  assert.equal(sent.length, 1, "日汇总不能被整点门控拦住");
  assert.ok(sent[0].includes("汇总"), "发的应该是汇总消息");
  assert.equal(store.getMeta("last_digest_ts"), now.toISOString());
  store.close();
});

test("runMaintenance：跨过整点时聚合并清理过期原始数据", async () => {
  const store = openStore(":memory:");
  store.upsertPairs([PAIR_A], "2026-09-15T00:00:00.000Z");
  store.insertQuotes([
    rawRow("2026-08-01T00:10:00.000Z"), // 超过 14 天，应被保留策略清掉
    rawRow("2026-09-15T00:10:00.000Z"), // 应被聚合成小时桶
  ]);
  const now = new Date("2026-09-15T01:05:00.000Z");
  store.setMeta("rolled_up_to_hour", "2026-09-15T00:00:00.000Z");
  const sent = [];
  await runMaintenance(maintenanceCtx(store, {
    now,
    digest: { enabled: false, hourLocal: 9 },
    notifier: { send: async (text) => { sent.push(text); return { ok: true }; } },
  }));
  assert.equal(store.getHistory({ resolution: "hourly" }).length, 1, "00 点这一小时应被聚合");
  assert.equal(store.getMeta("rolled_up_to_hour"), "2026-09-15T01:00:00.000Z");
  assert.deepEqual(store.getHistory({}).map((q) => q.ts), ["2026-09-15T00:10:00.000Z"], "8 月那条应被清掉");
  assert.deepEqual(sent, [], "日汇总关掉时不该发");
  store.close();
});

const TOKEN_PAYLOAD = {
  code: 200,
  data: [
    { network: "near", symbol: "USDC", decimals: 6, contract_address: "usdc.near", support_payment: true, support_receive: true },
    { network: "eth", symbol: "USDC", decimals: 6, contract_address: "0xA0b8", support_payment: true, support_receive: true },
  ],
};

// fetchImpl 按 URL 分发：两份 token 列表 + 报价端点
const mainFetch = (quoteImpl) => async (url, init) => {
  const target = String(url);
  if (target.includes("pay/tokens")) return { ok: true, status: 200, text: async () => JSON.stringify(TOKEN_PAYLOAD) };
  if (target.includes("1click")) return { ok: true, status: 200, text: async () => JSON.stringify([]) };
  return quoteImpl(url, init);
};

const writeConfig = (dir, overrides = {}) => {
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({
    intervalSec: 60,
    concurrency: 2,
    requestTimeoutMs: 5000,
    pairs: [{ from: "near:USDC", to: "eth:USDC" }],
    addresses: { near: "monitor.near", eth: "0xADDR" },
    slack: { enabled: false, webhookUrl: "", digest: { enabled: false } },
    server: { host: "127.0.0.1", port: 8787, cors: "*", bearerToken: "" },
    ...overrides,
  }));
  return configPath;
};

test("main --help 返回 0，且不读配置、不建库、不建目录", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ni-help-"));
  const dataPath = join(dir, "nested", "monitor.db");
  const originalWrite = process.stdout.write;
  let usage = "";
  process.stdout.write = (chunk) => { usage += chunk; return true; };
  let code;
  try {
    // 故意指向一个不存在的配置文件：--help 若真的去加载它就会抛 ConfigError
    code = await main(["--help", "--config", join(dir, "missing.json"), "--data", dataPath], { logger: QUIET });
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(code, 0);
  assert.ok(usage.includes("--config"), "应把用法打到 stdout");
  assert.equal(existsSync(join(dir, "nested")), false, "--help 不应建数据目录");
  rmSync(dir, { recursive: true, force: true });
});

test("main --once 跑一轮就退出，并把报价写进库", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ni-once-"));
  const configPath = writeConfig(dir);
  const dataPath = join(dir, "data", "monitor.db");
  const code = await main(["--once", "--config", configPath, "--data", dataPath], {
    logger: QUIET,
    fetchImpl: mainFetch(okFetch(100)),
  });
  assert.equal(code, 0);
  assert.equal(existsSync(dataPath), true, "应把库建在 --data 指定的路径下");
  const store = openStore(dataPath);
  assert.equal(store.getHistory({}).length, 1, "一轮应落一条报价");
  assert.equal(store.getPairStates().get("near:USDC>eth:USDC").status, "ok");
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("main 在一轮全部失败时不崩溃，仍以 0 退出并留下失败记录", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ni-fail-"));
  const configPath = writeConfig(dir);
  const dataPath = join(dir, "monitor.db");
  const code = await main(["--once", "--config", configPath, "--data", dataPath], {
    logger: QUIET,
    fetchImpl: mainFetch(failFetch),
  });
  assert.equal(code, 0, "一轮失败不应让进程以异常收场");
  const store = openStore(dataPath);
  const [quote] = store.getHistory({});
  assert.equal(quote.ok, false);
  assert.equal(quote.errorCode, "http_4xx");
  assert.equal(store.getPairStates().get("near:USDC>eth:USDC").status, "error");
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
