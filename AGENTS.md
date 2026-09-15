# 项目约定

## 设计系统（改任何界面之前先读）

面板的视觉语言取自一份 **v0 生成的参考 UI**（原文件 `ui/app/globals.css` + `ui/app/page.tsx`），
**已零依赖移植进 `public/index.html`**。移植做法与必须守住的东西：

- 去掉了 3 行 Tailwind `@import` 与 `@theme` 块；其余 **44 个自定义类名与 13 个 CSS 变量原样保留**。
  **不要引入 Tailwind 或任何构建步骤** —— 这份样式表本身不依赖它们（无工具类、无 `@apply`）。
- **现在唯一的事实来源是 `public/index.html` 的 `<style>`**。要改样式就在那里改。
  `design/clickhouse/` 是上一版设计系统，**已弃用，仅存档**。
- 主题是**浅色**（`--background:#f4f5f0`，`color-scheme:light`）。
- 令牌在 `:root` 定义；规则内仍有若干字面量色值（状态徽章、表头、悬停行）—— 它们是这套系统的一部分，
  已在 `test/contrast.test.js` 的白名单里登记。**不要新增规范外的色值。**
- **不用投影做层级**：`box-shadow` 只允许 `inset`（参考 UI 用它做复选框的内填充）。
- **状态不只靠颜色**：徽章带中文文字（正常 / 偏离 / 失败 / 未报价）。
- 参考 UI 自带的 **5 处不达 WCAG AA** 的取值已在移植时压暗修正（保持色相）：
  `--muted` → `#636963`、`--red` → `#b03830`、placeholder 与分隔符改用 `var(--muted)`。
  **不要改回去** —— `test/contrast.test.js` 会失败。
- 参考 UI 的可达性做法必须保留：行是 `role="button"` + `tabindex` + `aria-expanded` + Enter/Space；
  全局 `:focus-visible`；`.sr-only` 表单标签；**常驻的 `.legend`** 解释三个口径
  （不用 `title` —— 那在触屏与键盘上读不到）。

`public/index.html` 的 `<style>` 末尾有注释标明哪些规则是**参考 UI 没有、由本项目推导**的
（服务不可达 / 空库 / 需要令牌 / 深度关闭 / 未报价统计项 —— 参考 UI 是静态原型，没有这些运行态）。
新增推导的组件时同样在那里记一笔，并且只用已登记的令牌。

## 需求清单

`docs/ui-requirements.md` 是**面板 UI 的需求清单**，每条都有编号（D/S/ST/I/V/RSP/A11Y/P/C）与验证方式。
改界面时用它做自检，写 review 时直接引编号。

其中 **§4 语义需求与 §12 已知缺口**最值得先看 —— 前者是两份真实事故换来的「不许说什么」，
后者明确列着当前未满足的需求（展开行的键盘可达性、焦点样式、列说明的可达性）。

## 界面文案

- 用户可见文字一律**中文**；标识符、类名、元素 id、字段名一律**英文**。
- **例外**：参考 UI 的三个大写英文标签是它的风格装置，保留原样 —— 顶栏的 `ROUTE OBSERVABILITY`、
  概览区的 `QUOTATION HEALTH`、以及状态点的 `API ONLINE` / `API OFFLINE`。
  除这三处之外不要新增英文界面文案（失败详情里对方返回的原文当然要原样透出）。
- 不要 emoji（Slack 消息里的 `:shortcode:` 除外）。
- **面板不能骗人**：写展示层之前先问「这个数字或符号会不会让人得出错误结论？」。
  这个项目已经因此返工两次 —— `-0.00%`（四舍五入到零却带负号）与「可按」列把「本次没测它」
  显示成 `—`（读作「都做不了」）。有疑问就补 tooltip 或改措辞。

## 改动的验证

- `npm test` 必须全绿（当前 **325** 个用例），且输出干净。
- 渲染层有三层自动化保护：
  - `test/dashboard-render.test.js` —— **假 DOM**：跑真实 `init()` 并断言它**实际生成的标记**
    （排序、币对两行的源链/目标链、状态徽章与失败原因、9 列对齐、展开详情、独立分块的档位、键盘可达属性）。
    它证明的是「生成逻辑对不对」，**不**证明 CSS 生效与真实交互 —— 那些仍要人眼。
  - `test/dashboard-dom.test.js` —— 静态比对 `init()` 的 id 都在 HTML 里、表头 9 列、图例在位。
  - `test/contrast.test.js` —— 把可量化的部分钉住（对比度、无投影、无规范外色值、不外链资源）。
- 所以**改完 `public/` 必须按 README 末尾的冒烟清单手工过一遍**（9 条），
  重点是窄屏错位、展开曲线、以及 `depth.enabled: false` 时整列隐藏。

## 依赖

**零运行时依赖**，`package.json` 不得出现 `dependencies`/`devDependencies`。
只用 Node 内置模块（`node:sqlite`、`node:http`、`node:test`、`node:fs`、`node:path`、`node:url`）
与全局 `fetch`/`AbortController`。前端不引任何 npm 包、不加载外部资源。
