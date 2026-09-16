# 面板视觉刷新 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让面板的表面层次在真实屏幕上分得出来、让 9 列数字表的数字列能竖向比较、让键盘焦点框不被横向滚动容器裁掉 —— 全程不新增依赖、不改列、不改信息口径。

**Architecture:** 改动几乎全落在 `public/index.html` 的 `<style>` 里（那是设计系统的唯一事实来源）。唯一碰标记的是图例（§8，把一段长文本换成三个 `<span>`，不含新逻辑）。新增的推导规则写在 `<style>` 末尾那段「参考 UI 未覆盖、由本项目推导」的注释区里 —— 这是 `AGENTS.md` 规定的做法。可量化的部分（对比度、无投影、无规范外色值）由 `test/contrast.test.js` 钉住。

**Tech Stack:** 原生 HTML + 原生 CSS + 原生 ES 模块。零运行时依赖、无构建步骤、**不引入 Tailwind、不引入任何 npm 包**。测试用 `node:test`（Node ≥ 24）。

**Spec:** `docs/superpowers/specs/2026-09-16-dashboard-visual-refresh-design.md`

## Global Constraints

- **C1 零运行时依赖**：`package.json` 不得出现 `dependencies` / `devDependencies`。
- **C2 无构建步骤**：原生 ES 模块 + 原生 CSS，浏览器直接加载。
- **C3 不外链任何资源**：无 webfont、无 CDN、无 `@import`、无 `<link>`。
- **V1 色值全部取自已登记令牌**，不引入规范外颜色（由 `test/contrast.test.js` 的 allowlist 强制）。
- **V2 不用投影做层级**：`box-shadow` 只允许 `inset` 或 `none`。
- **V3 主题是浅色**：`color-scheme:light`，`--background:#f4f5f0` **不许动**。
- **V7 所有前景/背景组合达 WCAG AA**（正文 4.5，装饰性图形 3）。**一条阈值都不许放宽。**
- **C5 用户可见文字一律中文**，标识符/类名/元素 id 一律英文。
- **I10 所有来自 API 的文本用 `textContent` 写入，绝不用 `innerHTML`。**
- **不许改的东西**：`public/dashboard.js` 的纯函数区（本轮零改动）、9 列表头顺序、16 个元素 id、`test/dashboard-render.test.js` 的任何一条断言、`--background` / `--foreground` / `--muted` / `--red` / `--yellow` / `--orange` / `--green` / `--ring` / `--surface` / `--border` / `--radius` 这 11 个令牌。
- **用例数**：每个任务跑完都必须 `npm test` **全绿**。全仓用例数在 Task 1–6 全程保持 **325**（本轮**不新增用例**，只改 1 条断言的取值来源与 1 条 regex —— 见 spec §9.2；`test/contrast.test.js` 保持 33 条）。
- **每个任务结束都要 commit**，提交信息用 `style:` / `fix:` / `docs:` 前缀，中文描述。
- **改完 `public/` 必须走 README 末尾的冒烟清单**（Task 4 之后是 10 条）。渲染层只有「假 DOM」覆盖，CSS 是否生效、真实布局与真实键盘只有人眼能验收。

---

## Task 1: 表面台阶（重算三个色值）

现状三个表面几乎同色（相邻台阶亮度比 1.0353 / 1.0267，肉眼分辨不出）。本任务只动**表面**色值，把台阶拉开，**色相锁在 H=75**（与 `--background` 同族）。

**Files:**
- Modify: `public/index.html:9`（`--surface-alt`）
- Modify: `public/index.html:21`（悬停行、展开行两处）
- Test: `test/contrast.test.js`（allowlist，约 108–111 行）

**Interfaces:**
- Consumes: 无
- Produces: 三个新色值 `#f4f6f0`（悬停行 / 展开的行）、`#edf0e5`（展开详情所在行）、`#e7ebdc`（`--surface-alt` 表头）。后续任务不再改动它们。

**为什么顺序是「先改 CSS 再改白名单」而不是标准 TDD 的先写测试**：`test/contrast.test.js` 是**取值器**，它从 CSS 里**读**色值再算对比度（这是该文件刻意的设计，见它自己的第 1 条经验）。所以「先让测试红」在这里就等于先改 CSS —— 白名单那条断言会立刻抓住新色值。这个红是真红，不是走过场。

- [ ] **Step 1: 改 `--surface-alt`（表头底色）**

`public/index.html` 第 9 行，把 `--surface-alt:#eef0e9` 改成 `--surface-alt:#e7ebdc`：改完这一处的整行形如

```html
:root { color-scheme: light; --background:#f4f5f0; --foreground:#171917; --surface:#fbfcf8; --surface-alt:#e7ebdc; --border:#d7dbd1; --muted:#636963; --yellow:#faff69; --yellow-soft:#f0f2a5; --red:#b03830; --orange:#9d641c; --green:#28724c; --ring:#171917; --radius:12px; }
```

- [ ] **Step 2: 改悬停行与展开行**

`public/index.html` 第 21 行里有两处（都在同一行内，行很长）：

