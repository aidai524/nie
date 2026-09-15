import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toHumanAmount, formatAmount, formatDeviation, formatRelativeTime,
  computeDeviationPct, computeCostPct, formatCostPct, freshnessText, buildRows, summarise, sortRows, applyFilters,
  collectChains, STATUS_LABELS,
} from "../public/dashboard.js";

const PAIR_A = {
  id: "near:USDC>eth:USDC", label: "near:USDC → eth:USDC",
  fromKey: "near:USDC", toKey: "eth:USDC",
  fromDecimals: 6, toDecimals: 6, swapType: "EXACT_OUTPUT", amount: "1500",
};
const PAIR_B = {
  id: "near:USDC>sol:USDC", label: "near:USDC → sol:USDC",
  fromKey: "near:USDC", toKey: "sol:USDC",
  fromDecimals: 6, toDecimals: 6, swapType: "EXACT_OUTPUT", amount: "1500",
};
const PAIR_ZEC = {
  id: "near:USDC>zec:ZEC", label: "near:USDC → zec:ZEC",
  fromKey: "near:USDC", toKey: "zec:ZEC",
  fromDecimals: 6, toDecimals: 8, swapType: "EXACT_OUTPUT", amount: "0.5",
};

const quote = (pairId, overrides = {}) => ({
  pairId, ts: "2026-09-15T06:00:00.000Z", ok: true, httpStatus: 201, latencyMs: 2290,
  amountIn: "1501955004", amountOut: "1500000000", amountInUsd: "1501.73", amountOutUsd: "1499.78",
  minAmountIn: "1500453048", minAmountOut: "1500000000", timeEstimate: 27, correlationId: "cid",
  errorCode: null, errorMessage: null, stateStatus: "ok", stateSince: "2026-09-15T06:00:00.000Z", stateFailures: 0,
  ...overrides,
});

const NOW = "2026-09-15T06:00:30.000Z";

// ---------- toHumanAmount ----------

test("toHumanAmount 按 decimals 还原最小单位", () => {
  assert.equal(toHumanAmount("1501955004", 6), 1501.955004);
  assert.equal(toHumanAmount("1500000000", 6), 1500);
  assert.equal(toHumanAmount("50000000", 8), 0.5);
  assert.equal(toHumanAmount("1", 18), 1e-18);
  assert.equal(toHumanAmount("0", 6), 0);
});

test("toHumanAmount 对坏输入返回 null 而不是 NaN", () => {
  assert.equal(toHumanAmount(null, 6), null);
  assert.equal(toHumanAmount(undefined, 6), null);
  assert.equal(toHumanAmount("", 6), null);
  assert.equal(toHumanAmount("abc", 6), null);
  assert.equal(toHumanAmount("1.5", 6), null, "最小单位必须是整数字符串");
  assert.equal(toHumanAmount("100", -1), null);
  assert.equal(toHumanAmount("100", 1.5), null);
});

test("toHumanAmount 处理位数少于 decimals 的小值", () => {
  assert.equal(toHumanAmount("5", 6), 0.000005);
  assert.equal(toHumanAmount("123", 8), 0.00000123);
});

// ---------- formatAmount ----------

test("formatAmount 四条分档", () => {
  assert.equal(formatAmount(1501.955004), "1,501.96", ">= 1000 走千分位 + 2 位");
  assert.equal(formatAmount(1.501955004), "1.5020", "1..1000 走 4 位");
  assert.equal(formatAmount(0.5), "0.5", "< 1 走 6 位有效数字并去尾零");
  assert.equal(formatAmount(0), "0");
});

test("formatAmount 不把极小值显示成 0", () => {
  assert.equal(formatAmount(0.000001), "0.000001", "这正是不能用固定 4 位小数的原因");
  assert.equal(formatAmount(0.000000000000000001), "0.000000000000000001", "18 位是下限");
  assert.equal(formatAmount(-0.000001), "-0.000001");
});

test("formatAmount 千分位是手写的，不受 locale 影响", () => {
  assert.equal(formatAmount(1234567.891), "1,234,567.89");
  assert.equal(formatAmount(-1234567.891), "-1,234,567.89");
});

test("formatAmount 对坏输入给破折号", () => {
  assert.equal(formatAmount(null), "—");
  assert.equal(formatAmount(undefined), "—");
  assert.equal(formatAmount(Number.NaN), "—");
  assert.equal(formatAmount("abc"), "—");
});

// ---------- computeDeviationPct / formatDeviation ----------

