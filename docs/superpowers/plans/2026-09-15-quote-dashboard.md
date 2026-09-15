# 报价监控面板 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 由现有监控服务托管一个只读单页，一屏展示 38 对币对的当前状态、成交价、相对基准偏离、延迟与对方返回的原始错误。

**Architecture:** 纯前端页面每 30 秒并行拉 `/latest`、`/stats?window=1h`、`/health`，启动时拉一次 `/pairs`（decimals 与配置金额只在它里面）。后端只加一张显式白名单静态路由。页面逻辑切成两层：`public/dashboard.js` 里全部纯函数（算术、格式化、排序、过滤、关联）+ 一个 `init()`（DOM 与网络）；`public/index.html` 只放标记与样式。

**Tech Stack:** Node.js 24（后端一条静态路由）、原生 ES 模块、原生 CSS、`node:test`。

**Spec:** `docs/superpowers/specs/2026-09-15-quote-dashboard-design.md`

## Global Constraints

- **零运行时依赖。** `package.json` 不得出现 `dependencies`/`devDependencies`。前端不能引任何 npm 包（无 React、无 Chart.js、无构建步骤）。
- **`public/dashboard.js` 的模块顶层不得访问 `document` / `window` / `fetch` / `localStorage`。** 它会被 `node:test` 直接 `import`，顶层碰这些全局会立刻炸。所有 DOM 与网络访问必须关在 `init()` 及其下游函数里。
- **不用 `toLocaleString` / `localeCompare`。** 二者输出随运行环境 locale 变化，会让单测在不同机器上得到不同结果。千分位与字符串排序都手写。
- **UI 文案中文，标识符英文。** 页面上的用户可见文字全中文；函数名、字段名、CSS 类名、元素 id 全英文。不要 emoji。
- **后端只改一处**：`src/server.js` 增加静态白名单路由。`src/server.js` 的 import 从「只有 `node:http`」变为「`node:http` + `node:fs`」——两个都是内置模块，零依赖约束不变。
- 静态路由**不校验 bearer token**（否则配了令牌的人连页面都拿不到，也就没机会把令牌交给页面）。
- **页面绝不自己判定状态。** 状态列一律取 `/latest` 的 `stateStatus`（服务端用真实阈值算的）。页面里出现的常量 `10`（阈值展示文案）与 `5`（样本不足提示）**只用于标注，绝不参与判定**。
- `npm test` 必须保持全绿（当前 **180** 个用例），且输出必须干净 —— 除 npm 自己的两行 `notice` 外不得有警告或杂输出。
- 每个 Task 结束必须提交一次，commit message 用 `feat:` / `test:` / `docs:` 前缀。

## File Structure

```
public/
  index.html      # 标记 + 样式；唯一职责是描述结构，逻辑全在 dashboard.js
  dashboard.js    # 纯函数区（可测）+ init() 装配区（不测，靠手工冒烟）
test/
  dashboard.test.js   # 纯函数单测
  server.test.js      # 既有文件，追加静态路由用例
src/
  server.js           # 既有文件，追加 PUBLIC_FILES 白名单与 normalizePath 抽取
README.md             # 既有文件，追加「面板」一节 + 手工冒烟清单
```

`public/dashboard.js` 内部又分两层，用一条明显的注释分隔：**纯函数区在上，`init()` 装配区在下**。加新逻辑时先问它属于哪一层 —— 能写成纯函数的就绝不写进 `init()`，因为纯函数有测试而 `init()` 没有。

---

### Task 1: 纯函数层（全部算术与排序）

**Files:**
- Create: `public/dashboard.js`
- Test: `test/dashboard.test.js`

**Interfaces:**
- Consumes: 无
- Produces（Task 2 只 import 这些）:
  - `toHumanAmount(raw, decimals): number | null` —— 链上最小单位字符串 → 人类可读数值
  - `formatAmount(value): string`
  - `formatDeviation(pct): string`
  - `formatRelativeTime(tsIso, nowIso): string`
  - `computeDeviationPct(amountIn, median): number | null`
  - `buildRows({ pairs, latest, stats, nowIso }): Row[]`，`Row = { pairId, label, fromKey, toKey, status, statusLabel, payText, receiveText, usdText, deviationText, deviationMuted, latencyMs, latencyWarn, lastQuoteText, lastQuoteTitle, note, noteClass, detail }`
  - `summarise(rows): { ok, deviant, error, unknown }`
  - `sortRows(rows): Row[]`
  - `applyFilters(rows, { onlyProblems, chain, query }): Row[]`
  - `collectChains(pairs): string[]`
  - `STATUS_LABELS: Record<string, string>`

- [x] **Step 1: 写失败测试 `test/dashboard.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toHumanAmount, formatAmount, formatDeviation, formatRelativeTime,
  computeDeviationPct, buildRows, summarise, sortRows, applyFilters,
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

test("formatDeviation 带正负号与两位小数", () => {
  assert.equal(formatDeviation(1.3013), "+1.30%");
  assert.equal(formatDeviation(-0.5), "-0.50%");
  assert.equal(formatDeviation(0), "0.00%");
  assert.equal(formatDeviation(null), "—");
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
```

- [x] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— `Cannot find module '../public/dashboard.js'`

- [x] **Step 3: 实现 `public/dashboard.js` 的纯函数区**