```css
tbody tr[role="button"]:hover, tbody tr.is-expanded { background:#f5f7e9; }
```
→
```css
tbody tr[role="button"]:hover, tbody tr.is-expanded { background:#f4f6f0; }
```

```css
.detail-row td { padding:0; background:#f1f3e9; }
```
→
```css
.detail-row td { padding:0; background:#edf0e5; }
```

- [ ] **Step 3: 跑测试，确认红 —— 白名单抓住了新色值**

Run: `npm test 2>&1 | grep -A3 "设计系统之外"`
Expected: **FAIL**，输出 `出现了设计系统之外的色值: #e7ebdc, #f4f6f0, #edf0e5`（顺序按色值在 CSS 里首次出现的次序：`:root` 的表头值在前），且**只有这 1 条**失败 —— 新色值在 30 条对比度断言里全部达 AA（已逐个验过：表头 muted 4.64、悬停行 muted 5.17 / dev 5.05 / red 5.58、展开行 muted 4.88 / red 5.27）。

- [ ] **Step 4: 更新白名单**

`test/contrast.test.js` 里把 `allowed` 集合换成（删掉三个不再使用的旧色值，加入三个新色值；注意 `#4d5424` 本轮**先留着**，Task 2 才删）：

```js
  const allowed = new Set(["#171917", "#286643", "#28724c", "#343a34", "#4d5424", "#636963",
    "#655f1c", "#856400", "#8c958a", "#9d641c", "#aeb5aa", "#b03830", "#d7dbd1", "#dcefe0",
    "#e4e7e1", "#e7ebdc", "#edf0e5", "#f0f2a5", "#f4d9d5", "#f4f5f0", "#f4f6f0", "#faff69",
    "#fbfcf8"]);
```

- [ ] **Step 5: 把白名单的来历注释更新**

同一处 `test()` 里，注释现在只说「含移植时的 4 处最小修正」，补上本轮的重算：

```js
test("不引入设计系统之外的色值", () => {
  // 来源：ui/app/globals.css（含移植时的 5 处最小压暗修正）。
  // 2026-09-16 视觉刷新重算了三个**表面**色值（锁 H=75 拉亮度台阶，见
  // docs/superpowers/specs/2026-09-16-dashboard-visual-refresh-design.md §4），
  // 所以下面这套值不再与参考 UI 逐字相同 —— 它是「本项目当前实际使用的色值集合」。
```

**注意**：把原来的首行注释「来自 ui/app/globals.css（含移植时的 4 处最小修正）」整行替换掉，不要留两行互相矛盾的注释。

- [ ] **Step 6: 跑测试，确认绿**

Run: `npm test 2>&1 | tail -8`
Expected: `ℹ pass 325` / `ℹ fail 0`。

- [ ] **Step 7: 用独立脚本复核台阶（不是手算）**

Run:

```bash
node --input-type=module -e '
const ch=v=>{const c=v/255;return c<=0.03928?c/12.92:((c+0.055)/1.055)**2.4};
const rgb=h=>h.replace("#","").match(/../g).map(x=>parseInt(x,16));
const lum=h=>{const[r,g,b]=rgb(h);return 0.2126*ch(r)+0.7152*ch(g)+0.0722*ch(b)};
const cr=(a,b)=>{const x=lum(a),y=lum(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05)};
const s=[["卡片","#fbfcf8"],["悬停行","#f4f6f0"],["展开行","#edf0e5"],["表头","#e7ebdc"]];
for(let i=1;i<s.length;i++)console.log(s[i-1][0]+" → "+s[i][0], (lum(s[i-1][1])/lum(s[i][1])).toFixed(4));
for(const[k,v]of s)console.log(k,"muted",cr("#636963",v).toFixed(2),"dev",cr("#856400",v).toFixed(2),"red",cr("#b03830",v).toFixed(2));
'
```

Expected: 三个亮度比都在 **1.05 以上**（spec §4 目标值 1.0598 / 1.0634 / 1.0540）；每个表面的 `muted` 都 **≥ 4.5**（表头约 4.64 —— 这是本设计唯一变窄的余量，仍高于阈值）。

- [ ] **Step 8: Commit**

```bash
git add public/index.html test/contrast.test.js
git commit -m "style: 拉开面板的表面台阶（锁 H=75，亮度比 1.0267 → 1.05+）"
```

---

## Task 2: 修一条「假通过」的对比度断言

`test/contrast.test.js` 有一条断言声称测「统计数字」的颜色，实际断言的是 `token("foreground")` = `#171917`，而 `.stat strong` **实际用的是 `#4d5424`**。它没测它声称测的东西 —— 恰好违反该文件自己写的第 1 条经验。

**这不是 AA 违规**（`#4d5424` 在页面背景上是 **7.35**，本来就过）。要修的是**断言的忠实度**：将来谁给 `.stat strong` 换个颜色，现在的断言抓不到。

**Files:**
- Modify: `test/contrast.test.js:108-111`（allowlist 删 `#4d5424`）、`test/contrast.test.js:32`（那条 PAIRS 项）
- Modify: `public/index.html:19`（`.stat strong` 的 `color`）
- Test: `test/contrast.test.js`

