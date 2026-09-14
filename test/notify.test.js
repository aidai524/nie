import { test } from "node:test";
import assert from "node:assert/strict";
import { decideEventAction, decideDigestAction, formatEvent, formatDigest, createNotifier } from "../src/notify.js";

const PAIR = { id: "near:USDC>eth:USDC", label: "near:USDC → eth:USDC", swapType: "EXACT_OUTPUT" };
const EVENT = { kind: "error", isNew: true, detail: { errorCode: "limits", errorMessage: "minimum swap amount is $1,000", httpStatus: 400 } };
const DEVIATION = { kind: "deviation", isNew: true, detail: { metric: 200, baseline: 100, deviationPct: 100, sampleCount: 5 } };

// 用本地时间构造时间戳，使断言不依赖 TZ
const LOCAL = (hour, minutes = 0, dayOffset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minutes, 0, 0);
  return d.toISOString();
};

test("边沿：状态迁移必发", () => {
  assert.equal(decideEventAction({ event: EVENT, lastAlertTs: LOCAL(0), nowIso: LOCAL(0, 1), realertMinutes: 30 }), "send");
});

test("边沿：持续异常在 realertMinutes 内被抑制", () => {
  const event = { ...EVENT, isNew: false };
  assert.equal(decideEventAction({ event, lastAlertTs: LOCAL(0, 0), nowIso: LOCAL(0, 10), realertMinutes: 30 }), "suppress");
});

test("边沿：超过 realertMinutes 后重新提醒", () => {
  const event = { ...EVENT, isNew: false };
  assert.equal(decideEventAction({ event, lastAlertTs: LOCAL(0, 0), nowIso: LOCAL(0, 30), realertMinutes: 30 }), "send");
  assert.equal(decideEventAction({ event, lastAlertTs: LOCAL(0, 0), nowIso: LOCAL(0, 29), realertMinutes: 30 }), "suppress");
});

test("边沿：持续异常但从未告警过时直接发", () => {
  assert.equal(decideEventAction({ event: { ...EVENT, isNew: false }, lastAlertTs: null, nowIso: LOCAL(0), realertMinutes: 30 }), "send");
});

test("边沿：恢复必发，不受 realertMinutes 抑制", () => {
  const recover = { kind: "recover", isNew: true, detail: {} };
  assert.equal(decideEventAction({ event: recover, lastAlertTs: LOCAL(0, 0), nowIso: LOCAL(0, 1), realertMinutes: 30 }), "send");
});

test("没有事件时不做任何事", () => {
  assert.equal(decideEventAction({ event: null, lastAlertTs: null, nowIso: LOCAL(0), realertMinutes: 30 }), "none");
});

test("日汇总：关掉时永不发", () => {
  assert.equal(decideDigestAction({ enabled: false, lastDigestTs: null, nowIso: LOCAL(9), hourLocal: 9 }), false);
});

test("日汇总：只在配置的那个本地小时发", () => {
  assert.equal(decideDigestAction({ enabled: true, lastDigestTs: null, nowIso: LOCAL(9), hourLocal: 9 }), true);
  assert.equal(decideDigestAction({ enabled: true, lastDigestTs: null, nowIso: LOCAL(10), hourLocal: 9 }), false);
});

test("日汇总：同一小时内只发一次，且不会漏掉第二天", () => {
  // 主用途：采集循环每分钟跑一次，若不在窗口内拦截，hourLocal 这一小时内会连发 60 条
  assert.equal(decideDigestAction({ enabled: true, lastDigestTs: LOCAL(9, 0), nowIso: LOCAL(9, 5), hourLocal: 9 }), false);
  assert.equal(decideDigestAction({ enabled: true, lastDigestTs: LOCAL(9, 0), nowIso: LOCAL(9, 59), hourLocal: 9 }), false);
  // 关键的另一侧：20 小时窗口必须短于一天，否则第二天的汇总会被永久拦住（spec §6 要求不漏推）
  assert.equal(decideDigestAction({ enabled: true, lastDigestTs: LOCAL(9, 0, -1), nowIso: LOCAL(9, 5), hourLocal: 9 }), true);
  assert.equal(decideDigestAction({ enabled: true, lastDigestTs: LOCAL(9, 0, -2), nowIso: LOCAL(9, 5), hourLocal: 9 }), true);
});

