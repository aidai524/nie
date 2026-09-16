import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 对比度是这个设计系统里唯一可以量化验收的部分，所以钉成测试而不是靠人眼。
//
// 三条经验（都是踩过坑之后写下的）：
//   1. 断言必须针对**样式里实际使用的**值，不能针对「我打算用的」值 —— 后者对新旧代码都通过，
//      等于没测。所以颜色写在 CSS 规则里的（状态徽章、表头、悬停行），一律从规则里读出来再算。
//   2. 提取色值前必须先剥掉注释，否则注释里写的「改前 → 改后」会把旧色值算成「仍在用」。
//   3. 每侧的来源要显式声明（令牌 or 某条规则），不要靠推断。
//
// 参考 UI（ui/app/globals.css）自带 5 处不达 AA，移植时做了最小压暗（保持色相）：
//   --muted #697069 → #636963、--red #b83b32 → #b03830，
//   搜索框 placeholder 与分隔符由字面量改用 var(--muted)。下面的断言按修正后的值验。

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1].replace(/\/\*[\s\S]*?\*\//g, "");

const tokens = {};
for (const [, name, hex] of css.match(/:root\s*\{([^}]*)\}/)[1].matchAll(/--([a-z-]+):\s*(#[0-9A-Fa-f]{6})/g)) {
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

/** 从某条规则里读一个属性，令牌或字面量都支持 */
function fromRule(pattern, property) {
  const match = css.match(pattern);
  assert.ok(match, `找不到规则: ${pattern}`);
  const found = match[1].match(new RegExp(`${property}:\\s*(?:var\\(--([a-z-]+)\\)|(#[0-9A-Fa-f]{6}))`));
  assert.ok(found, `规则 ${pattern} 里没有 ${property}`);
  return found[1] !== undefined ? tokens[found[1]] : found[2];
}

const token = (name) => {
  assert.ok(tokens[name] !== undefined, `缺少令牌 ${name}`);
  return tokens[name];
};

const HOVER_ROW = /tbody tr\[role="button"\]:hover[^{]*\{([^}]*)\}/;
// .detail-grid b 不设 color（继承自 body），所以它的前景用 foreground 令牌表示
const DETAIL_SPAN = /\.detail-grid span\s*\{([^}]*)\}/;
const STATUS = (label) => new RegExp(`\\.status-${label}\\s*\\{([^}]*)\\}`);

// [标签, 前景来源, 背景来源, AA 要求]
const PAIRS = [
  ["正文 / 页面背景", token("foreground"), token("background"), 4.5],
  ["正文 / 卡片", token("foreground"), token("surface"), 4.5],
  ["次要文字 / 页面背景", token("muted"), token("background"), 4.5],
  ["次要文字 / 卡片", token("muted"), token("surface"), 4.5],
  ["统计数字 / 页面背景", token("foreground"), token("background"), 4.5],
  ["失败统计数字 / 页面背景", token("red"), token("background"), 4.5],
  ["品牌标记（黄底黑字）", token("yellow"), token("foreground"), 3],
  ["刷新按钮（黑底浅字）", token("surface"), token("foreground"), 4.5],
  ["提示条：错误", token("red"), token("surface"), 4.5],
  ["提示条：警告", token("orange"), token("surface"), 4.5],
  ["令牌输入框", token("foreground"), token("background"), 4.5],

  ["表头", fromRule(/th\s*\{([^}]*)\}/, "color"), fromRule(/th\s*\{([^}]*)\}/, "background"), 4.5],
  ["徽章：正常", fromRule(STATUS("正常"), "color"), fromRule(STATUS("正常"), "background"), 4.5],
  ["徽章：偏离", fromRule(STATUS("偏离"), "color"), fromRule(STATUS("偏离"), "background"), 4.5],
  ["徽章：失败", fromRule(STATUS("失败"), "color"), fromRule(STATUS("失败"), "background"), 4.5],
  ["徽章：未报价", fromRule(STATUS("未报价"), "color"), fromRule(STATUS("未报价"), "background"), 4.5],
  ["较基准的偏离值", fromRule(/\.deviation\s*\{([^}]*)\}/, "color"), token("surface"), 4.5],
  ["详情里的失败原文", fromRule(/\.failure-detail b\s*\{([^}]*)\}/, "color"), fromRule(/\.detail-row td\s*\{([^}]*)\}/, "background"), 4.5],
  ["档位：可通", fromRule(/\.depth-detail \.tier\.is-ok b\s*\{([^}]*)\}/, "color"), token("background"), 4.5],
  ["档位：不通", fromRule(/\.depth-detail \.tier\.is-bad b\s*\{([^}]*)\}/, "color"), token("background"), 4.5],
  ["档位说明文字", fromRule(/\.depth-detail \.tier small\s*\{([^}]*)\}/, "color"), token("background"), 4.5],
  ["搜索占位符", fromRule(/\.search-label input::placeholder\s*\{([^}]*)\}/, "color"), token("surface"), 4.5],
  ["展开详情：正文", token("foreground"), fromRule(/\.detail-row td\s*\{([^}]*)\}/, "background"), 4.5],
  ["展开详情：标签", fromRule(DETAIL_SPAN, "color"), fromRule(/\.detail-row td\s*\{([^}]*)\}/, "background"), 4.5],
  ["悬停行上的正文", token("foreground"), fromRule(HOVER_ROW, "background"), 4.5],
  ["悬停行上的次要文字", token("muted"), fromRule(HOVER_ROW, "background"), 4.5],
  ["悬停行上的失败文字", token("red"), fromRule(HOVER_ROW, "background"), 4.5],
  ["悬停行上的偏离文字", fromRule(/\.deviation\s*\{([^}]*)\}/, "color"), fromRule(HOVER_ROW, "background"), 4.5],
  // 装饰性元素（分隔点、箭头）按「图形」标准 3:1
  ["分隔符（装饰）", fromRule(/\.separator\s*\{([^}]*)\}/, "color"), token("background"), 3],
  ["箭头（装饰）", fromRule(/\.arrow\s*\{([^}]*)\}/, "color"), token("surface"), 3],
];