**Interfaces:**
- Consumes: Task 1 的白名单（本轮在它基础上再删 `#4d5424`）
- Produces: 一条**从规则读值**的断言 `["统计数字 / 页面背景", fromRule(/\.stat strong\s*\{([^}]*)\}/, "color"), token("background"), 4.5]`

- [ ] **Step 1: 把断言改成从规则读**

`test/contrast.test.js` 的 `PAIRS` 里，把这一行

```js
  ["统计数字 / 页面背景", token("foreground"), token("background"), 4.5],
```

换成

```js
  // 从规则读，不要写 token("foreground")：那条断言曾声称测「统计数字」，
  // 实际验的是 foreground，而 .stat strong 当时用的是 #4d5424 —— 等于没测。
  ["统计数字 / 页面背景", fromRule(/\.stat strong\s*\{([^}]*)\}/, "color"), token("background"), 4.5],
```

- [ ] **Step 2: 跑测试，确认仍绿（且现在读的是真实值）**

Run: `npm test 2>&1 | grep -E "统计数字|ℹ (pass|fail)"`
Expected: `✔ 对比度达 AA：统计数字 / 页面背景` **PASS**（`#4d5424` 在 `#f4f5f0` 上是 7.35），`ℹ pass 325` / `ℹ fail 0`。

**说明**：这一步**不会红**，因为旧色值本来就达 AA。这个任务的「红」在下一步 —— 要证明这条新断言不是空转。

- [ ] **Step 3: 证明这条断言真的会失败（关键的一步，别跳）**

把 `public/index.html:19` 的 `.stat strong` 的 `color:#4d5424` **临时**改成 `color:var(--border)`（`#d7dbd1`，在白名单里，所以不会污染别的断言）。

Run: `npm test 2>&1 | grep "统计数字"`
Expected: **FAIL**，`统计数字 / 页面背景 1.28 < 4.5（#d7dbd1 on #f4f5f0）`。

这证明新断言是**承重的**。若它仍然通过，说明 `fromRule` 没读到 `.stat strong`，要去查正则。

- [ ] **Step 4: 把颜色定稿为 foreground（顺手收掉那层橄榄绿）**

承上，把 `public/index.html:19` 的 `.stat strong` 改成

```css
.stat strong { display:block; color:var(--foreground); font:700 28px/1.2 "JetBrains Mono", monospace; letter-spacing:-2px; }
```

理由（spec §9.1）：那层橄榄色 `#4d5424` 本来就发闷，且「颜色只用来表达状态」更克制 —— 四个计数里只有 `失败` 该有颜色（它保留 `var(--red)`，`未报价` 保留 `var(--muted)`）。

- [ ] **Step 5: 从白名单删掉 `#4d5424`**

`test/contrast.test.js` 的 `allowed` 集合，删掉 `"#4d5424", `（现在它不再被任何规则使用）：

```js
  const allowed = new Set(["#171917", "#286643", "#28724c", "#343a34", "#636963",
    "#655f1c", "#856400", "#8c958a", "#9d641c", "#aeb5aa", "#b03830", "#d7dbd1", "#dcefe0",
    "#e4e7e1", "#e7ebdc", "#edf0e5", "#f0f2a5", "#f4d9d5", "#f4f5f0", "#f4f6f0", "#faff69",
    "#fbfcf8"]);
```

- [ ] **Step 6: 跑测试，确认绿**

Run: `npm test 2>&1 | tail -8`
Expected: `ℹ pass 325` / `ℹ fail 0`。用例数**仍是 325**（没有新增用例）。

- [ ] **Step 7: 确认 `#4d5424` 真的不再出现在 CSS 里**

Run: `grep -c '4d5424' public/index.html; grep -c '4d5424' test/contrast.test.js`
Expected: 两个都是 `0`（`grep -c` 在无匹配时输出 0 并以退出码 1 结束，这是预期的）。

- [ ] **Step 8: Commit**

```bash
git add public/index.html test/contrast.test.js
git commit -m "fix: 对比度断言改为从规则读值；统计数字收起橄榄绿

原断言声称测「统计数字」，实际验的是 foreground，而 .stat strong 用的是
#4d5424 —— 没测到它声称测的东西。改成 fromRule 读规则，并补一步故意
设成 --border 验证它会失败（1.28 < 4.5），证明断言承重。"
```

---

## Task 3: 数字列右对齐

9 列里第 4–8 列（USD、成本、较基准、可按、延迟）是数字，现在全部左对齐，位数不一就对不齐小数点，竖向扫不出大小。

**Files:**
- Modify: `public/index.html`（在 `<style>` 末尾「参考 UI 未覆盖、由本项目推导」的注释区里追加规则）

**Interfaces:**
- Consumes: 无
- Produces: 一条 `nth-child(4)…nth-child(8)` 的右对齐规则。**不新增类名、不改 JS、不改测试。**