test("computeDeviationPct 用与告警同一个量（最小单位，无需换算）", () => {
  assert.equal(computeDeviationPct("1501955004", 1480000000), Number(((1501955004 - 1480000000) / 1480000000) * 100));
  assert.equal(computeDeviationPct("1000000000", 1000000000), 0);
});

test("computeDeviationPct 正负都保留", () => {
  assert.ok(computeDeviationPct("900000000", 1000000000) < 0);
  assert.ok(computeDeviationPct("1100000000", 1000000000) > 0);
});

test("computeDeviationPct 在 median 缺失或为 0 时返回 null（不除零）", () => {
  assert.equal(computeDeviationPct("100", null), null);
  assert.equal(computeDeviationPct("100", undefined), null);
  assert.equal(computeDeviationPct("100", 0), null);
  assert.equal(computeDeviationPct(null, 100), null);
  assert.equal(computeDeviationPct("abc", 100), null);
});

test("formatDeviation 四舍五入到零时不带负号（实测 −0.0000012% 会显示成 -0.00%，看起来像坏了）", () => {
  assert.equal(formatDeviation(-0.0000012), "0.00%");
  assert.equal(formatDeviation(0.0000012), "0.00%");
  assert.equal(formatDeviation(-0.004), "0.00%");
  assert.equal(formatDeviation(-0.006), "-0.01%", "真正舍入到 -0.01 的仍要带负号");
  assert.equal(formatDeviation(0.006), "+0.01%");
});

test("formatDeviation 带正负号与两位小数", () => {
  assert.equal(formatDeviation(1.3013), "+1.30%");
  assert.equal(formatDeviation(-0.5), "-0.50%");
  assert.equal(formatDeviation(0), "0.00%");
  assert.equal(formatDeviation(null), "—");
});

// ---------- computeCostPct / formatCostPct ----------

test("computeCostPct 用美元口径算这次报价的总损耗", () => {
  // 实测样本：付出 1501.7387 美元的币，收到 1499.7840 美元
  assert.ok(Math.abs(computeCostPct("1501.7387", "1499.784") - 0.1302) < 0.0001);
  assert.equal(computeCostPct("1500", "1500"), 0);
});

test("computeCostPct 只看美元金额，所以两个 token 小数位不同也不受影响", () => {
  // bsc:USDC 是 18 位小数、near:USDC 是 6 位。若拿最小单位相除会得到
  // 100110509950192%（实测），而美元口径给出正常的 0.11%。
  assert.ok(Math.abs(computeCostPct("1501.6", "1499.9") - 0.1132) < 0.0001);
});

test("computeCostPct 对缺失或非正的分母返回 null", () => {
  assert.equal(computeCostPct(null, "1500"), null);
  assert.equal(computeCostPct("1500", null), null);
  assert.equal(computeCostPct("0", "1500"), null);
  assert.equal(computeCostPct("abc", "1500"), null);
  assert.equal(computeCostPct(undefined, undefined), null);
});

test("computeCostPct 对「收到的比付出的更值钱」保留负号", () => {
  assert.ok(computeCostPct("1500", "1501") < 0);
});

test("formatCostPct 不带正号，且不在零上留负号", () => {
  assert.equal(formatCostPct(0.1302), "0.13%");
  assert.equal(formatCostPct(0), "0.00%");
  assert.equal(formatCostPct(-0.0000012), "0.00%");
  assert.equal(formatCostPct(-0.5), "-0.50%");
  assert.equal(formatCostPct(null), "—");
});

// ---------- formatRelativeTime ----------

test("formatRelativeTime 各档位", () => {
  const base = Date.parse("2026-09-15T06:00:00.000Z");
  const at = (seconds) => new Date(base + seconds * 1000).toISOString();
  assert.equal(formatRelativeTime("2026-09-15T06:00:00.000Z", at(0)), "刚刚");
  assert.equal(formatRelativeTime("2026-09-15T06:00:00.000Z", at(-5)), "刚刚", "未来时间（时钟偏移）也当刚刚");
  assert.equal(formatRelativeTime("2026-09-15T06:00:00.000Z", at(12)), "12 秒前");
  assert.equal(formatRelativeTime("2026-09-15T06:00:00.000Z", at(59)), "59 秒前");
  assert.equal(formatRelativeTime("2026-09-15T06:00:00.000Z", at(60)), "1 分钟前");
  assert.equal(formatRelativeTime("2026-09-15T06:00:00.000Z", at(3599)), "59 分钟前");
  assert.equal(formatRelativeTime("2026-09-15T06:00:00.000Z", at(3600)), "1 小时前");
  assert.equal(formatRelativeTime("2026-09-15T06:00:00.000Z", at(86399)), "23 小时前");
  assert.equal(formatRelativeTime("2026-09-15T06:00:00.000Z", at(86400)), "1 天前");
});