test("错误消息包含图标、币对、错误码与原文", () => {
  const text = formatEvent(EVENT, PAIR, { consecutiveFailures: 3, lastOkTs: "2026-09-14T23:59:00.000Z" });
  assert.ok(text.includes(":red_circle:"));
  assert.ok(text.includes("near:USDC → eth:USDC"));
  assert.ok(text.includes("limits"));
  assert.ok(text.includes("minimum swap amount is $1,000"));
  assert.ok(text.includes("连续失败 3 次"));
});

test("偏离消息带上 metric 名称、基准、百分比与样本数", () => {
  const text = formatEvent(DEVIATION, PAIR);
  assert.ok(text.includes(":large_yellow_circle:"));
  assert.ok(text.includes("amountIn"));
  assert.ok(text.includes("+100.00%"));
  assert.ok(text.includes("样本 5"));
});

test("EXACT_INPUT 币对的偏离消息说 amountOut", () => {
  const text = formatEvent(DEVIATION, { ...PAIR, swapType: "EXACT_INPUT" });
  assert.ok(text.includes("amountOut"));
  assert.ok(!text.includes("amountIn"));
});

test("恢复消息带上异常持续时长", () => {
  const text = formatEvent({ kind: "recover", isNew: true, detail: {} }, PAIR, { statusSince: "2026-09-15T00:00:00.000Z" });
  assert.ok(text.includes(":large_green_circle:"));
  assert.ok(text.includes("已恢复"));
});

test("mention 被加到消息开头", () => {
  const text = formatEvent(EVENT, PAIR, { mention: "<!channel>" });
  assert.ok(text.startsWith("<!channel> "));
});

test("日汇总消息带上成功率与最差币对", () => {
  const text = formatDigest({
    windowHours: 24, pairCount: 38, totalRounds: 54720, okRounds: 54300, okRate: 0.9923,
    worst: [{ pairId: "a>b", label: "near:USDC → bsc:USDC", failures: 1440 }],
    latencyP95: 2100,
  });
  assert.ok(text.includes("99.2%"));
  assert.ok(text.includes("near:USDC → bsc:USDC"));
  assert.ok(text.includes("1440"));
  assert.ok(text.includes("2100"));
});

test("日汇总在成功率为 null 时不崩", () => {
  const text = formatDigest({ windowHours: 24, pairCount: 0, totalRounds: 0, okRounds: 0, okRate: null, worst: [], latencyP95: null });
  assert.ok(text.includes("0 对"));
});

test("notifier 禁用时不发请求，但把消息写进日志", async () => {
  const logged = [];
  let called = false;
  const notifier = createNotifier({
    enabled: false, webhookUrl: "https://hooks.slack.com/x",
    fetchImpl: async () => { called = true; },
    logger: { info: (m) => logged.push(m), warn: () => {}, error: () => {} },
  });
  const result = await notifier.send("hello");
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(called, false);
  assert.ok(logged.some((line) => line.includes("hello")));
});

test("notifier 把 { text } POST 到 webhook", async () => {
  let seen;
  const notifier = createNotifier({
    enabled: true, webhookUrl: "https://hooks.slack.com/x",
    fetchImpl: async (url, init) => { seen = { url, method: init.method, body: JSON.parse(init.body) }; return { ok: true, status: 200, text: async () => "ok" }; },
  });
  const result = await notifier.send("hello");
  assert.equal(result.ok, true);
  assert.equal(seen.url, "https://hooks.slack.com/x");
  assert.equal(seen.method, "POST");
  assert.deepEqual(seen.body, { text: "hello" });
});

test("notifier 把发送失败返回成 ok:false 而不抛错", async () => {
  const errors = [];
  const notifier = createNotifier({
    enabled: true, webhookUrl: "https://hooks.slack.com/x",
    fetchImpl: async () => { throw new TypeError("fetch failed"); },
    logger: { info: () => {}, warn: () => {}, error: (m) => errors.push(m) },
  });
  const result = await notifier.send("hello");
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("fetch failed"));
  assert.equal(errors.length, 1);
});