**为什么用 `nth-child` 而不是类名**：窄屏丢列（`.hide-medium`）与深度关闭丢列（`.no-depth .depth-col`）走的都是 `display:none`，**不改变 DOM 序号**，所以列隐藏后对位不会错。展开详情行只有一个 `colSpan=9` 的 `td`，它是 `nth-child(1)`，不受影响。

**本任务没有自动化测试**（spec §9.2 明确「不新增用例」）。验收靠 `npm test` 不回归 + Step 3 的人眼检查。

- [ ] **Step 1: 追加右对齐规则**

在 `public/index.html` 的 `<style>` 末尾，紧接在 `/* 未报价的统计项只在非零时出现… */` 那条 `.stat-none strong` 规则**之后**、`</style>` **之前**追加：

```css
    /* 数字列右对齐 —— 左对齐时 $1,501.96 与 $9.99 的小数点对不齐，竖向扫不出大小。
       用 nth-child 而不是类名：丢列走的是 display:none，不改变 DOM 序号，
       所以 .hide-medium / .no-depth 隐藏列后这里的对位依然正确。 */
    th:nth-child(4), th:nth-child(5), th:nth-child(6), th:nth-child(7), th:nth-child(8),
    td:nth-child(4), td:nth-child(5), td:nth-child(6), td:nth-child(7), td:nth-child(8) { text-align:right; }
```

- [ ] **Step 2: 跑测试，确认没回归**

Run: `npm test 2>&1 | tail -8`
Expected: `ℹ pass 325` / `ℹ fail 0`。

特别确认这两条不在失败之列 —— 新选择器形如 `th:nth-child(4)`，其中的 `th` **后面紧跟 `:`**，不会被 `contrast.test.js` 里 `/th\s*\{([^}]*)\}/` 抢到「第一个 `th {`」的位置（它要求 `th` 后是可选空白再 `{`）：

Run: `npm test 2>&1 | grep -E "对比度达 AA：表头|设计系统之外|不外链"`
Expected: 三条都 `✔`。

- [ ] **Step 3: 人眼检查（这一步不能省）**

Run: `npm start`，浏览器打开 `http://127.0.0.1:8787/`

确认：
1. `USD` / `成本` / `较基准` / `可按` / `延迟` 五列的数字**右边缘对齐**（小数点大致成列）
2. 这五列的**表头文字也右对齐**，且与数字挨得自然
3. **币对 / 状态 / 付 → 得 / 最后报价 四列仍然左对齐**
4. 把窗口缩到 **≤1024px**：`USD` 与 `延迟` 两列消失后，剩下的数字列**仍然各自右对齐、没有错位**
5. 把 `config.json` 的 `depth.enabled` 改成 `false` 并重启：`可按` 整列消失后，`延迟` 列**仍然右对齐**（这条专测 `nth-child` 不受丢列影响）

- [ ] **Step 4: Commit**

```bash
git add public/index.html
git commit -m "style: 数字列右对齐（USD/成本/较基准/可按/延迟）

用 nth-child 定位：丢列走 display:none，不改 DOM 序号，所以
.hide-medium 与 .no-depth 隐藏列后对位不会错。"
```

---

## Task 4: 键盘焦点不被横向滚动容器裁掉

`.table-scroll { overflow-x:auto }` 让容器在**两个轴**上都是滚动容器（`overflow-y` 由 `visible` 计算为 `auto`），于是**纵向也会裁**。行是 `role="button"` + `tabindex="0"`，焦点框画在行外 2px —— 首行、末行（以及横向滚动时最右）的焦点框**看不见**。这是 A11Y8「焦点可见」在真实场景下的失效。

**Files:**
- Modify: `public/index.html`（末尾推导区追加一条规则）
- Modify: `README.md`（冒烟清单加第 10 条，插在第 9 条之后、「关于第 6 步的一个细节」之前）
- Modify: `AGENTS.md:56`（「9 条」→「10 条」）
- Modify: `docs/ui-requirements.md:177`（「9 条清单」→「10 条清单」）

**Interfaces:**
- Consumes: 无
- Produces: 一条 `tbody tr[role="button"]:focus-visible { outline-offset:-2px; }` 规则；冒烟清单从 9 条变 10 条，两处引用同步改成「10 条」。

**为什么是 `outline-offset` 而不是 `box-shadow: inset`**（spec §6 的决策记录）：`box-shadow` 作用在 `display: table-row` 上跨浏览器不可靠（`border-collapse: collapse` 下尤其），而 `outline` 是本项目**当前已在用**的机制。只改一个取值，与「换掉机制 + 换掉属性」的风险不是一个量级。`box-shadow: inset` 虽然被 V2 允许，这里仍不采用。

- [ ] **Step 1: 追加焦点规则**

在 Task 3 追加的那条右对齐规则**之后**、`</style>` **之前**追加：

```css
    /* 行按参考 UI 是可交互元素（role=button + tabindex），但父级 .table-scroll 是
       overflow-x:auto —— 它同时是纵向滚动容器，所以画在行外的焦点框会被裁掉，
       首行/末行 Tab 过去看不见。offset 取负，把 outline 收到行内边界。 */
    tbody tr[role="button"]:focus-visible { outline-offset:-2px; }
```