```js
// ============================================================================
// 纯函数区
//
// 这一层不访问 document / window / fetch / localStorage —— 它会被 node:test
// 直接 import，顶层碰任何 DOM 或网络全局都会让测试在加载期就炸。
// 会出错的是算术、格式化与排序，那些全在这里，因此全都有测试。
// 新增逻辑时先问它属于哪一层：能写成纯函数的绝不写进下面的 init()。
// ============================================================================

export const STATUS_LABELS = { ok: "正常", deviant: "偏离", error: "失败", unknown: "未知" };

// 仅用于「样本不足，仅供参考」的提示标注。这是服务端 detect.minSamples 的默认值，
// API 不暴露它，所以这里硬编码一份 —— 但它绝不参与状态判定（状态一律取 stateStatus）。
const LOW_SAMPLE_THRESHOLD = 5;

// 延迟超过这个值标黄。纯展示阈值。
const LATENCY_WARN_MS = 5000;

/** 链上最小单位整数字符串 → 人类可读数值。展示层，允许转 Number（只显示 6 位有效数字）。 */
export function toHumanAmount(raw, decimals) {
  if (raw === null || raw === undefined) return null;
  if (!Number.isInteger(decimals) || decimals < 0) return null;
  const text = String(raw).trim();
  if (!/^-?\d+$/.test(text)) return null;
  const negative = text.startsWith("-");
  const digits = (negative ? text.slice(1) : text).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals > 0 ? digits.slice(digits.length - decimals) : "";
  const value = Number(fraction ? `${whole}.${fraction}` : whole);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/** 手写千分位。不用 toLocaleString —— 它的输出随运行环境 locale 变化。 */
function groupThousands(text) {
  const [whole, fraction] = String(text).split(".");
  const sign = whole.startsWith("-") ? "-" : "";
  const digits = sign ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return sign + grouped + (fraction === undefined ? "" : `.${fraction}`);
}

/** 6 位有效数字 + 去尾零。用于 |v| < 1，避免 0.000001 被显示成 0.0000。 */
function toSignificant(value) {
  const abs = Math.abs(value);
  const firstSignificant = -Math.floor(Math.log10(abs)) - 1;
  const decimals = Math.min(Math.max(firstSignificant + 6, 1), 18);
  const fixed = abs.toFixed(decimals).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return value < 0 ? `-${fixed}` : fixed;
}

export function formatAmount(value) {
  if (value === null || value === undefined) return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  if (number === 0) return "0";
  const abs = Math.abs(number);
  if (abs >= 1000) return groupThousands(number.toFixed(2));
  if (abs >= 1) return number.toFixed(4);
  return toSignificant(number);
}

export function computeDeviationPct(amountIn, median) {
  const value = Number(amountIn);
  const base = Number(median);
  if (amountIn === null || amountIn === undefined) return null;
  if (median === null || median === undefined) return null;
  if (!Number.isFinite(value) || !Number.isFinite(base) || base === 0) return null;
  return ((value - base) / base) * 100;
}

export function formatDeviation(pct) {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return "—";
  return `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

