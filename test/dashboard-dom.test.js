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
  for (const header of ["币对", "状态", "付 → 得", "成本", "USD", "较基准", "延迟", "最后报价", "备注"]) {
    assert.ok(html.includes(`>${header}<`), `表头缺少「${header}」`);
  }
});

test("index.html 没有内联事件处理器（CSP 友好，也避免注入面）", () => {
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
});

test("两个容易误读的列名带上解释性 tooltip", () => {
  assert.ok(html.includes("相对近 1 小时成功报价中位数"), "「较基准」必须说明它在跟什么比");
  assert.ok(html.includes("按美元计价"), "「成本」必须说明口径 —— 否则会被读成付/得之差");
});