- [ ] **Step 2: 跑测试，确认没回归**

Run: `npm test 2>&1 | tail -8`
Expected: `ℹ pass 325` / `ℹ fail 0`。

新选择器含 `:focus-visible`，**不含 `:hover`**，所以不会被 `contrast.test.js` 的 `HOVER_ROW` 正则（要求字面 `:hover`）抢到；也不加任何 `box-shadow` 或色值：

Run: `npm test 2>&1 | grep -E "不用投影|设计系统之外|悬停行"`
Expected: 三条都 `✔`。

- [ ] **Step 3: 人眼检查 —— 这是本任务唯一的真实验收**

Run: `npm start`，浏览器打开 `http://127.0.0.1:8787/`

1. 用 `Tab` 键从页首一路聚焦到表格：焦点应落到第一行，**焦点框四边都完整可见**（尤其上边缘与左右边缘没有被卡片切掉）
2. 把表格横向滚到最右，`Tab` 到最后一行：焦点框**右边缘**仍可见
3. 对焦点行按 `Enter` 或空格：应展开详情，`aria-expanded` 变 `true`（这条是既有行为，确认没被改坏）
4. 展开态下行仍有焦点框（`.is-expanded` 与 `:focus-visible` 同时存在时不应互相覆盖）

- [ ] **Step 4: 把这条写进 README 的冒烟清单**

在 `README.md` 的第 9 条（`.depth.enabled` 那条）**之后**、空行「关于第 6 步的一个细节：」**之前**插入：

```markdown
10. 用 `Tab` 键聚焦到表格的行：焦点框应**四边完整可见** —— 首行、末行与横向滚动到最右时都不能被卡片裁掉
    （`.table-scroll` 是 `overflow-x:auto`，它在纵向也会裁；这条专测 `outline-offset` 的修正）。
    不需要改 `config.json`，与上面各步独立
```

**必须插在第 9 条之后而不是别处**：README 里有一句「关于第 6 步的一个细节」，插在中间会把编号挪位、让那句引用指错。

- [ ] **Step 5: 同步两处「9 条」引用**

`AGENTS.md:56`：

```markdown
- 所以**改完 `public/` 必须按 README 末尾的冒烟清单手工过一遍**（9 条），
```
→ 把 `（9 条）` 改成 `（10 条）`。

`docs/ui-requirements.md:177`：

```markdown
| **手工冒烟** | 上面覆盖不到的全部（布局、展开、断网、窄屏、整列隐藏） | README 末尾 9 条清单 |
```
→ 把 `README 末尾 9 条清单` 改成 `README 末尾 10 条清单`。

- [ ] **Step 6: 确认没有漏掉的「9 条」**

Run: `grep -rn "9 条" AGENTS.md README.md docs/ui-requirements.md`
Expected: **无输出**（`grep` 无匹配时退出码为 1，这是预期的）。若还有命中，说明漏了一处。

- [ ] **Step 7: 确认清单真的是 10 条**

Run: `sed -n '/### 面板冒烟/,/^关于第 6 步/p' README.md | grep -cE '^[0-9]+\.'`
Expected: `10`

- [ ] **Step 8: Commit**

```bash
git add public/index.html README.md AGENTS.md docs/ui-requirements.md
git commit -m "fix(a11y): 行焦点框不再被 .table-scroll 裁掉；冒烟清单补到 10 条

.table-scroll 是 overflow-x:auto，纵向也裁，画在行外的焦点框在
首行/末行看不见。offset 取负收到行内边界 —— 不改机制（outline 已在用），
只改一个取值，比换成 box-shadow:inset 风险低。"
```

---

## Task 5: 图例按语义单元折行

`.legend` 是一条长句，窄屏折成两三行（`ui-requirements.md` §12 已登记的缺口）。改成三个短 `<span>` 按「术语 = 说明」成组折行。

**不能改成 `title`**（A11Y9 与 §12 明令）：`title` 在触屏与键盘上读不到。用 span 是**加强**可达性。

**Files:**
- Modify: `public/index.html:132`（图例标记）
- Modify: `public/index.html`（`.legend` 规则，第 20 行附近）
- Test: `test/dashboard-dom.test.js`（`三个口径有可见说明` 那条的 regex）

**Interfaces:**
- Consumes: 无
- Produces: `<p class="legend">` 内含**三个** `<span>`，文本分别是「成本 = …」「较基准 = …」「可按 = …」；`.legend` 变成 `display:flex` + `flex-wrap:wrap`。

- [ ] **Step 1: 把图例改成三个 span**

`public/index.html` 第 132 行整行替换为：

```html
    <p class="legend">
      <span>成本 = 付出与所得的美元差额</span>
      <span>较基准 = 相对近 1 小时成功报价中位数（偏离阈值 10%，服务端配置）</span>
      <span>可按 = 已验证可通过的最大金额档位（$ 为名义美元）</span>
    </p>
```

**文案逐字照抄，一个字都不要改** —— 「成本 / 较基准 / 可按」这三个术语与 `偏离阈值 10%，服务端配置` 这句是被 `README` 与 `ui-requirements.md` 引用过的既有口径说明。

