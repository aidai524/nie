import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 渲染层没有 DOM 测试框架（零依赖、无构建），所以这一层唯一的自动化保护就是
// 「静态比对":  markup 与脚本的约定是否还对得上。
//
// 它拦的是最可能出的那类错：init() 里写了个不存在的 id（静默拿到 null）、
// 加了列却忘了改表头、改样式时把关键类名改掉。它**不**证明渲染正确 —— 那要靠手工冒烟。

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const js = readFileSync(new URL("../public/dashboard.js", import.meta.url), "utf8");

test("init() 查询的每个元素 id 都存在于 index.html", () => {
  const ids = [...js.matchAll(/getElementById\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.ok(ids.length >= 20, `只找到 ${ids.length} 个 id，正则或 init() 可能改了`);
  for (const id of ids) {
    assert.ok(html.includes(`id="${id}"`), `index.html 里缺少 id="${id}"`);
  }
});

test("index.html 以模块方式加载 /dashboard.js 并调用 init()", () => {
  assert.match(html, /<script type="module">/);
  assert.ok(html.includes('from "/dashboard.js"'));
  assert.ok(html.includes("init()"));
});

test("沿用参考 UI 的外壳结构", () => {
  for (const className of ["dashboard-shell", "topbar", "brand", "brand-mark", "eyebrow",
    "overview", "headline", "freshness", "stats", "stat", "toolbar", "search-label",
    "select-label", "issue-toggle", "result-count", "legend", "table-card", "table-scroll"]) {
    assert.ok(html.includes(`class="${className}"`) || html.includes(`"${className}`) || html.includes(` ${className}`),
      `缺少参考 UI 的结构类名 ${className}`);
  }
});

test("表头是 9 列，且顺序与参考 UI 一致（备注列已去掉，失败原因改挂在状态徽章上）", () => {
  const headers = [...html.matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map((match) => match[1]);
  assert.deepEqual(headers,
    ["币对", "状态", "付 → 得", "USD", "成本", "较基准", "可按", "延迟", "最后报价"]);
  assert.ok(!headers.includes("备注"), "备注列已去掉");
});

test("三个口径有可见说明（比 tooltip 更强的可达性要求）", () => {
  // 参考 UI 用一条常驻的 .legend 解释三个列，而不是只给 title 属性 ——
  // title 在触屏与键盘上读不到，这是本项目此前明确未满足的无障碍需求。
  const legend = html.match(/<p class="legend">([^<]*)<\/p>/);
  assert.ok(legend, "缺少 .legend");
  for (const term of ["成本", "较基准", "可按"]) {
    assert.ok(legend[1].includes(term), `图例里没有解释「${term}」`);
  }
});

test("「可按」列带上可整列隐藏的类名与规则", () => {
  assert.ok(html.includes('class="depth-col"'), "表头要能整列隐藏");
  assert.ok(html.includes(".no-depth .depth-col"), "缺少关闭深度扫描时隐藏整列的规则");
  assert.ok(html.includes("hide-medium"), "窄屏丢列用的类名");
});

test("index.html 没有内联事件处理器（CSP 友好，也避免注入面）", () => {
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
});

test("可展开的行按参考 UI 做成键盘可达", () => {
  // 参考 UI 的行是 role=button + tabindex + aria-expanded + Enter/Space。
  // 少了这三样，下钻就只能用鼠标 —— 这是此前的无障碍缺口。
  assert.ok(js.includes('setAttribute("role", "button")'), "行缺少 role=button");
  assert.ok(js.includes('setAttribute("tabindex", "0")'), "行缺少 tabindex");
  assert.ok(js.includes('setAttribute("aria-expanded"'), "行缺少 aria-expanded");
  assert.ok(js.includes('event.key === "Enter"'), "行缺少 Enter 键处理");
  assert.ok(js.includes("is-expanded"), "展开态缺少 is-expanded 类");
});