test("formatRelativeTime 对坏输入给破折号", () => {
  assert.equal(formatRelativeTime(null, NOW), "—");
  assert.equal(formatRelativeTime("not-a-date", NOW), "—");
});

// ---------- buildRows ----------

test("freshnessText：刚启动、第一轮还没跑完时不能说「采集已陈旧」", () => {
  // lastRoundTs 是内存态，启动时为空 → /health 回 503。这时的 503 意思是「还没开始」，
  // 不是「陈旧」。说成陈旧会让人以为采集挂了，而那只是第一轮还在跑（约 15 秒）。
  const out = freshnessText({ health: { ok: false, lastRoundTs: null, consecutiveRoundErrors: 0 }, loadedAtIso: NOW, nowIso: NOW });
  assert.ok(out.text.includes("正在采集第一轮"), `实际: ${out.text}`);
  assert.ok(!out.text.includes("陈旧"), "不能同时说陈旧");
  assert.equal(out.warn, false, "这不是警告态");
});

test("freshnessText：真的陈旧时才是警告", () => {
  const out = freshnessText({ health: { ok: false, lastRoundTs: "2026-09-15T05:00:00.000Z", consecutiveRoundErrors: 0 }, loadedAtIso: NOW, nowIso: NOW });
  assert.ok(out.text.includes("采集已陈旧"));
  assert.equal(out.warn, true);
});

test("freshnessText：还没取到数据时显示加载中", () => {
  const out = freshnessText({ health: null, loadedAtIso: null, nowIso: NOW });
  assert.equal(out.text, "正在加载…");
  assert.equal(out.warn, false);
});

test("freshnessText：一切正常时只报最后更新时间", () => {
  const out = freshnessText({ health: { ok: true, lastRoundTs: NOW }, loadedAtIso: NOW, nowIso: "2026-09-15T06:01:00.000Z" });
  assert.equal(out.text, "最后更新 30 秒前");
  assert.equal(out.warn, false);
});

test("freshnessText：采集轮次连续失败时追加说明", () => {
  const out = freshnessText({ health: { ok: true, lastRoundTs: NOW, consecutiveRoundErrors: 3 }, loadedAtIso: NOW, nowIso: NOW });
  assert.ok(out.text.includes("连续失败 3 次"));
});

test("buildRows 关联 /pairs 与 /latest，并用 from/to 的 decimals 分别换算", () => {
  const [row] = buildRows({
    pairs: [PAIR_ZEC],
    latest: [quote(PAIR_ZEC.id, { amountIn: "1501955004", amountOut: "50000000" })],
    stats: [],
    nowIso: NOW,
  });
  assert.equal(row.pairId, PAIR_ZEC.id);
  assert.equal(row.status, "ok");
  assert.equal(row.payText, "1,501.96", "amountIn 用 fromDecimals=6");
  assert.equal(row.receiveText, "0.5", "amountOut 用 toDecimals=8");
  assert.equal(row.usdText, "$1,501.73");
});

test("buildRows 给出成本列（美元口径），而不是只把 付/得 摆在那里让人自己看", () => {
  const [row] = buildRows({ pairs: [PAIR_A], latest: [quote(PAIR_A.id)], stats: [], nowIso: NOW });
  // 夹具里 amountInUsd 1501.73 / amountOutUsd 1499.78 → (1501.73-1499.78)/1501.73 = 0.1298%
  assert.equal(row.costText, "0.13%");
});

test("buildRows 在美元缺失或报价失败时成本列给破折号", () => {
  const [missing] = buildRows({
    pairs: [PAIR_A], latest: [quote(PAIR_A.id, { amountInUsd: null, amountOutUsd: null })], stats: [], nowIso: NOW,
  });
  assert.equal(missing.costText, "—", "没有美元金额就没法算成本，不能瞎编");
  const [partial] = buildRows({
    pairs: [PAIR_A], latest: [quote(PAIR_A.id, { amountOutUsd: null })], stats: [], nowIso: NOW,
  });
  assert.equal(partial.costText, "—");
  const [failed] = buildRows({
    pairs: [PAIR_A], latest: [quote(PAIR_A.id, { ok: false, stateStatus: "error" })], stats: [], nowIso: NOW,
  });
  assert.equal(failed.costText, "—");
});

