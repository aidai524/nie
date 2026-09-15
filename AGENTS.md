# 项目约定

## 设计系统（改任何界面之前先读）

本项目的界面遵循 **`design/clickhouse/DESIGN.md`** —— 取自 [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md)
的 ClickHouse 设计语言分析（一份纯 Markdown 规范，无依赖、无构建步骤）。

**改 `public/` 下任何东西之前，先读那份规范**，并遵守它的护栏：

- **画布是近纯黑 `#0a0a0a`**，深度只来自「画布 vs `surface-card` `#1a1a1a`」的微妙差 —— **不用投影**
  （规范原文：*The system uses no drop shadows*）。边框一律 1px `hairline #2a2a2a`。
- **黄色 `#faff69` 只用于两处**：主操作按钮、以及统计数字（`stat-callout`）。
  规范原文：*Reserve primary (yellow) for primary CTAs, stat-callout numbers, and full-bleed yellow CTA bands.*
  **不许把黄用于正文、也不许用它做大面积填充**。
- **不许引入第二个品牌色**。绿/黄/红三个语义色（`success #22c55e` / `warning #f59e0b` / `error #ef4444`）
  是规范明确留给**产品 UI 状态指示**的，表格里的状态色属于规范内用法。
- **圆角分级**：按钮 8px（`rounded.md`）、内容卡 12px（`rounded.lg`）、
  **药丸圆角只给小徽章**（不许用在按钮上）。
- **字体**：Inter（700 用于标题、600 用于按钮、400 用于正文）；数字与代码用 JetBrains Mono（14/400）。
  Inter 的字重 700 必须配 **-1 ~ -2.5px 负字距**，否则「读起来太宽」。本项目**不外链 webfont**，
  用规范自己给出的回退栈。
- **相邻两个色带不能是同一种表面**。

所有色值以 CSS 变量形式写在 `public/index.html` 的 `:root` 里，变量名与规范的 YAML 键一一对应，
便于逐条回溯核对。**不要内联十六进制色值。**

规范没有覆盖的部分（它自己的 `Known Gaps` 承认：实际的查询控制台、监控面板、表格浏览器超出它的范围）
由我们在同一套令牌内推导，并已在 `public/index.html` 的 CSS 顶部注释里逐项标明哪些是推导。
新增推导的组件时，同样在那里记一笔。

## 界面文案

- 用户可见文字一律**中文**；标识符、类名、元素 id、字段名一律**英文**。
- 不要 emoji（Slack 消息里的 `:shortcode:` 除外）。
- **面板不能骗人**：写展示层之前先问「这个数字或符号会不会让人得出错误结论？」。
  这个项目已经因此返工两次 —— `-0.00%`（四舍五入到零却带负号）与「可按」列把「本次没测它」
  显示成 `—`（读作「都做不了」）。有疑问就补 tooltip 或改措辞。

## 改动的验证

- `npm test` 必须全绿（当前 281 个用例），且输出干净。
- **渲染层没有自动化测试**（零依赖、没有 DOM 测试框架）。唯一的自动化保护是
  `test/dashboard-dom.test.js`：它静态比对 `init()` 查询的每个 id 都存在于 `index.html`、
  表头是 10 列、tooltip 文案在位、没有内联事件处理器。
- 所以**改完 `public/` 必须按 README 末尾的冒烟清单手工过一遍**（9 条），
  重点是窄屏错位、展开曲线、以及 `depth.enabled: false` 时整列隐藏。

## 依赖

**零运行时依赖**，`package.json` 不得出现 `dependencies`/`devDependencies`。
只用 Node 内置模块（`node:sqlite`、`node:http`、`node:test`、`node:fs`、`node:path`、`node:url`）
与全局 `fetch`/`AbortController`。前端不引任何 npm 包、不加载外部资源。
