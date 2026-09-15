import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { init } from "../public/dashboard.js";

// 极简 DOM 替身：目的是跑通真实的 init() 并把**它实际生成的标记**导出来。
//
// 为什么值得写：渲染层（init()）是唯一没有自动化测试的部分，而项目已经因为
// 「以为渲染成这样、其实不是」返工过几次。有了它，行 / 状态徽章 / 展开详情的标记可以被断言钉住，
// 不必只靠人眼。它**不**验证浏览器行为（CSS 生效、布局、真实点击），那仍需手工冒烟。

class FakeText {
  constructor(text) { this.nodeType = "text"; this.text = String(text); }
}

class FakeNode {
  constructor(tag) {
    this.nodeType = "element";
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.attributes = {};
    this.listeners = {};
    this.dataset = {};
    this.className = "";
    this.title = "";
    this.hidden = false;
    this._text = "";
    this.parentNode = null;
    const self = this;
    this.classList = {
      add: (...names) => { self.className = [...new Set([...self.className.split(" ").filter(Boolean), ...names])].join(" "); },
      remove: (...names) => { self.className = self.className.split(" ").filter((n) => n && !names.includes(n)).join(" "); },
      contains: (name) => self.className.split(" ").includes(name),
      toggle: (name, force) => {
        const has = self.className.split(" ").includes(name);
        const want = force === undefined ? !has : Boolean(force);
        if (want && !has) self.classList.add(name);
        if (!want && has) self.classList.remove(name);
      },
    };
  }
  get textContent() {
    const fromChildren = this.childNodes
      .map((child) => (child.nodeType === "text" ? child.text : child.textContent)).join("");
    return fromChildren || this._text;
  }
  set textContent(value) { this.childNodes = []; this._text = String(value ?? ""); }
  get children() { return this.childNodes.filter((child) => child.nodeType === "element"); }
  append(...nodes) {
    for (const node of nodes) {
      const child = node instanceof FakeNode || node instanceof FakeText ? node : new FakeText(node);
      child.parentNode = this;
      this.childNodes.push(child);
    }
  }
  replaceChildren(...nodes) { this.childNodes = []; this.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  // 页面用 `td.colSpan = 9` 赋值（属性，不是 setAttribute）；真实 DOM 会反射成属性
  get colSpan() { return this.attributes.colspan ?? null; }
  set colSpan(value) { this.attributes.colspan = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler); }
  after(node) {
    if (this.parentNode === null) return;
    node.parentNode = this.parentNode;
    this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this) + 1, 0, node);
  }
  remove() {
    if (this.parentNode === null) return;
    this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
    this.parentNode = null;
  }
  /** init() 只用了这一种选择器 */
  querySelector(selector) {
    const match = /^tr\[data-detail="(.*)"\]$/.exec(selector);
    if (match === null) throw new Error(`假 DOM 不支持选择器: ${selector}`);
    return this.children.find((child) => child.dataset.detail === match[1]) ?? null;
  }
}