test("buildRows 的偏离取自 /stats 的 metric.median，样本不足时标记但不隐藏数字", () => {
  const stats = [{ pairId: PAIR_A.id, n: 10, okN: 10, okRate: 1, metric: { median: 1480000000 }, latency: {} }];
  const [enough] = buildRows({ pairs: [PAIR_A], latest: [quote(PAIR_A.id)], stats, nowIso: NOW });
  assert.equal(enough.deviationText, "+1.48%");
  assert.equal(enough.deviationMuted, false);

  const few = [{ pairId: PAIR_A.id, n: 2, okN: 2, okRate: 1, metric: { median: 1480000000 }, latency: {} }];
  const [scarce] = buildRows({ pairs: [PAIR_A], latest: [quote(PAIR_A.id)], stats: few, nowIso: NOW });
  assert.equal(scarce.deviationText, "+1.48%", "样本少也要显示数字 —— 藏起来会让人以为「没有偏离」");
  assert.equal(scarce.deviationMuted, true, "但必须降饱和度标注，因为服务端此时不会判定偏离");
});

test("buildRows 在没有统计条目或 median 为 null 时给破折号", () => {
  const [noStat] = buildRows({ pairs: [PAIR_A], latest: [quote(PAIR_A.id)], stats: [], nowIso: NOW });
  assert.equal(noStat.deviationText, "—");
  const [noMedian] = buildRows({
    pairs: [PAIR_A], latest: [quote(PAIR_A.id)],
    stats: [{ pairId: PAIR_A.id, n: 1, okN: 0, okRate: 0, metric: null }], nowIso: NOW,
  });
  assert.equal(noMedian.deviationText, "—");
});

test("buildRows 的失败行把对方原文放进备注，金额列给破折号", () => {
  const [row] = buildRows({
    pairs: [PAIR_A],
    latest: [quote(PAIR_A.id, {
      ok: false, amountIn: null, amountOut: null, amountInUsd: null,
      errorCode: "limits", errorMessage: "Temporary swap limits: minimum swap amount is $1,000",
      stateStatus: "error", stateFailures: 3,
    })],
    stats: [],
    nowIso: NOW,
  });
  assert.equal(row.status, "error");
  assert.equal(row.statusLabel, "失败");
  assert.equal(row.payText, "—");
  assert.equal(row.receiveText, "—");
  assert.equal(row.usdText, "—");
  assert.equal(row.deviationText, "—");
  assert.ok(row.note.includes("limits"));
  assert.ok(row.note.includes("minimum swap amount"), "对方原文要原样透出");
  assert.equal(row.noteClass, "err");
});

test("buildRows 把 deviant 归到与告警一致的状态标签", () => {
  const [row] = buildRows({ pairs: [PAIR_A], latest: [quote(PAIR_A.id, { stateStatus: "deviant" })], stats: [], nowIso: NOW });
  assert.equal(row.status, "deviant");
  assert.equal(row.statusLabel, "偏离");
});

test("buildRows 处理还没有报价的币对（服务刚起）", () => {
  const [row] = buildRows({ pairs: [PAIR_A], latest: [], stats: [], nowIso: NOW });
  assert.equal(row.status, null);
  assert.equal(row.statusLabel, STATUS_LABELS.unknown);
  assert.equal(row.payText, "—");
  assert.equal(row.lastQuoteText, "—");
  assert.equal(row.detail, null);
});

test("buildRows 把 /latest 里有、/pairs 里没有的孤儿行也带上，并提示缺 decimals", () => {
  const rows = buildRows({ pairs: [], latest: [quote("ghost:PAIR")], stats: [], nowIso: NOW });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pairId, "ghost:PAIR");
  assert.equal(rows[0].payText, "—", "没有 decimals 就没法换算");
  assert.ok(rows[0].note.includes("未知币对"), "不能静默 —— 契约漂移时页面要出声");
});

test("buildRows 对超阈值延迟标黄", () => {
  const [fast] = buildRows({ pairs: [PAIR_A], latest: [quote(PAIR_A.id, { latencyMs: 1200 })], stats: [], nowIso: NOW });
  const [slow] = buildRows({ pairs: [PAIR_A], latest: [quote(PAIR_A.id, { latencyMs: 6120 })], stats: [], nowIso: NOW });
  assert.equal(fast.latencyWarn, false);
  assert.equal(slow.latencyWarn, true);
  assert.equal(slow.latencyMs, 6120);
});