for (const [label, fg, bg, minimum] of PAIRS) {
  test(`对比度达 AA：${label}`, () => {
    const ratio = contrast(fg, bg);
    assert.ok(ratio >= minimum, `${label} ${ratio.toFixed(2)} < ${minimum}（${fg} on ${bg}）`);
  });
}

test("不用投影做层级（允许复选框那种 inset 内填充）", () => {
  const dropShadows = [...css.matchAll(/box-shadow\s*:(?!\s*(?:inset|none))[^;}]*/g)].map((m) => m[0].trim());
  assert.deepEqual(dropShadows, [], `出现了投影: ${dropShadows.join(" | ")}`);
});

test("不引入设计系统之外的色值", () => {
  // 来源：ui/app/globals.css（含移植时的 4 处最小修正：--muted、--red，
  // 以及搜索框 placeholder 与分隔符由字面量改用 var(--muted)）。
  // 2026-09-16 视觉刷新重算了三个**表面**色值（锁 H=75 拉亮度台阶，见
  // docs/superpowers/specs/2026-09-16-dashboard-visual-refresh-design.md §4），
  // 所以下面这套值不再与参考 UI 逐字相同 —— 它是「本项目当前实际使用的色值集合」。
  const allowed = new Set(["#171917", "#286643", "#28724c", "#343a34", "#4d5424", "#636963",
    "#655f1c", "#856400", "#8c958a", "#9d641c", "#aeb5aa", "#b03830", "#d7dbd1", "#dcefe0",
    "#e4e7e1", "#e7ebdc", "#edf0e5", "#f0f2a5", "#f4d9d5", "#f4f5f0", "#f4f6f0", "#faff69",
    "#fbfcf8"]);
  const used = [...new Set([...css.matchAll(/#([0-9A-Fa-f]{6})\b/g)].map((m) => `#${m[1].toLowerCase()}`))];
  const extra = used.filter((hex) => !allowed.has(hex));
  assert.deepEqual(extra, [], `出现了设计系统之外的色值: ${extra.join(", ")}`);
});

test("不外链任何资源（零依赖、离线可用）", () => {
  assert.doesNotMatch(html, /<link\b/i, "不应有外链样式或字体");
  assert.doesNotMatch(html, /@import/i, "不应有 CSS @import");
  assert.doesNotMatch(html, /https?:\/\//i, "不应引用外部 URL");
});