- [ ] **Step 2: 改 `.legend` 的布局规则**

第 20 行附近现在是：

```css
.legend { margin:13px 0 15px; color:var(--muted); font-size:11px; }
```

替换为：

```css
.legend { display:flex; flex-wrap:wrap; gap:3px 14px; margin:13px 0 15px; color:var(--muted); font-size:11px; }.legend span + span::before { content:"· "; }
```

（`·` 由 `::before` 生成，颜色继承 `.legend` 的 `var(--muted)` —— 与原先字面写 `·` 的视觉效果一致，已在白名单内，不引入新色值。）

- [ ] **Step 3: 跑测试，确认红 —— 结构断言抓住了变化**

Run: `npm test 2>&1 | grep -A2 "三个口径"`
Expected: **FAIL**，`缺少 .legend`。原因：`test/dashboard-dom.test.js` 里的

```js
const legend = html.match(/<p class="legend">([^<]*)<\/p>/);
```

的 `[^<]*` **不允许任何子元素**，现在图例里是 `<span>`，所以 `match` 返回 `null`。

- [ ] **Step 4: 放宽那条 regex**

`test/dashboard-dom.test.js` 的 `三个口径有可见说明（比 tooltip 更强的可达性要求）` 这条测试里，把

```js
  const legend = html.match(/<p class="legend">([^<]*)<\/p>/);
```

换成

```js
  // 放宽 `[^<]*` → `[\s\S]*?`：图例现在是三个 <span>（按语义单元折行），
  // 不再是一段纯文本。放宽的是**实现方式**，不是可达性要求 ——
  // 下面仍然断言三个口径都必须出现在图例里。
  const legend = html.match(/<p class="legend">([\s\S]*?)<\/p>/);
```

（`[\s\S]*?` 非贪婪，会在第一个 `</p>` 停下，不会吞掉后面的段落。）

- [ ] **Step 5: 跑测试，确认绿**

Run: `npm test 2>&1 | grep -E "三个口径|ℹ (pass|fail)"`
Expected: `✔ 三个口径有可见说明` PASS，`ℹ pass 325` / `ℹ fail 0`。用例数**仍是 325**。

- [ ] **Step 6: 人眼检查**

Run: `npm start`，浏览器打开 `http://127.0.0.1:8787/`

1. 宽屏（≥1280px）：图例应是**一行**，三段之间有点号分隔，观感与原版基本一致
2. 窄屏（缩到 ~480px）：应折成**两三行**，且每行是一个完整的「术语 = 说明」，**不会把一段说明从中间劈开、也不会把 `·` 落在行首**
3. 用 `Tab` 键不应聚焦到图例（它不是交互元素）—— 确认 flex 化没有意外改变可聚焦性

- [ ] **Step 7: Commit**

```bash
git add public/index.html test/dashboard-dom.test.js
git commit -m "style: 图例按语义单元折行（三个 span），放宽一条结构正则

窄屏不再把一段说明从中间劈开。放宽的是实现方式断言
（[^<]* → [\\s\\S]*?），三个口径必须都在图例里的要求没放松。"
```

---

## Task 6: 文档一致性（5 处已核实的陈旧表述）

这 5 处全是**已经核对过为真**的陈旧表述，不修会让 spec 与仓库自相矛盾。

**Files:**
- Modify: `docs/ui-requirements.md`（§9 表后段落、§13 两处数字）
- Modify: `AGENTS.md`（设计系统一节的 §12 说法）
- Modify: `README.md:42`（用例数）

**Interfaces:**
- Consumes: Task 4 之后的仓库状态（用例数仍 325、冒烟 10 条）
- Produces: 无代码产物，只有文档

- [ ] **Step 1: 修 `ui-requirements.md` §9 表后那段过时的话**

该表已把 A11Y7 / A11Y8 / A11Y9 三条标为 ✅，紧跟的表后段落却仍写「这三条缺口是实际存在」。把这一段：

```markdown
**这三条缺口是实际存在、不是保守表述。** 修法都很小（A11Y7/A11Y8 各约 10 行与 3 行；A11Y9 需要给列名加可见的悬停提示或一个说明区）。
```

替换为：

```markdown
**这三条已满足**（原为缺口，随参考 UI 一并移植时补齐）：

- **A11Y7** 展开行的键盘可达：`dashboard.js` 的 `buildRowElement()` 设 `role="button"` / `tabindex="0"` /
  `aria-expanded`，并处理 Enter 与空格。由 `test/dashboard-render.test.js`（断言实际生成的属性）与
  `test/dashboard-dom.test.js`（断言脚本里存在这些调用）**双向钉住**。
- **A11Y9** 列口径可见：常驻的 `.legend`（不是 `title`）。由 `test/dashboard-dom.test.js` 的
  「三个口径有可见说明」钉住。
- **A11Y8** 焦点可见：全局 `:focus-visible` 规则。**这一条没有自动化断言** —— 它只在 CSS 里，
  所以 `test/contrast.test.js` 覆盖不到它；真实的可见性只能靠人眼（见 README 冒烟第 10 条）。
```