test("buildRows 的展开详情带上排障字段", () => {
  const [row] = buildRows({ pairs: [PAIR_A], latest: [quote(PAIR_A.id)], stats: [], nowIso: NOW });
  assert.equal(row.detail.correlationId, "cid");
  assert.equal(row.detail.minAmountOut, "1500000000");
  assert.equal(row.detail.httpStatus, 201);
  assert.equal(row.detail.swapType, "EXACT_OUTPUT");
  assert.equal(row.detail.configuredAmount, "1500");
});

// ---------- summarise / sortRows / applyFilters / collectChains ----------

test("summarise 数出各状态", () => {
  const rows = [
    { status: "ok" }, { status: "ok" }, { status: "error" }, { status: "deviant" }, { status: null },
  ];
  assert.deepEqual(summarise(rows), { ok: 2, deviant: 1, error: 1, unknown: 1 });
});

test("summarise 遇到意外状态值不会产生 NaN", () => {
  assert.deepEqual(summarise([{ status: "wat" }, { status: undefined }]), { ok: 0, deviant: 0, error: 0, unknown: 2 });
});

test("sortRows 把问题排在最前，同状态按 pairId", () => {
  const rows = [
    { pairId: "b", status: "ok" }, { pairId: "a", status: "ok" },
    { pairId: "d", status: "deviant" }, { pairId: "c", status: "error" },
    { pairId: "e", status: null },
  ];
  assert.deepEqual(sortRows(rows).map((r) => r.pairId), ["c", "d", "a", "b", "e"]);
});

test("sortRows 不改动入参", () => {
  const rows = [{ pairId: "b", status: "ok" }, { pairId: "a", status: "error" }];
  sortRows(rows);
  assert.deepEqual(rows.map((r) => r.pairId), ["b", "a"]);
});

test("applyFilters 的仅异常 = 状态不是 ok（含偏离与尚未报价）", () => {
  const rows = [
    { pairId: "a", status: "ok", fromKey: "near:USDC", toKey: "eth:USDC" },
    { pairId: "b", status: "deviant", fromKey: "near:USDC", toKey: "sol:USDC" },
    { pairId: "c", status: "error", fromKey: "near:USDC", toKey: "bsc:USDC" },
    { pairId: "d", status: null, fromKey: "near:USDC", toKey: "tron:USDT" },
  ];
  assert.deepEqual(applyFilters(rows, { onlyProblems: true }).map((r) => r.pairId), ["b", "c", "d"]);
  assert.deepEqual(applyFilters(rows, {}).map((r) => r.pairId), ["a", "b", "c", "d"]);
});

test("applyFilters 的链过滤按「涉及该链」，源或目标都算", () => {
  const rows = [
    { pairId: "a", status: "ok", fromKey: "near:USDC", toKey: "eth:USDC" },
    { pairId: "b", status: "ok", fromKey: "eth:USDC", toKey: "near:USDC" },
    { pairId: "c", status: "ok", fromKey: "near:USDC", toKey: "sol:USDC" },
  ];
  assert.deepEqual(applyFilters(rows, { chain: "eth" }).map((r) => r.pairId), ["a", "b"]);
  assert.deepEqual(applyFilters(rows, { chain: "near" }).map((r) => r.pairId), ["a", "b", "c"]);
  assert.deepEqual(applyFilters(rows, { chain: "" }).map((r) => r.pairId), ["a", "b", "c"]);
});

test("applyFilters 的搜索不区分大小写且匹配整个币对串", () => {
  const rows = [{ pairId: "a", status: "ok", fromKey: "near:USDC", toKey: "zec:ZEC" }];
  assert.equal(applyFilters(rows, { query: "zec" }).length, 1);
  assert.equal(applyFilters(rows, { query: "USDC → ZEC" }).length, 1);
  assert.equal(applyFilters(rows, { query: "btc" }).length, 0);
});

test("applyFilters 的 chain 不会把 nearx 误当成 near", () => {
  const rows = [{ pairId: "a", status: "ok", fromKey: "nearx:USDC", toKey: "eth:USDC" }];
  assert.equal(applyFilters(rows, { chain: "near" }).length, 0, "必须按 network 精确匹配而不是前缀匹配");
});

test("collectChains 去重、排序，涵盖源与目标", () => {
  assert.deepEqual(collectChains([PAIR_A, PAIR_B, PAIR_ZEC]), ["eth", "near", "sol", "zec"]);
  assert.deepEqual(collectChains([]), []);
});