const escapeHtml = (value) => String(value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function toHtml(node) {
  if (node.nodeType === "text") return escapeHtml(node.text);
  const parts = [];
  if (node.className) parts.push(` class="${escapeHtml(node.className)}"`);
  for (const [name, value] of Object.entries(node.attributes)) parts.push(` ${name}="${escapeHtml(value)}"`);
  if (node.title) parts.push(` title="${escapeHtml(node.title)}"`);
  if (node.hidden) parts.push(" hidden");
  const tag = node.tagName.toLowerCase();
  // 没有子节点时要输出 textContent 设过的文本；有子节点时子节点优先
  const inner = node.childNodes.length > 0
    ? node.childNodes.map(toHtml).join("")
    : escapeHtml(node._text);
  return `<${tag}${parts.join("")}>${inner}</${tag}>`;
}

// —— 与真实接口同形状的假数据 ——
const PAIRS = {
  pairs: [
    { id: "pol:USDC>near:USDC", label: "pol:USDC → near:USDC", fromKey: "pol:USDC", toKey: "near:USDC",
      fromDecimals: 6, toDecimals: 6, swapType: "EXACT_OUTPUT", amount: "1500" },
    { id: "near:USDC>tron:USDT", label: "near:USDC → tron:USDT", fromKey: "near:USDC", toKey: "tron:USDT",
      fromDecimals: 6, toDecimals: 6, swapType: "EXACT_OUTPUT", amount: "1500" },
  ],
};
const LATEST = {
  latest: [
    { pairId: "pol:USDC>near:USDC", ts: "2026-09-15T06:00:00.000Z", ok: true, httpStatus: 201, latencyMs: 1500,
      amountIn: "1501960000", amountOut: "1500000000", amountInUsd: "1501.50", amountOutUsd: "1500.00",
      minAmountOut: "1500000000", timeEstimate: 27, correlationId: "q_abc", errorCode: null, errorMessage: null,
      stateStatus: "ok", stateSince: "2026-09-15T06:00:00.000Z", stateFailures: 0 },
    { pairId: "near:USDC>tron:USDT", ts: "2026-09-15T06:00:00.000Z", ok: false, httpStatus: 400, latencyMs: 900,
      amountIn: null, amountOut: null, amountInUsd: null, amountOutUsd: null, minAmountOut: null,
      timeEstimate: null, correlationId: "q_def", errorCode: "http_4xx", errorMessage: "Internal server error",
      stateStatus: "error", stateSince: "2026-09-15T05:00:00.000Z", stateFailures: 3 },
  ],
};
const STATS = { window: "1h", since: "x", resolution: "raw",
  pairs: [{ pairId: "pol:USDC>near:USDC", n: 10, okN: 10, okRate: 1, metric: { median: 1501960000 }, latency: {} }] };
const HEALTH = { ok: true, startedAt: "x", lastRoundTs: "2026-09-15T06:00:00.000Z", lastRoundAgeMs: 500,
  lastRoundDurationMs: 14000, consecutiveRoundErrors: 0, pairs: 2, dbBytes: 1 };
const DEPTH = { enabled: true, ts: "2026-09-15T06:00:00.000Z", tiers: [100, 1000, 1000000],
  rows: [
    { pairId: "pol:USDC>near:USDC", tierUsd: 100, ok: true, amountInUsd: "100.41", amountOutUsd: "100.00" },
    { pairId: "pol:USDC>near:USDC", tierUsd: 1000, ok: true, amountInUsd: "1001.40", amountOutUsd: "1000.00" },
    { pairId: "pol:USDC>near:USDC", tierUsd: 1000000, ok: false, errorCode: "http_4xx", errorMessage: "No liquidity available" },
  ],
};

/** 装上假全局并跑一轮 init()，返回 elements 与 restore()。
    调用方必须 try/finally 调 restore() —— 全局被改坏会污染同进程的其他测试文件。 */
async function mountPage() {
  const real = { document: globalThis.document, fetch: globalThis.fetch, localStorage: globalThis.localStorage,
    setInterval: globalThis.setInterval, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const elements = new Map();
  for (const id of ["count-ok", "count-deviant", "count-error", "count-unknown", "stat-none", "live-dot",
    "api-state", "fresh-dot", "freshness", "next-refresh", "banner", "tbody", "empty", "shown-count",
    "only-problems", "chain-select", "search", "refresh", "token-box", "token-input", "token-save", "table"]) {
    elements.set(id, new FakeNode("div"));
  }
  globalThis.document = {
    visibilityState: "visible",
    getElementById: (id) => elements.get(id) ?? null,
    createElement: (tag) => new FakeNode(tag),
    addEventListener: () => {},
  };
  globalThis.fetch = async (path) => {
    const payload = path === "/pairs" ? PAIRS : path === "/latest" ? LATEST
      : path === "/stats?window=1h" ? STATS : path === "/health" ? HEALTH : path === "/depth" ? DEPTH : null;
    return { ok: true, status: 200, json: async () => payload };
  };
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  // 定时器置空：schedule() 会挂 30 秒的 setTimeout，real 定时器会让测试进程一直不退出
  globalThis.setInterval = () => 0;
  globalThis.setTimeout = () => 0;
  globalThis.clearTimeout = () => {};

  const restore = () => Object.assign(globalThis, real);
  try {
    init();
    for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
  } catch (error) {
    restore();
    throw error;
  }
  return { elements, restore };
}

const headers = () => [...readFileSync(new URL("../public/index.html", import.meta.url), "utf8")
  .matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map((match) => match[1]);

test("行：排序后失败在前；第二行给源链与目标链；状态带失败原因", async () => {
  const { elements, restore } = await mountPage();
  try {
    const tbody = elements.get("tbody");
    assert.equal(tbody.children.length, 2, "两对币对应生成两行");

    // 按内容定位而不是按下标 —— 行是按状态排过序的（失败优先，这是需求 I8）
    const rows = tbody.children.map((row) => ({ row, html: toHtml(row) }));
    assert.ok(rows[0].html.includes("tron:USDT"), "失败的行应排在最前");
    const okRow = rows.find((entry) => entry.html.includes("pol:USDC"));
    const failRow = rows.find((entry) => entry.html.includes("tron:USDT"));

    assert.ok(okRow.html.includes("<strong>pol:USDC</strong>"), okRow.html.slice(0, 220));
    assert.ok(okRow.html.includes('class="arrow">→</span>'), "主行要有箭头");
    assert.ok(okRow.html.includes("<strong>near:USDC</strong>"));
    assert.ok(okRow.html.includes("<small>源链 pol · 目标链 near</small>"), "第二行要同时给源链与目标链");
    assert.ok(failRow.html.includes("<small>源链 near · 目标链 tron</small>"));

    assert.ok(okRow.html.includes('class="status status-正常">正常</span>'));
    assert.ok(failRow.html.includes('class="status status-失败">失败</span>'));
    assert.ok(failRow.html.includes('title="http_4xx — Internal server error"'), "失败原因挂在状态徽章上");
    assert.ok(!okRow.html.includes("title=\"http_4xx"), "正常的行不该带失败原因");

    assert.equal(okRow.row.children.length, headers().length,
      `行的单元格数（${okRow.row.children.length}）应与表头（${headers().length}）一致`);

    assert.equal(okRow.row.getAttribute("role"), "button");
    assert.equal(okRow.row.getAttribute("tabindex"), "0");
    assert.equal(okRow.row.getAttribute("aria-expanded"), "false");
  } finally { restore(); }
});

test("表头是 9 列，且已没有备注列", async () => {
  const list = headers();
  assert.equal(list.length, 9);
  assert.deepEqual(list, ["币对", "状态", "付 → 得", "USD", "成本", "较基准", "可按", "延迟", "最后报价"]);
  assert.ok(!list.includes("备注"));
});

test("展开：可通行给独立分块的档位；失败行给占满一行的失败原文", async () => {
  const { elements, restore } = await mountPage();
  try {
    const tbody = elements.get("tbody");
    const findRow = (needle) => tbody.children.find((row) => toHtml(row).includes(needle));
    const okRow = findRow("pol:USDC");
    const failRow = findRow("tron:USDT");
    assert.ok(okRow && failRow, "应能按内容找到两行");

    okRow.listeners.click[0]();
    const detail = okRow.parentNode.children[okRow.parentNode.children.indexOf(okRow) + 1];
    assert.equal(detail.className, "detail-row");
    assert.equal(detail.children[0].getAttribute("colspan"), "9", "详情跨 9 列");
    assert.equal(okRow.getAttribute("aria-expanded"), "true");
    assert.ok(okRow.className.includes("is-expanded"));
    const detailHtml = toHtml(detail);
    assert.ok(detailHtml.includes("<span>深度扫描 / 3 档</span>"));
    assert.equal((detailHtml.match(/class="tier /g) ?? []).length, 3, "三个档位要是三个独立块");
    assert.ok(detailHtml.includes('class="tier is-ok"><b>$100</b><small>可通 · 0.41%</small>'),
      "档位要独立成块，而不是拼成一行文本");
    // 失败档位还带 title（完整原因），所以中间可能夹着属性 —— 不要写死相邻
    assert.ok(/class="tier is-bad"[^>]*><b>\$1M<\/b><small>不通 · No liquidity available<\/small>/.test(detailHtml));

    okRow.listeners.click[0]();   // 收起
    assert.equal(tbody.children.length, 2, "收起后详情行应被移除");
    assert.equal(okRow.getAttribute("aria-expanded"), "false");

    failRow.listeners.click[0]();
    const failDetail = failRow.parentNode.children[failRow.parentNode.children.indexOf(failRow) + 1];
    const failDetailHtml = toHtml(failDetail);
    assert.ok(failDetailHtml.includes('class="failure-detail"'), "失败原文要占满一行");
    assert.ok(failDetailHtml.includes("<span>失败原文</span><b>http_4xx — Internal server error</b>"),
      "失败原文要在详情里可见 —— 只靠 title 的话触屏与键盘读不到");
  } finally { restore(); }
});

test("统计数字、计数与新鲜度行按参考 UI 的值域渲染", async () => {
  const { elements, restore } = await mountPage();
  try {
    assert.equal(elements.get("count-ok").textContent, "1");
    assert.equal(elements.get("count-deviant").textContent, "0");
    assert.equal(elements.get("count-error").textContent, "1");
    assert.equal(elements.get("count-unknown").textContent, "0");
    assert.equal(elements.get("stat-none").hidden, true, "未报价为 0 时不占位");
    assert.equal(elements.get("shown-count").textContent, "2 / 2 对");
    assert.ok(elements.get("freshness").textContent.startsWith("最后更新"));
    assert.equal(elements.get("api-state").textContent, "API ONLINE");
  } finally { restore(); }
});
