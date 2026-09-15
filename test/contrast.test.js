import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 对比度是设计系统里唯一可以量化验收的部分，所以把它钉成测试而不是靠人眼。
//
// 关键：**断言必须针对样式里实际使用的令牌**，不能针对「我打算用的」令牌 ——
// 后者对新旧代码都通过，等于没测（这个坑我在写这个文件时先踩了一次）。
// 所以凡是背景由 CSS 规则决定的角色，都从那条规则里把令牌名读出来再算对比度。

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const rootBlock = css.match(/:root\s*\{([\s\S]*?)\n {4}\}/)[1];

const tokens = {};
for (const [, name, hex] of rootBlock.matchAll(/--color-([a-z-]+):\s*(#[0-9A-Fa-f]{6})/g)) {
  tokens[name] = hex;
}

const channel = (value) => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
  const [r, g, b] = hex.replace("#", "").match(/../g).map((x) => Number.parseInt(x, 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const contrast = (fg, bg) => {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

/** 从某条 CSS 规则里读出它实际用的 color / background 令牌名 */
function rule(selectorPattern) {
  const block = css.match(selectorPattern);
  assert.ok(block, `找不到规则: ${selectorPattern}`);
  const body = block[1];
  return {
    color: body.match(/(?:^|\s)color:\s*var\(--color-([a-z-]+)\)/)?.[1] ?? null,
    background: body.match(/background(?:-color)?:\s*var\(--color-([a-z-]+)\)/)?.[1] ?? null,
    borderColor: body.match(/border(?:-color)?:\s*1px solid var\(--color-([a-z-]+)\)/)?.[1] ?? null,
  };
}

// —— 背景固定的角色：直接声明 前景/背景 令牌对 ——
const FIXED_PAIRS = [
  ["标题", "on-dark", "canvas", 3],
  ["正文", "body", "canvas", 4.5],
  ["顶栏状态行", "muted", "canvas", 4.5],
  ["统计数字（56px 大字）", "primary", "canvas", 3],
  ["主按钮", "on-primary", "primary", 4.5],
  ["表头", "muted", "surface-card", 4.5],
  ["数字单元格", "body-strong", "surface-card", 4.5],
  ["USD / 最后报价列", "muted", "surface-card", 4.5],
  ["状态徽章：正常", "success", "surface-card", 4.5],
  ["状态徽章：偏离", "warning", "surface-card", 4.5],
  ["状态徽章：失败", "error", "surface-card", 4.5],
  ["提示条：错误", "error", "surface-card", 4.5],
  ["提示条：警告", "warning", "surface-card", 4.5],
  ["展开详情：字段名", "on-dark", "surface-card", 4.5],
];

for (const [label, fg, bg, minimum] of FIXED_PAIRS) {
  test(`对比度达 AA：${label}`, () => {
    assert.ok(tokens[fg] !== undefined, `缺少令牌 ${fg}`);
    assert.ok(tokens[bg] !== undefined, `缺少令牌 ${bg}`);
    const ratio = contrast(tokens[fg], tokens[bg]);
    assert.ok(ratio >= minimum, `${label} 对比度 ${ratio.toFixed(2)} < ${minimum}（${tokens[fg]} on ${tokens[bg]}）`);
  });
}

// —— 背景由 CSS 规则决定的角色：从规则里读出来再算 ——
// 这几条才是真正会随样式改动而失效的断言。
const RULE_PAIRS = [
  ["次要提示（阈值、显示对数）", () => rule(/\.hint\s*\{([^}]*)\}/).color, "canvas", 4.5],
  ["降饱和的偏离值", () => rule(/td\.dev\.muted\s*\{([^}]*)\}/).color, "surface-card", 4.5],
  ["可点行 hover 背景上的数字", "body-strong", () => rule(/tr\.row\.clickable:hover\s*\{([^}]*)\}/).background, 4.5],
  ["可点行 hover 背景上的次要列", "muted", () => rule(/tr\.row\.clickable:hover\s*\{([^}]*)\}/).background, 4.5],
  ["可点行 hover 背景上的失败状态", "error", () => rule(/tr\.row\.clickable:hover\s*\{([^}]*)\}/).background, 4.5],
  ["展开详情正文", () => rule(/tr\.detail td\s*\{([^}]*)\}/).color, () => rule(/tr\.detail td\s*\{([^}]*)\}/).background, 4.5],
  ["档位曲线：可通", "success", () => rule(/tr\.detail td\s*\{([^}]*)\}/).background, 4.5],
  ["档位曲线：不通", "error", () => rule(/tr\.detail td\s*\{([^}]*)\}/).background, 4.5],
];

for (const [label, fgSpec, bgSpec, minimum] of RULE_PAIRS) {
  test(`对比度达 AA：${label}`, () => {
    const fgName = typeof fgSpec === "function" ? fgSpec() : fgSpec;
    const bgName = typeof bgSpec === "function" ? bgSpec() : bgSpec;
    assert.ok(fgName, `${label} 取不到前景令牌`);
    assert.ok(bgName, `${label} 取不到背景令牌`);
    assert.ok(tokens[fgName] !== undefined, `缺少前景令牌 ${fgName}`);
    assert.ok(tokens[bgName] !== undefined, `缺少背景令牌 ${bgName}`);
    const ratio = contrast(tokens[fgName], tokens[bgName]);
    assert.ok(ratio >= minimum, `${label} 对比度 ${ratio.toFixed(2)} < ${minimum}（${tokens[fgName]} on ${tokens[bgName]}）`);
  });
}

test("页面不使用投影（设计规范：深度只来自 1px 边框）", () => {
  assert.doesNotMatch(css, /box-shadow\s*:(?!\s*none)/, "设计系统规定不用投影");
});

test("页面不引入设计系统之外的色值", () => {
  const allowed = new Set(["#faff69", "#e6eb52", "#3a3a1f", "#ffffff", "#cccccc", "#e6e6e6",
    "#888888", "#5a5a5a", "#2a2a2a", "#3a3a3a", "#0a0a0a", "#121212", "#1a1a1a", "#242424",
    "#22c55e", "#ef4444", "#3b82f6", "#f59e0b"]);
  const used = [...new Set([...css.matchAll(/#([0-9A-Fa-f]{6})\b/g)].map((m) => `#${m[1].toLowerCase()}`))];
  const extra = used.filter((hex) => !allowed.has(hex));
  assert.deepEqual(extra, [], `出现了设计系统之外的色值: ${extra.join(", ")}`);
});

test("不外链任何资源（零依赖、离线可用）", () => {
  assert.doesNotMatch(html, /<link\b/i, "不应有外链样式或字体");
  assert.doesNotMatch(html, /@import/i, "不应有 CSS @import");
  assert.doesNotMatch(html, /https?:\/\//i, "不应引用外部 URL");
});