/** nowIso 必须由调用方传入，否则这个函数无法测试。 */
export function formatRelativeTime(tsIso, nowIso) {
  if (!tsIso) return "—";
  const then = Date.parse(tsIso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return "—";
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 0) return "刚刚"; // 时钟偏移导致的「未来」时间，不要显示负数
  if (seconds < 60) return seconds <= 0 ? "刚刚" : `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export function summarise(rows) {
  const counts = { ok: 0, deviant: 0, error: 0, unknown: 0 };
  for (const row of rows) {
    const key = row?.status;
    if (key === "ok" || key === "deviant" || key === "error") counts[key] += 1;
    else counts.unknown += 1;
  }
  return counts;
}

const STATUS_RANK = { error: 0, deviant: 1, ok: 2 };

export function sortRows(rows) {
  return [...rows].sort((left, right) => {
    const rankLeft = STATUS_RANK[left.status] ?? 3;
    const rankRight = STATUS_RANK[right.status] ?? 3;
    if (rankLeft !== rankRight) return rankLeft - rankRight;
    // 手写比较，不用 localeCompare（其顺序随 locale 变化，测试会不稳）
    const a = String(left.pairId);
    const b = String(right.pairId);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export function applyFilters(rows, { onlyProblems = false, chain = "", query = "" } = {}) {
  const needle = query.trim().toLowerCase();
  return rows.filter((row) => {
    // 「仅异常」= 状态不是 ok 的。deviant 与「尚未报价」（null）都算需要关注。
    if (onlyProblems && row.status === "ok") return false;
    if (chain) {
      const prefix = `${chain}:`;
      if (!String(row.fromKey).startsWith(prefix) && !String(row.toKey).startsWith(prefix)) return false;
    }
    if (needle) {
      const haystack = `${row.fromKey} → ${row.toKey}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

export function collectChains(pairs) {
  const chains = new Set();
  for (const pair of pairs) {
    for (const key of [pair.fromKey, pair.toKey]) {
      const network = String(key ?? "").split(":")[0];
      if (network) chains.add(network);
    }
  }
  return [...chains].sort();
}

function buildRow({ pair, quote, stat, nowIso }) {
  const pairId = pair?.id ?? quote?.pairId ?? "?";
  // 状态一律取服务端的判定结果（/latest 的 stateStatus）。
  // 不用 /pairs 里的 state —— 那是启动那一刻的快照；也不自己算 ——
  // priceDeviationPct 与 minSamples 都不在 API 里，自己算迟早会和告警说法不一致。
  const status = quote?.stateStatus ?? null;
  const fromKey = pair?.fromKey ?? pairId.split(">")[0] ?? "";
  const toKey = pair?.toKey ?? pairId.split(">")[1] ?? "";
  const convert = (raw, decimals) => (pair ? toHumanAmount(raw, decimals) : null);

  const amountIn = convert(quote?.amountIn, pair?.fromDecimals);
  const amountOut = convert(quote?.amountOut, pair?.toDecimals);
  const deviationPct = quote?.ok ? computeDeviationPct(quote?.amountIn, stat?.metric?.median ?? null) : null;
  const lowSample = !(stat && Number.isFinite(stat.okN) && stat.okN >= LOW_SAMPLE_THRESHOLD);

  let note = "";
  let noteClass = "";
  if (quote && quote.ok === false) {
    note = [quote.errorCode, quote.errorMessage].filter(Boolean).join(" — ");
    noteClass = "err";
  } else if (!pair && quote) {
    note = "未知币对（接口返回了不在白名单里的 pairId）";
    noteClass = "warn";
  } else if (!quote) {
    note = "尚未采集到这一对";
    noteClass = "muted";
  }

  return {
    pairId,
    label: pair?.label ?? pairId,
    fromKey,
    toKey,
    status,
    statusLabel: STATUS_LABELS[status] ?? STATUS_LABELS.unknown,
    payText: quote?.ok ? formatAmount(amountIn) : "—",
    receiveText: quote?.ok ? formatAmount(amountOut) : "—",
    usdText: quote?.amountInUsd == null ? "—" : `$${formatAmount(Number(quote.amountInUsd))}`,
    deviationText: quote?.ok ? formatDeviation(deviationPct) : "—",
    deviationMuted: quote?.ok ? lowSample : false,
    latencyMs: quote?.latencyMs ?? null,
    latencyWarn: Number.isFinite(quote?.latencyMs) && quote.latencyMs > LATENCY_WARN_MS,
    lastQuoteText: quote ? formatRelativeTime(quote.ts, nowIso) : "—",
    lastQuoteTitle: quote?.ts ?? "",
    note,
    noteClass,
    detail: quote
      ? {
        correlationId: quote.correlationId ?? "—",
        httpStatus: quote.httpStatus ?? "—",
        minAmountIn: quote.minAmountIn ?? "—",
        minAmountOut: quote.minAmountOut ?? "—",
        timeEstimate: quote.timeEstimate ?? "—",
        swapType: pair?.swapType ?? "—",
        configuredAmount: pair?.amount ?? "—",
        consecutiveFailures: quote.stateFailures ?? 0,
        statusSince: quote.stateSince ?? "—",
      }
      : null,
  };
}

export function buildRows({ pairs = [], latest = [], stats = [], nowIso }) {
  const latestByPair = new Map(latest.map((entry) => [entry.pairId, entry]));
  const statsByPair = new Map(stats.map((entry) => [entry.pairId, entry]));
  const rows = [];
  const seen = new Set();

  for (const pair of pairs) {
    seen.add(pair.id);
    rows.push(buildRow({ pair, quote: latestByPair.get(pair.id) ?? null, stat: statsByPair.get(pair.id) ?? null, nowIso }));
  }
  // /latest 里出现而 /pairs 里没有的行 —— 说明契约漂移了，要显示出来而不是静默丢掉
  for (const entry of latest) {
    if (seen.has(entry.pairId)) continue;
    rows.push(buildRow({ pair: null, quote: entry, stat: statsByPair.get(entry.pairId) ?? null, nowIso }));
  }
  return rows;
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS —— `test/dashboard.test.js` 31 个用例全过，总数 **211**，输出干净（已在写计划时离线跑过一遍验证过）

- [x] **Step 5: 提交**

```bash
git add public/dashboard.js test/dashboard.test.js
git commit -m "feat: 面板纯函数层，含金额换算、偏离、相对时间与排序过滤"
```

---

### Task 2: 页面本体（标记 + 样式 + `init()` 装配）

**Files:**
- Create: `public/index.html`
- Modify: `public/dashboard.js`（在纯函数区之后追加装配区，不改动 Task 1 的任何函数）
- Test: `test/dashboard-dom.test.js`

**Interfaces:**
- Consumes: Task 1 的全部导出
- Produces: `init()`；`public/index.html` 里 `init()` 需要的 13 个元素 id

**关于这一层的测试**：`init()` 碰 DOM 与网络，仓库里没有 DOM 测试框架且不能加依赖，所以它没有单测。但它的失败模式是**可静态检查的**，所以 Task 2 配一条 `test/dashboard-dom.test.js`：从 `dashboard.js` 源码里正则取出 `getElementById("…")` 的全部 id，断言每一个都在 `index.html` 里以 `id="…"` 出现。它不证明渲染正确，只证明**`init()` 要的每个 id 都存在** —— 而写错 id 会静默拿到 `null`，正是这类页面最常见的崩溃方式。

- [x] **Step 1: 写失败测试 `test/dashboard-dom.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const js = readFileSync(new URL("../public/dashboard.js", import.meta.url), "utf8");

test("init() 查询的每个元素 id 都存在于 index.html", () => {
  const ids = [...js.matchAll(/getElementById\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.ok(ids.length >= 13, `只找到 ${ids.length} 个 id，正则或 init() 可能改了`);
  for (const id of ids) {
    assert.ok(html.includes(`id="${id}"`), `index.html 里缺少 id="${id}"`);
  }
});

test("index.html 以模块方式加载 /dashboard.js 并调用 init()", () => {
  assert.match(html, /<script type="module">/);
  assert.ok(html.includes('from "/dashboard.js"'));
  assert.ok(html.includes("init()"));
});

test("index.html 带上面板需要的静态文案块", () => {
  assert.ok(html.includes("NEAR Intents 报价监控"), "标题");
  assert.ok(html.includes("阈值 10%（服务端配置）"), "必须让人知道黄色是谁定的");
  for (const header of ["币对", "状态", "付 → 得", "USD", "偏离", "延迟", "最后报价", "备注"]) {
    assert.ok(html.includes(`>${header}<`), `表头缺少「${header}」`);
  }
});

test("index.html 没有内联事件处理器（CSP 友好，也避免注入面）", () => {
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— `ENOENT: no such file or directory ... public/index.html`

- [x] **Step 3: 写 `public/index.html`**

```html
<!DOCTYPE html>
<html lang="zh-CN">

<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>NEAR Intents 报价监控</title>
  <style>
    :root {
      --bg: #0f1115;
      --panel: #171a21;
      --line: #2a3040;
      --text: #e8ecf4;
      --muted: #8b93a7;
      --accent: #6ea8ff;
      --ok: #3dd68c;
      --warn: #f5c451;
      --err: #ff6b7a;
      --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
    }

    main { max-width: 1400px; margin: 0 auto; padding: 20px; }

    h1 { font-size: 18px; margin: 0; font-weight: 650; }

    .title-row { display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; }

    #counts { color: var(--muted); font-variant-numeric: tabular-nums; }

    .status-row {
      display: flex; align-items: center; gap: 12px;
      margin-top: 10px; color: var(--muted); font-size: 13px;
    }

    .spacer { flex: 1; }

    .hint { color: var(--muted); font-size: 12px; }

    .warn { color: var(--warn); }

    button {
      font: inherit; color: var(--text); background: #10131a;
      border: 1px solid var(--line); border-radius: 8px; padding: 6px 12px; cursor: pointer;
    }

    button:hover { border-color: var(--accent); }

    .token-box {
      margin-top: 10px; padding: 10px; border: 1px solid var(--warn);
      border-radius: 8px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
    }

    .token-box input { font: inherit; color: var(--text); background: #10131a; border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; }

    .filters {
      display: flex; gap: 16px; align-items: center; flex-wrap: wrap;
      margin: 16px 0 10px; color: var(--muted); font-size: 13px;
    }

    .filters input[type="search"] { font: inherit; color: var(--text); background: #10131a; border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px; }
    .filters select { font: inherit; color: var(--text); background: #10131a; border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px; }

    .banner { margin: 0 0 10px; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel); }
    .banner.err { border-color: var(--err); color: var(--err); }
    .banner.warn { border-color: var(--warn); color: var(--warn); }

    table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }

    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }

    th { font-size: 12px; font-weight: 600; color: var(--muted); white-space: nowrap; }

    tbody tr:last-child td { border-bottom: 0; }

    tr.row.clickable { cursor: pointer; }
    tr.row:hover { background: #1c2029; }

    td.pair, td.amount, td.usd, td.latency, td.time { font-family: var(--mono); font-size: 12px; white-space: nowrap; }
    td.usd { color: var(--muted); }
    td.note { color: var(--muted); font-size: 12px; }
    td.note.err { color: var(--err); }
    td.note.warn { color: var(--warn); }
    td.dev { font-family: var(--mono); font-size: 12px; white-space: nowrap; }
    td.dev.muted { color: var(--muted); }

    td.status { font-weight: 650; white-space: nowrap; }
    tr.row.ok td.status { color: var(--ok); }
    tr.row.deviant td.status { color: var(--warn); }
    tr.row.error td.status { color: var(--err); }
    tr.row.unknown td.status { color: var(--muted); }

    tr.detail td { background: #10131a; font-family: var(--mono); font-size: 12px; color: var(--muted); word-break: break-all; }
    tr.detail span.kv { display: inline-block; margin-right: 16px; }
    tr.detail span.kv b { color: var(--text); font-weight: 600; }

    .empty { color: var(--muted); padding: 16px 0; }

    @media (max-width: 900px) {
      th:nth-child(4), td:nth-child(4), th:nth-child(6), td:nth-child(6) { display: none; }
      td.note { max-width: 220px; }
    }
  </style>
</head>

<body>
  <main>
    <header id="topbar">
      <div class="title-row">
        <h1>NEAR Intents 报价监控</h1>
        <span id="counts"></span>
      </div>
      <div class="status-row">
        <span id="freshness">正在加载…</span>
        <span class="spacer"></span>
        <span class="hint">阈值 10%（服务端配置）</span>
        <button type="button" id="refresh">手动刷新</button>
      </div>
      <div class="token-box" id="token-box" hidden>
        <span>服务配了访问令牌，请填入：</span>
        <input id="token-input" type="password" placeholder="Bearer token" autocomplete="off" />
        <button type="button" id="token-save">保存并重试</button>
      </div>
    </header>

    <div class="filters" id="filters">
      <label><input type="checkbox" id="only-problems" /> 仅异常</label>
      <label>链 <select id="chain-select"><option value="">全部</option></select></label>
      <label>搜索 <input id="search" type="search" placeholder="币对…" autocomplete="off" /></label>
      <span id="shown-count" class="hint"></span>
    </div>

    <div class="banner" id="banner" hidden></div>

    <table id="table">
      <thead>
        <tr>
          <th>币对</th>
          <th>状态</th>
          <th>付 → 得</th>
          <th>USD</th>
          <th>偏离</th>
          <th>延迟</th>
          <th>最后报价</th>
          <th>备注</th>
        </tr>
      </thead>
      <tbody id="tbody"></tbody>
    </table>

    <p class="empty" id="empty" hidden></p>
  </main>

  <script type="module">
    import { init } from "/dashboard.js";
    init();
  </script>
</body>

</html>
```

- [x] **Step 4: 在 `public/dashboard.js` 末尾追加装配区**

在 Task 1 写的纯函数区之后**追加**（不要改动上面任何函数）：

```js
// ============================================================================
// 装配区
//
// 以下代码碰 DOM 与网络，因此没有单测 —— 它只做三件事：取数、调纯函数、
// 把结果赋给 DOM。所有判断与算术都在上面的纯函数区里。
// 唯一防回归的自动化检查是 test/dashboard-dom.test.js：它静态比对 init() 要的
// 每个 id 都真的存在于 index.html 里 —— 因为「id 写错拿到 null」是这里最可能的错。
// ============================================================================

const REFRESH_MS = 30000;
const MAX_BACKOFF_MS = 120000;
const TOKEN_STORAGE_KEY = "nearintents.token";

export function init() {
  const el = {
    counts: document.getElementById("counts"),
    freshness: document.getElementById("freshness"),
    banner: document.getElementById("banner"),
    tbody: document.getElementById("tbody"),
    empty: document.getElementById("empty"),
    shownCount: document.getElementById("shown-count"),
    onlyProblems: document.getElementById("only-problems"),
    chainSelect: document.getElementById("chain-select"),
    search: document.getElementById("search"),
    refresh: document.getElementById("refresh"),
    tokenBox: document.getElementById("token-box"),
    tokenInput: document.getElementById("token-input"),
    tokenSave: document.getElementById("token-save"),
  };

  const state = {
    pairs: [],
    rows: [],
    health: null,
    lastLoadedAt: null,
    failures: 0,
    chainsBuilt: false,
    timer: null,
    inFlight: false,
  };

  const readToken = () => {
    try { return localStorage.getItem(TOKEN_STORAGE_KEY) ?? ""; } catch { return ""; }
  };

  async function apiGet(path, { allowStatus = [] } = {}) {
    const headers = { Accept: "application/json" };
    const token = readToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(path, { headers });
    if (response.status === 401) {
      const error = new Error("需要访问令牌");
      error.needsToken = true;
      throw error;
    }
    if (!response.ok && !allowStatus.includes(response.status)) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
  }

  function setBanner(message, kind) {
    if (!message) {
      el.banner.hidden = true;
      el.banner.textContent = "";
      el.banner.className = "banner";
      return;
    }
    el.banner.hidden = false;
    el.banner.textContent = message;
    el.banner.className = `banner ${kind ?? ""}`.trim();
  }

  const currentFilters = () => ({
    onlyProblems: el.onlyProblems.checked,
    chain: el.chainSelect.value,
    query: el.search.value,
  });

  function renderFreshness() {
    if (state.lastLoadedAt === null) {
      el.freshness.textContent = "正在加载…";
      el.freshness.className = "";
      return;
    }
    const parts = [`最后更新 ${formatRelativeTime(state.lastLoadedAt, new Date().toISOString())}`];
    // 陈旧与否直接采信服务端的判定（/health 的 ok），不自己拿 intervalSec 重算 ——
    // 那个值不在 API 里，重算就会和服务端说法不一致。
    if (state.health?.ok === false) parts.push("采集已陈旧");
    if (state.health?.consecutiveRoundErrors > 0) parts.push(`采集轮次连续失败 ${state.health.consecutiveRoundErrors} 次`);
    el.freshness.textContent = parts.join(" · ");
    el.freshness.className = state.health?.ok === false ? "warn" : "";
  }

  function renderChains() {
    if (state.chainsBuilt) return;
    for (const chain of collectChains(state.pairs)) {
      const option = document.createElement("option");
      option.value = chain;
      option.textContent = chain;
      el.chainSelect.append(option);
    }
    state.chainsBuilt = true;
  }

  function cell(text, className) {
    const td = document.createElement("td");
    // 一律 textContent：errorMessage 是对方返回的任意字符串，走 innerHTML 就是注入面
    td.textContent = text ?? "";
    if (className) td.className = className;
    return td;
  }

  function toggleDetail(row, anchor) {
    const selector = `tr[data-detail="${row.pairId}"]`;
    const existing = el.tbody.querySelector(selector);
    if (existing) {
      existing.remove();
      return;
    }
    const tr = document.createElement("tr");
    tr.className = "detail";
    tr.dataset.detail = row.pairId;
    const td = document.createElement("td");
    td.colSpan = 8;
    const items = [
      ["correlationId", row.detail.correlationId],
      ["HTTP", row.detail.httpStatus],
      ["最小收得", row.detail.minAmountOut],
      ["最小付出", row.detail.minAmountIn],
      ["预估耗时", `${row.detail.timeEstimate}s`],
      ["swapType", row.detail.swapType],
      ["配置金额", row.detail.configuredAmount],
      ["连续失败", row.detail.consecutiveFailures],
      ["状态自", row.detail.statusSince],
    ];
    for (const [key, value] of items) {
      const span = document.createElement("span");
      span.className = "kv";
      const label = document.createElement("b");
      label.textContent = key;
      span.append(label, document.createTextNode(` ${value}`));
      td.append(span);
    }
    tr.append(td);
    tr.addEventListener("click", () => tr.remove());
    anchor.after(tr);
  }

  function buildRowElement(row) {
    const tr = document.createElement("tr");
    tr.className = `row ${row.status ?? "unknown"}`;
    tr.append(
      cell(row.label, "pair"),
      cell(row.statusLabel, `status ${row.status ?? "unknown"}`),
      cell(`${row.payText} → ${row.receiveText}`, "amount"),
      cell(row.usdText, "usd"),
      cell(row.deviationMuted ? `${row.deviationText}*` : row.deviationText, row.deviationMuted ? "dev muted" : "dev"),
      cell(row.latencyMs === null ? "—" : `${Math.round(row.latencyMs)}ms`, row.latencyWarn ? "latency warn" : "latency"),
      cell(row.lastQuoteText, "time"),
      cell(row.note, `note ${row.noteClass}`.trim()),
    );
    if (row.lastQuoteTitle) tr.children[6].title = row.lastQuoteTitle;
    if (row.deviationMuted) tr.children[4].title = "样本不足，服务端此时不会判定偏离；仅供参考";
    if (row.detail) {
      tr.classList.add("clickable");
      tr.addEventListener("click", () => toggleDetail(row, tr));
    }
    return tr;
  }

  function renderRows() {
    const filtered = applyFilters(sortRows(state.rows), currentFilters());
    el.shownCount.textContent = filtered.length === state.rows.length
      ? `共 ${state.rows.length} 对`
      : `显示 ${filtered.length} / ${state.rows.length} 对`;
    el.tbody.replaceChildren();
    for (const row of filtered) el.tbody.append(buildRowElement(row));
    const noData = state.rows.length === 0;
    el.empty.hidden = !noData;
    if (noData) el.empty.textContent = "服务在跑，但还没有采集到任何报价 —— 等一轮（约 1 分钟）后刷新。";
  }

  async function load() {
    if (state.inFlight) return;
    state.inFlight = true;
    try {
      const [latest, stats, health] = await Promise.all([
        apiGet("/latest"),
        apiGet("/stats?window=1h"),
        // /health 在陈旧时回 503，但「陈旧」这件事本身正是我们要读的，所以允许 503
        apiGet("/health", { allowStatus: [503] }),
      ]);
      state.health = health;
      state.rows = buildRows({
        pairs: state.pairs,
        latest: latest.latest ?? [],
        stats: stats.pairs ?? [],
        nowIso: new Date().toISOString(),
      });
      state.lastLoadedAt = new Date().toISOString();
      state.failures = 0;
      el.tokenBox.hidden = true;
      setBanner("", null);
      const counts = summarise(state.rows);
      el.counts.textContent = `${counts.ok} 正常 · ${counts.deviant} 偏离 · ${counts.error} 失败`;
      renderRows();
    } catch (error) {
      state.failures += 1;
      if (error.needsToken) {
        el.tokenBox.hidden = false;
        setBanner("接口返回 401：服务配了访问令牌，请在下方填入。", "warn");
      } else {
        // 保留上一次的数据继续显示 —— 陈旧但真实的数据比空白有用，但必须标注陈旧
        setBanner(`服务不可达（已重试 ${state.failures} 次）：${error.message}`, "err");
      }
    } finally {
      state.inFlight = false;
      renderFreshness();
    }
  }

  async function bootstrap() {
    try {
      const pairs = await apiGet("/pairs");
      state.pairs = pairs.pairs ?? [];
      renderChains();
      await load();
    } catch (error) {
      if (error.needsToken) {
        el.tokenBox.hidden = false;
        setBanner("接口返回 401：服务配了访问令牌，请在下方填入。", "warn");
      } else {
        setBanner(`服务不可达：${error.message}`, "err");
      }
      renderFreshness();
    }
  }

  function schedule() {
    if (state.timer !== null) clearTimeout(state.timer);
    // 后台标签页不轮询；重新可见时会立刻刷一次
    if (document.visibilityState === "hidden") return;
    const wait = Math.min(REFRESH_MS * Math.max(1, state.failures), MAX_BACKOFF_MS);
    state.timer = setTimeout(async () => {
      await load();
      schedule();
    }, wait);
  }

  el.refresh.addEventListener("click", async () => {
    await load();
    schedule();
  });
  el.onlyProblems.addEventListener("change", renderRows);
  el.chainSelect.addEventListener("change", renderRows);
  el.search.addEventListener("input", renderRows);
  el.tokenSave.addEventListener("click", async () => {
    try { localStorage.setItem(TOKEN_STORAGE_KEY, el.tokenInput.value.trim()); } catch { /* 隐私模式下存不了，忽略 */ }
    state.failures = 0;
    await bootstrap();
    schedule();
  });
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible") {
      await load();
      schedule();
    } else if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  });

  // 「最后更新 N 秒前」要自己跳秒，否则一个每分钟才变的面板看起来是死的
  setInterval(renderFreshness, 1000);
  bootstrap().then(schedule);
}
```

- [x] **Step 5: 跑测试确认通过**

Run: `npm test`
Expected: PASS —— 新增 4 个 DOM 契约用例，总数 **215**，输出干净

- [x] **Step 6: 确认两个文件落盘且可被解析**

注意：**此处还看不到页面** —— 静态路由是 Task 3 才加的，现在 `curl localhost:8787/` 仍是 404。所以这一步只验证文件本身：

```bash
node --input-type=module -e 'await import("./public/dashboard.js"); console.log("dashboard.js 可被导入且导出 init:", typeof (await import("./public/dashboard.js")).init)'
head -1 public/index.html      # 应为 <!DOCTYPE html>
ls -la public/
```

Expected：`dashboard.js` 能被导入、`init` 是 `function`（这一点不显然：`init()` 内部引用 `document`，但**只在被调用时**才碰，所以 `node:test` 能安全 import 它 —— 这正是全局约束里那条存在的原因）；`index.html` 以 `<!DOCTYPE html>` 开头；两个文件都在 `public/` 下。

真正能看到页面是在 Task 3 加完路由之后。

- [x] **Step 7: 提交**

```bash
git add public/index.html public/dashboard.js test/dashboard-dom.test.js
git commit -m "feat: 面板页面本体与装配逻辑，含 DOM 契约测试"
```

---

### Task 3: 静态文件白名单路由

**Files:**
- Modify: `src/server.js`
- Modify: `test/server.test.js`（追加用例，不动既有）

**Interfaces:**
- Consumes: Task 2 产出的 `public/index.html` 与 `public/dashboard.js`
- Produces: `GET /`、`GET /index.html`、`GET /dashboard.js` 三个静态响应；导出 `normalizePath(pathname)`

- [x] **Step 1: 写失败测试（追加到 `test/server.test.js` 末尾）**

```js
test("GET / 返回面板 HTML", async () => {
  const ctx = await withServer();
  const res = await ctx.get("/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/html/);
  assert.ok((await res.text()).includes("NEAR Intents 报价监控"));
  await ctx.close();
});

test("GET /index.html 与 GET / 返回同一份，且容忍尾斜杠", async () => {
  const ctx = await withServer();
  const root = await (await ctx.get("/")).text();
  assert.equal(await (await ctx.get("/index.html")).text(), root);
  assert.equal(await (await ctx.get("/index.html/")).text(), root, "尾斜杠也要归一化");
  await ctx.close();
});

test("GET /dashboard.js 以 JS 的 MIME 返回", async () => {
  const ctx = await withServer();
  const res = await ctx.get("/dashboard.js");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^(text|application)\/javascript/);
  assert.ok((await res.text()).includes("export function buildRows"));
  await ctx.close();
});

test("静态白名单之外的路径仍是 404，且不存在目录穿越", async () => {
  const ctx = await withServer();
  for (const path of ["/public/index.html", "/package.json", "/dashboard.js.map", "/../package.json", "/public/"]) {
    const res = await ctx.get(path);
    assert.equal(res.status, 404, `${path} 应返回 404，实际 ${res.status}`);
  }
  await ctx.close();
});

test("配了 bearerToken 时静态页面仍可访问，但数据端点仍要令牌", async () => {
  const ctx = await withServer({ bearerToken: "s3cret" });
  assert.equal((await ctx.get("/")).status, 200, "否则拿不到页面就没法把令牌交给页面");
  assert.equal((await ctx.get("/dashboard.js")).status, 200);
  assert.equal((await ctx.get("/health")).status, 401);
  assert.equal((await ctx.get("/health", { headers: { Authorization: "Bearer s3cret" } })).status, 200);
  await ctx.close();
});

test("静态文件响应也带 CORS 头", async () => {
  const ctx = await withServer({ cors: "https://panel.example.com" });
  const res = await ctx.get("/");
  assert.equal(res.headers.get("access-control-allow-origin"), "https://panel.example.com");
  assert.equal(res.headers.get("vary"), "Origin");
  await ctx.close();
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— 上面 6 条中至少 4 条失败（`GET /` 返回 404 而不是 200）

- [x] **Step 3: 更新一条既有用例（本次唯一的既有行为变更）**

`test/server.test.js` 里现有的 `带尾斜杠的路径也能匹配` 断言了 `GET /` 是 **404**。加了面板之后 `/` 就是面板本身，会返回 200 —— 所以这条断言**必须改**，否则 `npm test` 会红（已在写计划时预跑验证过）。把该用例整体换成：

```js
test("带尾斜杠的路径也能匹配", async () => {
  const ctx = await withServer();
  assert.equal((await ctx.get("/health/")).status, 200, "数据端点的尾斜杠仍要归一化");
  // 注意：`/` 在加面板之前是 404，现在是面板本身（200）。这条断言随之更新 ——
  // 这是本次唯一的既有行为变更，且是刻意的。
  assert.equal((await ctx.get("/")).status, 200);
  assert.equal((await ctx.get("/nope/")).status, 404, "未列出的路径（含尾斜杠）仍是 404");
  await ctx.close();
});
```

- [x] **Step 4: 改 `src/server.js`（四处，都在既有代码的间隙里）**

(a) import 行：

```js
import { createServer as createHttpServer } from "node:http";
import { readFileSync } from "node:fs";
```

(b) 在 `HOURLY_THRESHOLD_MS` 之后加白名单与归一化函数：

```js
// 面板静态文件白名单。只认识这三个路径，所以不存在路径穿越需要防 ——
// 不写通用静态服务器。文件名相对本模块解析，因此从任何 cwd 启动都能找到。
const PUBLIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/dashboard.js", ["dashboard.js", "text/javascript; charset=utf-8"]],
]);

/** 去掉尾部斜杠。静态白名单与下面的路由表共用同一套归一化规则。 */
export function normalizePath(pathname) {
  return pathname.replace(/\/+$/, "") || "/";
}
```

(c) `handle()` 的第一行改为复用同一个归一化函数（原本内联了同样的表达式）：

```js
function handle({ url, send, store, config, healthSnapshot }) {
  const path = normalizePath(url.pathname);
  const query = url.searchParams;
```

(d) 在 `createServer` 里，**方法校验之后、bearer 校验之前**插入静态分支：

```js
    if (request.method !== "GET") {
      send(405, { error: `只支持 GET，收到 ${request.method}` });
      return;
    }

    // 面板静态文件：在 bearer 校验之**前**处理 —— 否则配了令牌的人连页面都拿不到，
    // 也就没机会把令牌交给页面。页面本身不含任何密钥，数据仍受令牌保护。
    const asset = PUBLIC_FILES.get(normalizePath(url.pathname));
    if (asset) {
      const [file, contentType] = asset;
      try {
        // 每次请求都读盘，不做内存缓存：面板一天开不了几次，
        // 换来的是改完 HTML 刷新即可生效、不用重启服务。
        const body = readFileSync(new URL(`../public/${file}`, import.meta.url));
        response.writeHead(200, { ...headers, "Content-Type": contentType });
        response.end(body);
      } catch (error) {
        logger.error(`[server] 读取面板文件失败 ${file}: ${error?.message ?? error}`);
        send(500, { error: "面板文件不可读" });
      }
      return;
    }

    if (config.server.bearerToken) {
```

- [x] **Step 5: 跑测试确认通过**

Run: `npm test`
Expected: PASS —— 新增 6 个静态路由用例（另更新 1 条既有用例），总数 **221**，输出干净（已在写计划时应用全部改动预跑验证过：修复前 220/221，修复后全绿）

- [x] **Step 6: 确认既有行为没被改坏，并且页面真的能打开**

```bash
npm start &
curl -s localhost:8787/ | head -3           # 应看到 <!DOCTYPE html> 与标题
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' localhost:8787/dashboard.js
curl -s localhost:8787/health | head -c 200 # 应与改动前逐字一致
kill -INT %1
```

Expected：`/` 返回面板 HTML；`/dashboard.js` 返回 `200 text/javascript`；`/health` 的 JSON 与改动前完全一致。特别是 `handle()` 里那一行归一化改动**必须**保持 `/health/` 仍能路由（既有用例「带尾斜杠的路径也能匹配」覆盖了这一点）。若库里还没数据，页面应显示「等一轮」的空态而不是报错或白屏。

- [x] **Step 7: 提交**

```bash
git add src/server.js test/server.test.js
git commit -m "feat: 静态文件白名单路由，bearer 之前放行面板"
```

---

### Task 4: README 与端到端验收

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: 前面三个 Task 的全部产物
- Produces: 给运维的「面板」一节与手工冒烟清单

- [x] **Step 1: 在 `README.md` 里加「面板」一节**

放在 API 端点表之后。内容必须包含：

- 怎么打开：服务起来后浏览器访问 `http://<host>:8787/`（与 API 同源，无需额外部署）
- 三个静态路径：`/`、`/index.html`、`/dashboard.js`；强调只有这三个，其余仍 404
- **每列的含义**：状态取服务端判定（`正常`/`偏离`/`失败`/`未知`）；偏离是「相对近 1 小时中位数」的百分比，**与告警判定用同一个数**；带 `*` 表示窗口内样本不足 5 条，此时服务端不会判定偏离，数字仅供参考
- **红不等于你配错了**：`error` 状态通常来自对手方（`No liquidity available`、临时最低额 `limits`、`Internal server error`），几小时内会变。备注列显示的是对方返回的原文
- 刷新节奏：每 30 秒；页面隐藏时暂停；服务不可达时指数退避到 2 分钟封顶，并**保留上一次的数据**但标注陈旧
- 配了 `server.bearerToken` 时：页面会弹出令牌输入框，令牌存在浏览器 localStorage，静态页面本身不校验令牌
- 阈值来源：页面不持有 `detect.priceDeviationPct`，顶栏「阈值 10%（服务端配置）」是展示文案；**改配置后页面不需要改**

- [x] **Step 2: 在 README 的冒烟清单里加面板条目**

沿用既有「手工冒烟」的写法，加一段：

```markdown
面板冒烟（改过 public/ 或 src/server.js 后跑一遍）：

1. `npm start`，浏览器打开 `http://127.0.0.1:8787/`
2. 顶栏计数与 `curl -s localhost:8787/latest | jq '[.latest[].stateStatus] | group_by(.) | map({(.[0]): length}) | add'` 对得上
3. 状态是 error 的行，备注里应显示对方返回的原文（如 `Internal server error`），不是「未知错误」
4. 点任意一行应展开详情（correlationId / minAmountOut / 连续失败…），再点收起
5. 「仅异常」勾上后只留非 ok 的行；选一条链后只剩涉及它的币对；搜索框输入 `zec` 应能筛出 zec 相关
6. `kill -INT` 停掉服务，等 30 秒，页面应显示「服务不可达（已重试 N 次）」**且表格不清空**
7. 重新 `npm start`，约 30 秒内页面应自行恢复
```

- [x] **Step 3: 端到端手工验收（唯一需要人眼的一步）**

```bash
npm start
# 另开一个终端：浏览器打开 http://127.0.0.1:8787/
```

逐条核对上面的 7 条冒烟项，并对照 `data/monitor.db` 里的真实数据确认：

- 状态分布应与库里一致（写这份计划时是 33 正常 / 5 失败）
- 5 条红对的备注必须是对方原文
- 美元列与 `amountInUsd` 数量级一致
- 偏离列带 `*` 的行，其 `okN` 确实小于 5

- [x] **Step 4: 跑全量测试**

Run: `npm test`
Expected: PASS —— **221** 个用例全过，输出干净

- [x] **Step 5: 提交**

```bash
git add README.md
git commit -m "docs: README 补面板一节与手工冒烟清单"
```

---

## 完成后的状态

- `npm start` 后浏览器打开 `http://<host>:8787/` 即得面板：38 对的当前状态、成交价、USD、偏离、延迟、最后报价与对方原文错误
- `npm test` **221** 个用例全绿，其中 31 个覆盖页面全部算术与排序、4 个静态钉住 DOM 契约、6 个覆盖静态路由、其余 180 个是后端既有用例
- 后端只多了 `PUBLIC_FILES` 一张白名单与 `normalizePath` 一个导出；`/health` 等既有端点的行为逐字未变
- 零新增依赖：前端是原生 ES 模块，没有构建步骤，`package.json` 未被改动