- [ ] **Step 2: 修 `ui-requirements.md` §13 的两处数字**

在 §13「验收方式汇总」表里：

```markdown
| 对比度与样式约束测试 | 31 个用例：前景/背景组合达 AA + 无投影 + 无规范外色值 + 不外链资源 | `npm test` |
```
→ 把 `31 个用例` 改成 `33 个用例（30 条对比度 + 3 条约束）`。

```markdown
| DOM 契约测试 | `init()` 要的 16 个 id 都在 HTML 里、表头 10 列、三条 tooltip 在位、无内联处理器 | `npm test` |
```
→ 把 `表头 10 列` 改成 `表头 9 列`。

- [ ] **Step 3: 修 `AGENTS.md` 里对 §12 的说法**

`AGENTS.md` 的设计系统一节现在写：

```markdown
其中 **§4 语义需求与 §12 已知缺口**最值得先看 —— 前者是两份真实事故换来的「不许说什么」，
后者明确列着当前未满足的需求（展开行的键盘可达性、焦点样式、列说明的可达性）。
```

那个括号里的三条**已经不在 §12 里了**（它们已在 §9 标为 ✅）。替换为：

```markdown
其中 **§4 语义需求与 §12 已知缺口**最值得先看 —— 前者是两份真实事故换来的「不许说什么」，
后者是当前**真正**未满足的需求：渲染层只被「假 DOM」覆盖（CSS 是否生效、真实布局与真实键盘
仍只有人眼能验收）、首轮采集期间 `/health` 为 503、`.legend` 在窄屏会折行。
```

- [ ] **Step 4: 修 `README.md:42` 的用例数**

现在写：

```markdown
281 个用例：配置 21、金额与数值 15、币对解析 18、HTTP 12、SQLite 32、判定 21、报价 16、通知 21、服务端 25、装配 33、面板 61、深度 6。
```

替换为（分项是**实测**的逐文件计数，加总 = 325）：

```markdown
325 个用例（实测逐文件）：配置 21、金额 8、数值 7、币对解析 18、HTTP 12、SQLite 32、判定 21、
报价 16、通知 21、服务端 25、装配 33、面板 72、对比度与样式约束 33、深度 6。
```

**分项映射**（加总必须正好 325，别把 `store-depth` 重复计进两个类）：

| README 类目 | 文件 | 条数 |
|---|---|---|
| 配置 | `config` | 21 |
| 金额 / 数值 / 币对解析 / HTTP | `amount` 8 / `numeric` 7 / `assets` 18 / `http` 12 | 45 |
| SQLite | `store` 15 + `store-maintenance` 10 + `store-depth` 7 | 32 |
| 判定 / 报价 / 通知 / 服务端 / 装配 | `detect` 21 / `quote` 16 / `notify` 21 / `server` 25 / `index` 33 | 116 |
| 面板 | `dashboard` 44 + `dashboard-depth` 16 + `dashboard-dom` 8 + `dashboard-render` 4 | 72 |
| 对比度与样式约束 | `contrast` | 33 |
| 深度 | `depth` | 6 |

21+45+32+116+72+33+6 = **325**

- [ ] **Step 5: 核对分项加总与实测一致**

Run:

```bash
node -e 'const p=[21,45,32,116,72,33,6];console.log("README 分项加总",p.reduce((a,b)=>a+b,0))'
for f in test/*.test.js; do n=$(node --disable-warning=ExperimentalWarning --test "$f" 2>&1 | grep -m1 '^ℹ pass' | awk '{print $3}'); printf "%-32s %s\n" "$(basename $f)" "$n"; done
```

Expected: 加总为 **325**；逐文件计数加起来也是 **325**。若对不上，**改 README 的数字而不是改测试**。

特别注意 `store-depth.test.js`（7 条）已计入「SQLite 32」，**不要再计进「深度」** —— 这正是本计划初稿犯过的错（分项曾加到 332）。「深度 6」只指 `depth.test.js`。

- [ ] **Step 6: 全仓确认没有遗留的「281」与「10 列」**

Run: `grep -rn "281 个用例\|表头 10 列\|31 个用例" AGENTS.md README.md docs/ui-requirements.md`
Expected: **无输出**。

- [ ] **Step 7: 跑测试确认没被文档改动带坏**

Run: `npm test 2>&1 | tail -4`
Expected: `ℹ pass 325` / `ℹ fail 0`。

（`test/dashboard-dom.test.js` 会读 `public/index.html`、`test/contrast.test.js` 也读它 —— 这两个文件本轮**没有**被文档任务碰过，所以应当完全无关。）

- [ ] **Step 8: Commit**

```bash
git add README.md AGENTS.md docs/ui-requirements.md
git commit -m "docs: 修 5 处已核实的陈旧表述

- ui-requirements §9 表后仍写「这三条缺口是实际存在」，表里已 ✅
- ui-requirements §13 表头 10 列 → 9 列
- ui-requirements §13 对比度 31 个用例 → 33（30 对比度 + 3 约束）
- AGENTS.md 说 §12 列着展开行可达性/焦点/列说明，§12 已无此三条
- README 用例数 281 → 325，分项改为实测逐文件计数"
```

---

## 全局收尾（Task 6 之后）

- [ ] **全量测试**

Run: `npm test 2>&1 | tail -8`
Expected: `ℹ pass 325` / `ℹ fail 0` / `ℹ duration_ms …`，输出干净（无 warning）。

- [ ] **完整走一遍 README 末尾的冒烟清单（现在是 10 条）**

重点四条：
- **第 4 条**（展开行）—— 验证 §4 的展开行色值 `#edf0e5`
- **第 8 条**（档位块）—— 同时验证表头 `#e7ebdc` 与展开行的层次
- **第 10 条**（新增，键盘焦点）—— 本设计唯一「靠推断而非实测」的改动，必须人眼看
- **窄屏 768 / 1024 两档** —— 数字列右对齐后列宽是否合理、图例折行是否按语义成组

- [ ] **确认没有违反任何 Global Constraints**

Run:

```bash
grep -E '"(dev)?[Dd]ependencies"' package.json || echo "C1 ok：无 dependencies"
grep -c 'box-shadow' public/index.html
grep -rn '@import\|<link' public/index.html || echo "C3 ok：无外链"
grep -c 'innerHTML' public/dashboard.js || echo "I10 ok：无 innerHTML"
```
Expected: `C1 ok`、`C3 ok`、`I10 ok`；`box-shadow` 的命中数仍为 **1**（只有 `.issue-toggle input:checked + .toggle-box` 那条 `inset` 内填充）。

---

## Self-Review

**1. Spec 覆盖**

| Spec 节 | 落在哪个 Task |
|---|---|
| §2 spectrum-ui 可行性结论 | 无代码任务 —— 它是**决策记录**，产物就是 spec 本身。不实现任何东西，符合预期 |
| §3 为什么不搬中性灰 | 同上，决策记录 |
| §4 表面台阶（3 个色值 + 白名单） | Task 1 |
| §5 数字列右对齐 | Task 3 |
| §6 焦点不被裁 | Task 4 |
| §7 不加涨跌箭头 | **无任务，这是有意的** —— §7 是「不做」的决策记录。执行时若有人提议加箭头，指向 §7 |
| §8 图例折行 + 放宽 regex | Task 5 |
| §9.1 白名单改动 | Task 1（+3/−3）与 Task 2（−`#4d5424`） |
| §9.1 假断言修复 | Task 2 |
| §9.1 `.stat-none strong` 不新增断言 | 无任务 —— 它已被「次要文字 / 页面背景」按同一色对覆盖，Task 2 Step 2 的注释里也写了 |
| §9.2 用例数不变 | 每个 Task 的 Expected 都钉了 `325` |
| §9.3 dom test regex | Task 5 |
| §9.4 五处陈旧文档 | Task 6（另加 Task 4 引发的两处「9 条」→「10 条」，那是 Task 4 自己产生的后果，所以归 Task 4） |
| §10 不做档位量级条 | **无任务，有意** —— §10 是「不做」 |
| §11 风险 → 冒烟清单加焦点一条 | Task 4 Step 4 |
| §12 验证方式 | Task 3 Step 3 / Task 4 Step 3 / 收尾 |

**2. 占位符扫描**：无 TBD / TODO / 「稍后实现」/ 「同 Task N」。每个代码步骤都给了可直接粘贴的代码块与精确的 Expected。

**3. 命名与类型一致性**：本轮**不新增任何函数、类名、id 或令牌名**（spec §4 明确「一个令牌名都不改」），所以不存在签名漂移。跨 Task 引用的同一物件只有三处，已核对一致：

- 新增的三个色值：Task 1 定义 `#f4f6f0` / `#edf0e5` / `#e7ebdc`，Task 1 Step 4 与 Step 5 的 allowlist 逐字一致
- allowlist 的演进：Task 1 Step 4 的集合（含 `#4d5424`）→ Task 2 Step 5 的集合（删 `#4d5424`）。两处都是完整集合，不是增量，Task 2 的 Step 5 已写明是在 Task 1 基础上删一项
- `fromRule(/\.stat strong\s*\{([^}]*)\}/, "color")`：Task 2 Step 1 定义，Step 3 用它验证承重，两处正则逐字一致

**4. 有意为之的缺口（执行前请知悉）**

- **Task 3（右对齐）与 Task 4（焦点）没有自动化断言。** 这是 spec §9.2 明确决定的「不新增用例」，理由是保持用例 325 不变、且这两个改动是纯声明式 CSS。代价是：**它们只被人眼与 `npm test` 的不回归保护**。
- 一个更强的替代方案是加一条「四个表面必须单调、相邻亮度比 ≥ 1.04」的断言（这能真正钉住 §4 的意图，而不是像现在这样只钉住色值被登记）。**但那会新增用例、改变 spec §9.2 的结论，所以本计划没有做。** 如果执行者或用户想要它，那是一次 spec 修订，不是计划的自由发挥。
