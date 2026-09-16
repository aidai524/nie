# 面板按参考录屏重构 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把面板从「单列居中的等宽风格」改成参考录屏的「左栏控件 + 主区卡片、正文族 + 等宽数字」两栏结构，并顺带修掉一个横向溢出的既有缺陷。

**Architecture:** 前端零依赖、无构建，所以全部改动落在两个文件：`public/index.html`（唯一的样式与结构事实来源）与 `public/dashboard.js`（纯函数区可测 + `init()` 装配区）。链路是「先加纯函数与其单测 → 再改样式 → 再改结构 → 最后改装配」。每个任务结束都必须 `npm test` 全绿，且页面在浏览器里仍可用。

**Tech Stack:** 原生 ES 模块 + 原生 CSS + `node:test`（`node --test "test/**/*.test.js"`）。**不得引入任何依赖或构建步骤。**

**Spec:** `docs/superpowers/specs/2026-09-17-dashboard-video-restyle-design.md`（本计划逐条实现它；执行者应同时读 spec 与计划）

## Global Constraints

以下约束对本计划**每一个**任务都成立，不再在任务里重复：

- **C1 零运行时依赖**：`package.json` 不得出现 `dependencies` / `devDependencies`；前端不引任何 npm 包
- **C2 无构建步骤**：原生 ES 模块 + 原生 CSS，浏览器直接加载
- **C3 不外链任何资源**：无 webfont、无 CDN、无 `@import`；图标一律内联 SVG
- **界面文案中文**；标识符、类名、元素 id、字段名一律英文。**例外**：`ROUTE OBSERVABILITY` / `QUOTATION HEALTH` / `API ONLINE` 三个大写英文标签保留原样，**其余不新增英文界面文案**
- **不要 emoji**
- **不用投影做层级**：`box-shadow` 只允许 `inset`
- **不引入规范外的色值**：新色值必须同时登记进 `test/contrast.test.js` 的白名单
- **不放宽任何 WCAG 阈值**：新增的前景/背景组合必须实测达 AA（正文 4.5:1，非文字 3:1）
- **面板不能骗人**：任何数字或符号都不能让人得出错误结论。有疑问就改措辞或补说明
- 来自 API 的文本一律用 `textContent`，**绝不 `innerHTML`**
- 每个任务结束跑 `npm test` 必须**全绿且输出干净**；命令是 `npm test`（内部用 glob，`node --test <目录>` 在本 Node 版本会报 `MODULE_NOT_FOUND`）
- 改完 `public/` 必须按 `README.md` 末尾的冒烟清单**人工过一遍**（渲染层只有假 DOM 覆盖，CSS 是否生效、真实布局与真实键盘只有人眼能验收）
- **不要提交活库 `data/monitor.db`**；`config.json` 与 `ui/` 永不入库
- 分支：本计划在 `feat/video-restyle` 之上执行；**不要**合并到 `main`

## 文件结构

| 文件 | 职责 | 本计划的改动 |
|---|---|---|
| `public/index.html` | **唯一的样式与结构事实来源**（CSS 在 `<style>` 里，标记在 `<body>` 里） | 全部样式与结构改动 |
| `public/dashboard.js` | 纯函数区（1–392 行，可单测）+ 装配区（393 行起，碰 DOM 与网络） | 新增 2 个纯函数；改类名；改链列表的生成与事件 |
| `test/dashboard.test.js` | 纯函数单测（现有 44 例） | 加 `formatSharePct` / `shareCaption` / `chainCounts` 的用例 |
| `test/dashboard-dom.test.js` | 静态契约：`init()` 要的 id 都在 HTML 里、表头 9 列、结构类名在位 | 更新 id 与结构类名断言；加排版与宽度断言的静态检查 |
| `test/dashboard-render.test.js` | 假 DOM：跑真实 `init()` 并断言**实际生成的标记** | 更新 `mountPage()` 的 id 列表；加链列表与 KPI 说明行的断言 |
| `test/contrast.test.js` | 对比度矩阵 + 无投影 + 无规范外色值 + 不外链 | 白名单换值；加新组合的断言 |
| `docs/ui-requirements.md`、`AGENTS.md`、`README.md`、`HANDOFF.md` | 设计与运维事实 | 最后一个任务统一更新 |

---

### Task 1: 纯函数 `formatSharePct` 与 `shareCaption`

KPI 卡的说明行要写**真实占比**。四舍五入会把「有」显示成 `0%`，所以这里有一条专门的边界规则 —— 它与本项目已经栽过的 `-0.00%` 是同一类事故。

**Files:**
- Modify: `public/dashboard.js`（纯函数区，放在 `formatCostPct` 之后，约 107 行附近）
- Test: `test/dashboard.test.js`

**Interfaces:**
- Produces:
  - `formatSharePct(count: number, total: number): string` —— 返回 `"87%"` / `"<1%"` / `"0%"`；`total <= 0` 时返回 `"—"`
  - `shareCaption(count: number, total: number): string` —— 返回整句，如 `"38 对中的 87%"`

- [ ] **Step 1: 写失败的测试**

在 `test/dashboard.test.js` 的 import 列表末尾加上 `formatSharePct, shareCaption`，并在文件末尾追加：

```js
test("formatSharePct：四舍五入到整数", () => {
  assert.equal(formatSharePct(33, 38), "87%");   // 86.84
  assert.equal(formatSharePct(5, 38), "13%");    // 13.16
  assert.equal(formatSharePct(38, 38), "100%");
  assert.equal(formatSharePct(0, 38), "0%");
});

test("formatSharePct：有量但四舍五入到 0 时给 <1%，不给 0%", () => {
  // 1/300 = 0.33% —— 显示 0% 就是把「有」说成「没有」
  assert.equal(formatSharePct(1, 300), "<1%");
  // 1/200 = 0.5% —— 正好半格，四舍五入到 1%
  assert.equal(formatSharePct(1, 200), "1%");
});

test("formatSharePct：total 非正时给破折号（调用方据此不显示卡片）", () => {
  assert.equal(formatSharePct(0, 0), "—");
  assert.equal(formatSharePct(3, -1), "—");
});

test("shareCaption：说明行是「总数 + 占比」的整句", () => {
  assert.equal(shareCaption(33, 38), "38 对中的 87%");
  assert.equal(shareCaption(0, 38), "38 对中的 0%");
  assert.equal(shareCaption(1, 300), "300 对中的 <1%");
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npm test 2>&1 | grep -E "formatSharePct|shareCaption|ℹ (tests|pass|fail)"`
Expected: FAIL —— `formatSharePct is not a function`（或 import 报未导出）

- [ ] **Step 3: 写最小实现**

在 `public/dashboard.js` 的 `formatCostPct` 之后插入：

```js
/**
 * 占比文字。**有量但四舍五入到 0 时给「<1%」** —— 把「有」显示成「0%」就是在骗人，
 * 与本项目栽过的「-0.00%」（四舍五入到零却带负号）是同一类事故。
 */
export function formatSharePct(count, total) {
  if (!(total > 0)) return "—";
  const pct = (count / total) * 100;
  if (count > 0 && Math.round(pct) === 0) return "<1%";
  return `${Math.round(pct)}%`;
}

/** KPI 卡说明行的整句。说明行必须带信息，所以它一定是「总数 + 占比」。 */
export function shareCaption(count, total) {
  return `${total} 对中的 ${formatSharePct(count, total)}`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test 2>&1 | grep -E "ℹ (tests|pass|fail)"`
Expected: `pass` 比改前多 4，`fail 0`

- [ ] **Step 5: 提交**

```bash
git add public/dashboard.js test/dashboard.test.js
git commit -m "feat(dashboard): 新增占比纯函数，四舍五入到零时给 <1%"
```

---

### Task 2: 纯函数 `chainCounts`

左栏的链列表要显示「涉及多少对币对」与「其中几对异常」。真实数据里 near 出现在 36/38 对里、tron 4 对全异常 —— 这种「哪条链在坏」的信息，下拉框必须选中之后才知道。

**Files:**
- Modify: `public/dashboard.js`（纯函数区，放在 `collectChains` 之后）
- Test: `test/dashboard.test.js`

**Interfaces:**
- Consumes: 行的形状由 `buildRow()` 产出，其中 `fromChain` / `toChain` / `status` 三个字段（短链名，如 `"near"`；`status` 取值为 `"ok" | "deviant" | "error" | null`）
- Produces: `chainCounts(rows: object[]): Array<{chain: string, pairs: number, problems: number}>` —— **按 `pairs` 降序、同数按 `chain` 升序**；不跳过 `"未知"`（那是 pairId 变形，应当被看见）

- [ ] **Step 1: 写失败的测试**

在 `test/dashboard.test.js` 的 import 列表里加上 `chainCounts`，并追加：

```js
test("chainCounts：数的是「涉及该链的币对」，各链之和 = 2 × 币对数", () => {
  const rows = [
    { fromChain: "near", toChain: "eth", status: "ok" },
    { fromChain: "near", toChain: "tron", status: "error" },
    { fromChain: "near", toChain: "tron", status: "ok" },
  ];
  const counts = chainCounts(rows);
  assert.deepEqual(counts, [
    { chain: "near", pairs: 3, problems: 1 },
    { chain: "tron", pairs: 2, problems: 1 },
    { chain: "eth", pairs: 1, problems: 0 },
  ]);
  assert.equal(counts.reduce((sum, entry) => sum + entry.pairs, 0), 2 * rows.length);
});

test("chainCounts：同币对数按链名升序（列表不随异常数跳位）", () => {
  const counts = chainCounts([{ fromChain: "zeta", toChain: "alpha", status: "ok" }]);
  assert.deepEqual(counts.map((entry) => entry.chain), ["alpha", "zeta"]);
});

test("chainCounts：deviation 与「未报价」都算问题", () => {
  const counts = chainCounts([
    { fromChain: "near", toChain: "eth", status: "deviant" },
    { fromChain: "near", toChain: "sol", status: null },
  ]);
  const near = counts.find((entry) => entry.chain === "near");
  assert.equal(near.problems, 2, "deviant 与 null 都不是 ok");
});

test("chainCounts：畸形 pairId 的「未知」照样出现，不被吞掉", () => {
  const counts = chainCounts([{ fromChain: "未知", toChain: "near", status: "ok" }]);
  assert.deepEqual(counts.map((entry) => entry.chain).sort(), ["near", "未知"]);
});

test("chainCounts：空输入给空数组", () => {
  assert.deepEqual(chainCounts([]), []);
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `npm test 2>&1 | grep -E "chainCounts|ℹ (tests|pass|fail)"`
Expected: FAIL —— `chainCounts is not a function`

- [ ] **Step 3: 写最小实现**

在 `public/dashboard.js` 的 `collectChains` 之后插入：

```js
/**
 * 每条链的「涉及币对数」与「其中异常数」。
 *
 * 一个币对跨两条链，所以各链之和 = 2 × 币对总数（不是币对总数）。
 * 排序按币对数降序、同数按链名升序 —— **稳定**，刻意不按异常数排：
 * 那样数据一变列表就跳位，人会点错。
 * 不跳过「未知」：那是 pairId 变形，让它露出来比藏起来好。
 */
export function chainCounts(rows) {
  const byChain = new Map();
  for (const row of rows) {
    const problem = row?.status !== "ok";
    for (const chain of [row?.fromChain, row?.toChain]) {
      if (!chain) continue;
      const entry = byChain.get(chain) ?? { chain, pairs: 0, problems: 0 };
      entry.pairs += 1;
      if (problem) entry.problems += 1;
      byChain.set(chain, entry);
    }
  }
  return [...byChain.values()].sort((left, right) => {
    if (left.pairs !== right.pairs) return right.pairs - left.pairs;
    // 手写比较，不用 localeCompare（其顺序随 locale 变化，测试会不稳）
    return left.chain < right.chain ? -1 : left.chain > right.chain ? 1 : 0;
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test 2>&1 | grep -E "ℹ (tests|pass|fail)"`
Expected: `pass` 再多 5，`fail 0`

- [ ] **Step 5: 提交**

```bash
git add public/dashboard.js test/dashboard.test.js
git commit -m "feat(dashboard): 新增 chainCounts，数每条链的币对数与异常数"
```

---

### Task 3: 排版 —— 去掉全部等宽声明，改用正文族 + `tabular-nums`

现在页面通篇等宽（9 条含 `"JetBrains Mono"` 的规则），而 `tabular-nums` 一次都没用。改用正文栈后**中文完全不变**（CJK 字形本来就走系统回退），变的是拉丁字母与数字 —— 也就是录屏里那种「不是打字机」的数字。

**Files:**
- Modify: `public/index.html`（`:root` 之后到 `<style>` 末尾的 9 处；以及 `<body>` 里 2 处类名）
- Modify: `public/dashboard.js:614-623`（生成标记里的 6 处 `mono`）
- Test: `test/dashboard-dom.test.js`

**Interfaces:**
- Produces: 新类名 **`.num`**（替代 `.mono`），语义是「这是数字，用等宽数字对齐」，实现为 `font-variant-numeric: tabular-nums`
- Consumes: 无

- [ ] **Step 1: 写失败的测试**

在 `test/dashboard-dom.test.js` 末尾追加：

```js
test("排版：不再有任何等宽声明，数字改用 tabular-nums", () => {
  assert.ok(!html.includes("JetBrains Mono"), "含 JetBrains Mono 的规则应已全部删除");
  assert.ok(!js.includes("mono"), "生成标记里不该再有 mono 类名");
  assert.match(html, /\.num\s*\{[^}]*font-variant-numeric:\s*tabular-nums/,
    "缺少 .num 的等宽数字规则");
  assert.match(html, /font-family:\s*Inter,\s*ui-sans-serif/, "缺少正文字体栈");
});

test("排版：三条会随类名更换而失效的旧规则已处理", () => {
  // 480px 断点原本靠 .top-actions .mono 选中「API ONLINE」那行文字
  assert.ok(!html.includes(".top-actions .mono"), "旧选择器应改成按 id 选");
  assert.match(html, /#api-state\s*\{\s*display:\s*none/, "480px 下应按 id 隐藏状态文字");
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `node --disable-warning=ExperimentalWarning --test test/dashboard-dom.test.js 2>&1 | grep -E "^# (pass|fail)|not ok"`
Expected: FAIL —— 4 条断言里有 3~4 条不成立

- [ ] **Step 3: 改 `public/index.html` 的 9 处**

逐条按下表改（**找到 → 替换为**，只动字体相关声明，其余属性一字不动）：

| 选择器 | 找到 | 替换为 |
|---|---|---|
| `.brand-mark` | `font:700 24px/1 "JetBrains Mono", monospace` | `font-size:24px; font-weight:700; line-height:1;` |
| `.eyebrow` | `font:600 10px/1.4 "JetBrains Mono", monospace` | `font-size:11px; font-weight:600; line-height:1.4; letter-spacing:.06em;` |
| `.mono` | 整条规则 `.mono { font-family:"JetBrains Mono", ui-monospace, monospace; }` | `.num { font-variant-numeric: tabular-nums; }` |
| `.stat strong` | `font:700 28px/1.2 "JetBrains Mono", monospace` | `font-size:30px; font-weight:700; line-height:1.2; letter-spacing:-.8px; font-variant-numeric:tabular-nums;` |
| `.result-count` | `font:11px "JetBrains Mono", monospace` | `font-size:11px; font-variant-numeric:tabular-nums;` |
| `th` | `font:600 10px "JetBrains Mono", monospace` | `font-size:11px; font-weight:600; letter-spacing:.04em;` |
| `.detail-grid span` | `font:10px "JetBrains Mono", monospace` | `font-size:11px;` |
| `.detail-grid b` | `font:12px "JetBrains Mono", monospace` | `font-size:12px; font-variant-numeric:tabular-nums;` |
| `.depth-detail .tier` | `font-family:"JetBrains Mono", ui-monospace, monospace` | `font-variant-numeric: tabular-nums;` |
| `.headline` | `font-size:24px; font-weight:700;` | `font-size:26px; font-weight:600; letter-spacing:-.5px;` |

同时改 `<body>` 里两处类名与那条 480px 规则：

```html
<!-- 顶栏：它是状态文字，不是数字，所以直接去掉 mono，不改成 num -->
<span class="muted" id="api-state">连接中…</span>

<!-- 页脚：这一格是数字 -->
<span class="num">轮询间隔 30s</span>
```

```css
/* 480px：按 id 选，行为不变（窄屏只留状态点） */
@media (max-width:480px) { #api-state { display:none; } .stats strong { font-size:24px; } }
```

- [ ] **Step 4: 改 `public/dashboard.js` 的 6 处类名**

在 `buildRowElement()` 里把 `mono` 全部换成 `num`（**只换词，不动结构**）：

```js
      amount: cellWith("num",
        textOf("span", `${row.payText} `),
        textOf("span", "→", "arrow"),
        textOf("span", ` ${row.receiveText}`)),
      usd: cell(row.usdText, "num hide-medium"),
      cost: cell(row.costText, "num"),
      deviation: cell(row.deviationMuted ? `${row.deviationText}*` : row.deviationText,
        row.deviationText === "—" ? "num" : (row.status === "deviant" ? "num deviation" : "num")),
      depth: cell(row.depthText, "num depth-value depth-col"),
      latency: cell(row.latencyMs === null ? "—" : `${Math.round(row.latencyMs)}ms`, "num hide-medium"),
```

- [ ] **Step 5: 跑全套测试与人工检查**

Run: `npm test 2>&1 | grep -E "ℹ (tests|pass|fail)"`
Expected: `fail 0`

再跑一次确认没有遗漏的等宽声明：

```bash
grep -c "JetBrains Mono" public/index.html public/dashboard.js   # 两处都应为 0
grep -c "mono" public/dashboard.js                              # 应为 0
```

**人工冒烟**：`npm start`，打开 `http://127.0.0.1:8787/`，确认数字列（USD / 成本 / 较基准 / 可按 / 延迟）仍然**右对齐且上下对齐**，表头比之前略大，标题更紧。

- [ ] **Step 6: 提交**

```bash
git add public/index.html public/dashboard.js test/dashboard-dom.test.js
git commit -m "style: 通篇等宽改为正文族 + tabular-nums，.mono 更名 .num"
```

---

### Task 4: 徽章改「极浅底 + 深字」

四态徽章的文字对比度从 4.51~5.69 提到 6.05~8.38，同时**删掉不再有人引用的 `--yellow-soft`**。

**Files:**
- Modify: `public/index.html`（4 条 `.status-*` 规则 + `:root` 删一个令牌）
- Test: `test/contrast.test.js`

**Interfaces:**
- Produces: 四个新色值对（正常 `#255142` on `#ecfaf5`、偏离 `#66471d` on `#fdf6e7`、失败 `#7f261f` on `#faeae8`、未报价 `#5a5a5a` on `#f0f0f0`）
- 注意：`#7f261f` / `#faeae8` 在 Task 8 还会被左栏的异常角标复用

- [ ] **Step 1: 写失败的测试**

在 `test/contrast.test.js` 的白名单里**加 8 个新值、删 6 个旧值**，并把那段注释补成：

```js
  // 2026-09-17 按参考录屏重构：徽章改为「极浅底 + 深字」，四态对比度从
  // 4.51~5.69 提到 6.05~8.38；--yellow-soft 随之删除（无人引用）。
```

白名单最终内容（**逐字照抄**，共 24 个：比改前少 6 个旧徽章值、多 8 个新值）：

```js
  // 注意：「未报价」徽章的底色在上一轮中性化时已由 #e4e7e1 变成 #e6e6e6，
  // 所以本轮要删的是 #e6e6e6，不是 #e4e7e1。
  const allowed = new Set(["#181818", "#255142", "#28724c", "#383838", "#5a5a5a",
    "#66471d", "#676767", "#7f261f", "#856400", "#929292", "#9d641c", "#b03830", "#b3b3b3",
    "#d9d9d9", "#e9e9e9", "#ecfaf5", "#efefef", "#f0f0f0", "#f4f4f4", "#f5f5f5", "#faeae8",
    "#faff69", "#fcfcfc", "#fdf6e7"]);
```

本轮从集合里删掉的 6 个值（改造后不再被任何规则引用，逐个用 `grep` 确认过）：

| 值 | 原本用在哪 |
|---|---|
| `#286643` | 旧「正常」文字 |
| `#dcefe0` | 旧「正常」底 |
| `#655f1c` | 旧「偏离」文字 |
| `#f0f2a5` | 旧「偏离」底 —— 即被删的 `--yellow-soft` |
| `#f4d9d5` | 旧「失败」底 |
| `#e6e6e6` | 旧「未报价」底 |

注意 `#b03830`（`--red`）**保留**：它仍被失败统计数字、`.banner.err`、不通的档位等 7 处引用。

- [ ] **Step 2: 跑测试确认它失败**

Run: `node --disable-warning=ExperimentalWarning --test test/contrast.test.js 2>&1 | awk '/^not ok/,0' | head -20`
Expected: FAIL，`出现了设计系统之外的色值: #faeae8, #5a5a5a, …`

- [ ] **Step 3: 改 4 条徽章规则 + 删令牌**

```css
.status-正常 { background:#ecfaf5; color:#255142; }
.status-偏离 { background:#fdf6e7; color:#66471d; }
.status-失败 { background:#faeae8; color:#7f261f; }
.status-未报价 { background:#f0f0f0; color:#5a5a5a; }
```

在 `:root` 里删掉 `--yellow-soft:#f0f2a5;`（它唯一的用途就是 `.status-偏离` 的底色）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test 2>&1 | grep -E "ℹ (tests|pass|fail)|^not ok"`
Expected: `fail 0`。四条徽章断言会自动读到新值（它们是从规则里读的）

- [ ] **Step 5: 提交**

```bash
git add public/index.html test/contrast.test.js
git commit -m "style: 徽章改极浅底深字（对比度 4.5-5.7 提到 6.1-8.4），删 --yellow-soft"
```

---

### Task 5: 横向预算 —— 外壳加宽、表格收窄、修掉丢列后仍硬撑的缺陷

现在的硬缺陷：`table { min-width:1020px }` 不随 `.hide-medium` 丢列收缩，所以 1024px 视口（内容 984px）**现在就在横滚 36px**。

**Files:**
- Modify: `public/index.html`（`.dashboard-shell`、`th`/`td` 内边距、`table`、1024 断点）
- Test: `test/dashboard-dom.test.js`

**Interfaces:**
- Produces: 内容宽口径 —— 视口 ≥1280 时两栏（左栏 222 + 间距 24）能装下 966px 的表格

- [ ] **Step 1: 写失败的测试**

在 `test/dashboard-dom.test.js` 末尾追加：

```js
test("横向预算：外壳上限、表格下限与内边距都已按设计取值", () => {
  assert.match(html, /\.dashboard-shell\s*\{[^}]*max-width:\s*1600px/, "外壳上限应为 1600px");
  assert.match(html, /table\s*\{[^}]*min-width:\s*966px/, "表格下限应为 966px");
  // th 与 td 的横向内边距必须一致，否则表头与表体错位
  assert.match(html, /th\s*\{[^}]*padding:\s*12px 10px/, "th 横向内边距应为 10px");
  assert.match(html, /td\s*\{[^}]*padding:\s*12px 10px/, "td 横向内边距应为 10px");
});

test("横向预算：1024 断点取消表格下限（丢列后不该再硬撑 966px）", () => {
  const block = html.match(/@media \(max-width:1024px\)\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(block, "找不到 1024 断点");
  assert.match(block[1], /table\s*\{[^}]*min-width:\s*0/, "1024 下应取消表格下限");
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `node --disable-warning=ExperimentalWarning --test test/dashboard-dom.test.js 2>&1 | grep -cE "^not ok"`
Expected: 2 条失败

- [ ] **Step 3: 改样式**

按**找到 → 替换为**改（只动下表列出的属性）：

| 选择器 | 找到 | 替换为 |
|---|---|---|
| `.dashboard-shell` | `max-width:1280px` | `max-width:1600px` |
| `th` | `padding:12px 13px` | `padding:12px 10px` |
| `td` | `padding:12px 13px` | `padding:12px 10px` |
| `table` | `min-width:1020px` | `min-width:966px` |

然后在 `@media (max-width:1024px)` 块里**新增一条**（它正是那个横滚缺陷的根 —— 丢了两列却还是硬撑 966px）：

```css
@media (max-width:1024px) {
  .dashboard-shell { padding:22px 20px 34px; }
  .hide-medium { display:none; }
  table { min-width:0; }
}
```
```

> `th` 与 `td` 的内边距**必须同时改**。只改一个会让表头与表体错位，而这在假 DOM 里测不出来、只能人眼发现。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test 2>&1 | grep -E "ℹ (tests|pass|fail)"`
Expected: `fail 0`

- [ ] **Step 5: 人工验证宽度**

`npm start`，在浏览器里把窗口依次调到 **1440 / 1280 / 1024**，用 DevTools 量：
表格卡内是否出现横向滚动条（**前两档不该有**）、`table` 的实际宽度与 `min-width` 值。

- [ ] **Step 6: 提交**

```bash
git add public/index.html test/dashboard-dom.test.js
git commit -m "style: 外壳上限 1600、表格收窄到 966，1024 断点取消表格下限（修横滚缺陷）"
```

---

### Task 6: 两栏结构（左栏容器 + 主区）

把「顶栏 → 概览 → 提示条 → 令牌 → 工具条 → 图例 → 表格卡」改成「顶栏（跨栏）→ 提示条（跨栏）→ 左栏 + 主区 → 页脚（跨栏）」。工具条里的控件搬进左栏，行内元素不变（id 全部保留，所以 `init()` 此刻不需要改）。

**Files:**
- Modify: `public/index.html`（`<body>` 结构与新增样式）
- Test: `test/dashboard-dom.test.js`

**Interfaces:**
- Produces: 结构类名 `.layout` / `.rail` / `.content` / `.title-row` / `.title-actions`；CSS 变量与 id 一律不变
- Consumes: Task 5 的宽度口径

- [ ] **Step 1: 写失败的测试**

把 `test/dashboard-dom.test.js` 里「沿用参考 UI 的外壳结构」那条测试的类名清单换成：

```js
test("沿用参考 UI 的外壳结构，并按两栏重构", () => {
  // 注意：本任务卡片还是旧的 .stat（KPI 卡在 Task 8）；那时本清单里的 "stat" 要改成 "kpi"
  for (const className of ["dashboard-shell", "topbar", "brand", "brand-mark", "eyebrow",
    "headline", "freshness", "layout", "rail", "content", "title-row", "kpis", "stat",
    "search-label", "issue-toggle", "result-count", "legend", "table-card", "table-scroll"]) {
    assert.ok(html.includes(`class="${className}"`) || html.includes(`"${className}`) || html.includes(` ${className}`),
      `缺少结构类名 ${className}`);
  }
  // 工具条与旧的统计条都被拆掉了：控件进左栏、统计改 KPI 卡
  for (const gone of ["class=\"toolbar\"", "class=\"overview\"", "class=\"stats\""]) {
    assert.ok(!html.includes(gone), `${gone} 应当已被拆掉`);
  }
});
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `node --disable-warning=ExperimentalWarning --test test/dashboard-dom.test.js 2>&1 | grep -cE "^not ok"`
Expected: 1 条失败（缺少 layout / rail / content / kpis / kpi / title-row）

- [ ] **Step 3: 重写 `<body>` 的结构**

```html
<body>
  <main class="dashboard-shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">/</span>
        <div>
          <div class="eyebrow">ROUTE OBSERVABILITY</div>
          <h1>报价巡检面板</h1>
        </div>
      </div>
      <div class="top-actions">
        <span class="live-dot" id="live-dot"></span>
        <span class="muted" id="api-state">连接中…</span>
      </div>
    </header>

    <!-- 提示条说的是整个面板的状态（服务不可达 / 库为空），所以跨两栏 -->
    <div class="banner" id="banner" hidden></div>

    <div class="layout">
      <aside class="rail" aria-label="筛选">
        <fieldset class="rail-group">
          <legend class="rail-label">链</legend>
          <label class="select-label">
            <span class="sr-only">选择链</span>
            <select id="chain-select"><option value="">全部链</option></select>
          </label>
        </fieldset>
        <div class="token-box" id="token-box" hidden>
          <span>服务配了访问令牌，请填入：</span>
          <input id="token-input" type="password" placeholder="Bearer token" autocomplete="off" />
          <button type="button" id="token-save">保存并重试</button>
        </div>
      </aside>

      <div class="content">
        <div class="title-row">
          <div>
            <p class="eyebrow">QUOTATION HEALTH</p>
            <p class="headline" id="headline">全部路由的当前报价状态</p>
            <p class="freshness">
              <span class="fresh-dot" id="fresh-dot"></span>
              <span id="freshness">正在加载…</span>
              <span class="separator">·</span>
              <span id="next-refresh"></span>
            </p>
          </div>
          <div class="title-actions">
            <button type="button" class="refresh-button" id="refresh">刷新数据</button>
          </div>
        </div>

        <section class="kpis" aria-label="概览">
          <div class="stat"><span>正常</span><strong id="count-ok">—</strong></div>
          <div class="stat"><span>偏离</span><strong id="count-deviant">—</strong></div>
          <div class="stat stat-fail"><span>失败</span><strong id="count-error">—</strong></div>
          <div class="stat stat-none" id="stat-none" hidden><span>未报价</span><strong id="count-unknown">—</strong></div>
        </section>

        <p class="legend">
          <span>成本 = 付出与所得的美元差额</span>
          <span>较基准 = 相对近 1 小时成功报价中位数（偏离阈值 10%，服务端配置）</span>
          <span>可按 = 已验证可通过的最大金额档位（$ 为名义美元）</span>
        </p>

        <section class="table-card">
          <!-- 表格作用域的控件（搜索 / 仅异常）—— 2026-09-17 第二次修订把它们从左栏移到表格上方，
               见 spec §4.1。id 一律不变，所以 init() 不需要改。 -->
          <div class="table-toolbar">
            <label class="search-label">
              <span class="sr-only">搜索币对</span>
              <span class="search-icon">⌕</span>
              <input id="search" placeholder="搜索源或目标币种" autocomplete="off" />
            </label>
            <label class="issue-toggle">
              <input type="checkbox" id="only-problems" />
              <span class="toggle-box"></span>仅异常
            </label>
          </div>
          <div class="table-scroll">
            <table id="table">
              <thead>
                <tr>
                  <th>币对</th>
                  <th>状态</th>
                  <th>付 → 得</th>
                  <th class="hide-medium">USD</th>
                  <th>成本</th>
                  <th>较基准</th>
                  <th class="depth-col">可按</th>
                  <th class="hide-medium">延迟</th>
                  <th>最后报价</th>
                </tr>
              </thead>
              <tbody id="tbody"></tbody>
            </table>
          </div>
          <div class="table-foot">
            <span class="result-count num" id="shown-count"></span>
          </div>
        </section>

        <p class="empty" id="empty" hidden></p>
      </div>
    </div>

    <footer>
      <span>数据源：/pairs · /latest · /stats?window=1h · /health · /depth</span>
      <span class="num">轮询间隔 30s</span>
    </footer>
  </main>

  <script type="module">
    import { init } from "/dashboard.js";
    init();
  </script>
</body>
```

> **这一任务刻意不改成 KPI 卡**（`.stat` 结构保留，只是换到 `.kpis` 容器里），
> 也不改链控件 —— 那样每个任务都能独立验收，出问题好定位。KPI 卡在 Task 8、链列表在 Task 7。

- [ ] **Step 4: 加两栏与断点的样式**

```css
/* 两栏。minmax(0,1fr) 不能省：否则表格的 min-width 会把栅格列撑破 */
.layout { display:grid; grid-template-columns:222px minmax(0,1fr); gap:24px; align-items:start; }
.rail { display:flex; flex-direction:column; gap:14px; }
.rail-group { display:flex; flex-direction:column; gap:8px; margin:0; padding:0; border:0; }
.rail-label { padding:0 0 0 2px; color:var(--muted); font-size:11px; letter-spacing:.06em; }
.content { min-width:0; }
.title-row { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; padding-bottom:18px; }
.title-actions { display:flex; align-items:center; gap:12px; }
.refresh-button { padding:9px 16px; border:0; border-radius:999px; background:var(--foreground);
  color:var(--surface); cursor:pointer; font-size:12px; }
.kpis { display:flex; gap:10px; margin-bottom:16px; }

/* <1280px：两栏装不下 966px 的表格（视口 − 64 − 246 ≥ 966 ⇒ 视口 ≥ 1276），左栏折成横条 */
@media (max-width:1279px) {
  .layout { grid-template-columns:1fr; }
  .rail { flex-direction:row; flex-wrap:wrap; align-items:flex-start; gap:12px; }
  .rail-group { flex:1 1 260px; }
}
```

删掉旧 `.overview` / `.toolbar` 规则里不再需要的部分（`.overview` 的 padding、`.toolbar` 的上下边框），
`.stat` 的 `border-left` 在 Task 8 换成卡片时一并处理。

- [ ] **Step 5: 跑测试与冒烟**

Run: `npm test 2>&1 | grep -E "ℹ (tests|pass|fail)"`
Expected: `fail 0`（Task 1/2 的纯函数用例已在内）

**人工冒烟**：`npm start` → 确认左栏出现、链下拉与「仅异常」「搜索」可用、表格仍按筛选工作、窄到 1024 时左栏折到上方。

- [ ] **Step 6: 提交**

```bash
git add public/index.html test/dashboard-dom.test.js
git commit -m "feat: 页面改两栏结构，控件进左栏，提示条与页脚跨栏"
```

---

### Task 7: 左栏链列表（替换下拉框）

把 `<select id="chain-select">` 换成**单选组**：语义正确（一次选一条链）、原生键盘行为（组内方向键）、且与现有 `.issue-toggle`（隐藏 input + 样式化外观）同一套路。每行显示链名 + 币对数 + 异常角标。

**Files:**
- Modify: `public/index.html`（左栏那一块 + 新样式）
- Modify: `public/dashboard.js`（`renderChains()` 重写；`currentFilters()` 改读 state；加 change 监听）
- Modify: `test/dashboard-dom.test.js`（id 契约）
- Modify: `test/dashboard-render.test.js`（`mountPage()` 的 id 列表 + 新断言）

**Interfaces:**
- Consumes: `chainCounts(rows)`（Task 2）、`#only-problems`、`#search`、`#shown-count` 的既有 id
- Produces: 新 id **`chain-list`**（替代 `chain-select`）；`state.chain`（string，默认 `""` 表示全部）
- 生成的标记形状：
  ```html
  <label class="chain-item is-sel">
    <input class="sr-only" type="radio" name="chain" value="" checked />
    <span class="chain-name">全部</span>
    <span class="chain-count num">38</span>
  </label>
  <label class="chain-item">
    <input class="sr-only" type="radio" name="chain" value="near" />
    <span class="chain-name">near</span>
    <span class="chain-count num">36</span>
    <span class="chain-problems num">3</span>
  </label>
  ```

- [ ] **Step 1: 写失败的测试**

在 `test/dashboard-render.test.js` 的 `mountPage()` 里把 id 列表中的 `"chain-select"` 换成 `"chain-list"`；然后在文件末尾追加：

```js
test("左栏链列表：全部 + 每条链，计数与异常角标都在", async () => {
  const { elements, restore } = await mountPage();
  try {
    const list = elements.get("chain-list");
    const rows = list.children.map((row) => toHtml(row));
    assert.ok(rows.length >= 3, `至少要有「全部」与两条链，实际 ${rows.length}`);

    const all = rows.find((htmlText) => htmlText.includes(">全部<"));
    assert.ok(all, "第一行应是「全部」");
    assert.ok(all.includes("is-sel"), "默认选中「全部」");
    // value 与 checked 是节点属性（不是 HTML 属性），所以按节点断言
    const allInput = list.children
      .find((label) => toHtml(label).includes(">全部<"))
      .children.find((child) => child.tagName === "INPUT");
    assert.equal(allInput.value, "", "「全部」的 value 是空串");
    assert.equal(allInput.checked, true, "「全部」默认勾选");

    const near = rows.find((htmlText) => htmlText.includes(">near<"));
    assert.ok(near, "应有 near 这一行");
    assert.ok(/class="chain-count num">1<\/span>/.test(near), `计数不对: ${near}`);

    // 数据里 tron 那对是失败的 → 它应带异常角标
    const tron = rows.find((htmlText) => htmlText.includes(">tron<"));
    assert.ok(tron.includes("chain-problems"), `tron 应带异常角标: ${tron}`);
    assert.ok(/class="chain-problems num">1<\/span>/.test(tron), `角标数不对: ${tron}`);
  } finally {
    restore();
  }
});

test("左栏链列表：点一条链会按它筛选表格", async () => {
  const { elements, restore } = await mountPage();
  try {
    const list = elements.get("chain-list");
    const target = list.children.find((row) => toHtml(row).includes(">tron<"));
    const input = target.children.find((child) => child.tagName === "INPUT");
    // 假 DOM 里直接触发 change（真实浏览器由 input 的 change 冒泡到容器）
    input.checked = true;
    list.listeners.change.forEach((handler) => handler({ target: input }));
    const rows = elements.get("tbody").children.map((row) => toHtml(row));
    assert.equal(rows.length, 1, "只应剩涉及 tron 的那一对");
    assert.ok(rows[0].includes("tron:USDT"), rows[0]);
  } finally {
    restore();
  }
});
```

> `FakeNode` 目前没有 `checked` 属性 —— 若第二条测试因它失败，在 `FakeNode` 构造函数里补一行 `this.checked = false;`（这是假 DOM 的能力补齐，不是产品代码改动）。

- [ ] **Step 2: 跑测试确认它失败**

Run: `node --disable-warning=ExperimentalWarning --test test/dashboard-render.test.js 2>&1 | grep -cE "^not ok"`
Expected: 至少 2 条失败（`chain-list` 不存在、`init()` 拿到的 id 是 null）

- [ ] **Step 3: 改 `public/index.html`**

左栏那一块（把 Task 6 里的 `.select-label` 换成链列表容器）：

```html
        <fieldset class="rail-group">
          <legend class="rail-label">链</legend>
          <div class="chain-list" id="chain-list"></div>
        </fieldset>
```

加样式：

```css
.chain-list { display:flex; flex-direction:column; gap:2px; max-height:340px; overflow:auto; }
.chain-item { display:flex; align-items:center; gap:8px; height:29px; padding:0 8px;
  border-radius:7px; cursor:pointer; font-size:13px; }
.chain-item.is-sel { background:var(--surface-alt); font-weight:600; }
.chain-item .chain-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.chain-count { color:var(--muted); font-size:11px; }
.chain-problems { padding:1px 6px; border-radius:999px; background:#faeae8; color:#7f261f; font-size:11px; }
```

- [ ] **Step 4: 改 `public/dashboard.js`**

`init()` 的 refs 里把 `chainSelect: document.getElementById("chain-select"),` 换成
`chainList: document.getElementById("chain-list"),`，然后在 state 里加 `chain: ""`。

`renderChains()` 重写成：

```js
  function renderChains() {
    if (state.chainsBuilt) return;
    // 「全部」那一行是列表的一部分，不是特殊条目 —— 它同样是一个单选项
    const entries = [{ chain: "", label: "全部", pairs: state.rows.length, problems: 0 },
      ...chainCounts(state.rows)];
    for (const entry of entries) {
      const label = document.createElement("label");
      label.className = "chain-item";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "chain";
      input.value = entry.chain;
      input.className = "sr-only";
      const name = document.createElement("span");
      name.className = "chain-name";
      name.textContent = entry.label ?? entry.chain;
      const count = document.createElement("span");
      count.className = "chain-count num";
      count.textContent = String(entry.pairs);
      label.append(input, name, count);
      if (entry.problems > 0) {
        const badge = document.createElement("span");
        badge.className = "chain-problems num";
        badge.textContent = String(entry.problems);
        label.append(badge);
      }
      // 「全部」默认选中 —— 初始态要在建的时候就定，不能只靠 change 事件
      if (entry.chain === "") {
        input.checked = true;
        label.classList.add("is-sel");
      }
      el.chainList.append(label);
    }
    el.chainList.addEventListener("change", (event) => {
      const input = event.target;
      if (input?.name !== "chain") return;
      state.chain = input.value;
      for (const label of el.chainList.children) {
        const own = label.children.find((child) => child.tagName === "INPUT");
        label.classList.toggle("is-sel", own === input);
      }
      renderRows();
    });
    state.chainsBuilt = true;
  }
```

`currentFilters()` 改读 state：

```js
  const currentFilters = () => ({
    onlyProblems: el.onlyProblems.checked,
    chain: state.chain,
    query: el.search.value,
  });
```

`renderChains()` 的调用点必须挪到**第一次 `renderRows()` 之后** —— 它现在依赖 `state.rows`（「全部」那一行要显示总数）。
在 `load()` 里确保这个顺序：

```js
      state.rows = buildRows({
        pairs: state.pairs,
        latest: latest.latest ?? [],
        stats: stats.pairs ?? [],
        depth: state.depth,
        nowIso: new Date().toISOString(),
      });
      renderChains();   // 必须在 state.rows 就绪之后：它要总数与每链计数
      renderRows();
```

> 链列表只建一次（`state.chainsBuilt`）。但 `state.rows` 每轮都会变 —— 计数会过时。
> **本任务接受这个过时**（列表只在首轮建一次），因为它只影响「全部」与各链的计数数字。
> 若你要让它每轮都刷新，把 `state.chainsBuilt` 的判断去掉即可，但那会让滚动位置每 30 秒归零 —— 不划算。

- [ ] **Step 5: 把链列表的新组合加进对比度矩阵**

在 `test/contrast.test.js` 的 `PAIRS` 里追加（放在徽章那几行后面）：

```js
  // 左栏链列表：新出现的组合。计数与说明行虽然落在已有组合上，仍然**从规则读值**再断言一次 ——
  // 这样将来把 .chain-count 的颜色改淡就会被这条抓住，而不是靠人眼。
  ["链列表：选中项", token("foreground"), token("surface-alt"), 4.5],
  ["链列表：计数（选中行上）", fromRule(/\.chain-count\s*\{([^}]*)\}/, "color"), token("surface-alt"), 4.5],
  ["链列表：异常角标", fromRule(/\.chain-problems\s*\{([^}]*)\}/, "color"), fromRule(/\.chain-problems\s*\{([^}]*)\}/, "background"), 4.5],
```

若哪一条 **< 4.5，停下来报告，不要下调阈值** —— 那说明我给的某个色值不达标，要重选（选值前我已经算过，
预期分别是 **14.63 / 4.66 / 8.18**）。

同时确认 `init()` 的 id 集合变更被第一条测试（id 都存在）覆盖：`chain-select` 已消失、`chain-list` 已在 HTML 里。

- [ ] **Step 6: 跑测试与冒烟**

Run: `npm test 2>&1 | grep -E "ℹ (tests|pass|fail)|^not ok"`
Expected: `fail 0`

**人工冒烟**：链列表可点、选中态有底色、「全部」在首位、计数与 `/latest` 状态分布对得上、
选 tron 后表格只剩涉及 tron 的币对、纯键盘 Tab + 方向键也能选。

- [ ] **Step 7: 提交**

```bash
git add public/index.html public/dashboard.js test/dashboard-dom.test.js test/dashboard-render.test.js
git commit -m "feat: 左栏链筛选从下拉框改为带计数与异常角标的单选列表"
```

---

### Task 8: KPI 卡（图标 + 小标签 + 大数字 + 说明行）

**Files:**
- Modify: `public/index.html`（`.kpis` 那块 + 样式 + 480px 断点）
- Modify: `public/dashboard.js`（写说明行）
- Modify: `test/dashboard-render.test.js`（`mountPage()` 的 id 列表 + 新断言）

**Interfaces:**
- Consumes: `shareCaption(count, total)`（Task 1）
- Produces: 新 id **`caption-ok` / `caption-deviant` / `caption-error` / `caption-unknown`**（`init()` 要查这四个）

- [ ] **Step 1: 写失败的测试**

在 `test/dashboard-render.test.js` 的 `mountPage()` 的 id 列表里加上那 4 个 caption id，并追加：

```js
test("KPI 卡：四张卡有图标、小标签、大数字与真实占比说明行", async () => {
  const { elements, restore } = await mountPage();
  try {
    const ok = toHtml(elements.get("count-ok").parentNode);
    assert.ok(ok.includes('aria-hidden="true"'), "图标应被读屏跳过（状态已由文字表达）");
    assert.ok(ok.includes("正常"), "要有中文小标签");
    assert.ok(ok.includes('class="kpi-value num"'), "大数字要带等宽数字类");
    // 假数据是 2 对：1 对 ok、1 对 error（见 PAIRS / LATEST）
    assert.equal(elements.get("caption-ok").textContent, "2 对中的 50%");
    assert.equal(elements.get("caption-error").textContent, "2 对中的 50%");
    assert.equal(elements.get("caption-deviant").textContent, "2 对中的 0%");
  } finally {
    restore();
  }
});
```

> 上面期望值按 `test/dashboard-render.test.js` 现有的假数据算出来：`PAIRS` 里 2 对，
> `LATEST` 里 1 对 `stateStatus:"ok"`、1 对 `stateStatus:"error"` ⇒ 50% / 50% / 0%。
> 改假数据就要同步改这三行 —— **不要反过来把实现改成迁就断言**。

- [ ] **Step 2: 跑测试确认它失败**

Run: `node --disable-warning=ExperimentalWarning --test test/dashboard-render.test.js 2>&1 | grep -cE "^not ok"`
Expected: 1 条失败（`caption-ok` 拿到 null）

- [ ] **Step 3: 改 `public/index.html` 的 KPI 卡**

```html
        <section class="kpis" aria-label="概览">
          <div class="kpi" id="kpi-ok">
            <span class="kpi-icon" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                   stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="8" cy="8" r="6.2" /><path d="M5.2 8.2l2 2 3.6-4" />
              </svg>
            </span>
            <span class="kpi-label">正常</span>
            <strong class="kpi-value num" id="count-ok">—</strong>
            <span class="kpi-caption" id="caption-ok"></span>
          </div>
          <div class="kpi" id="kpi-deviant">
            <span class="kpi-icon" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                   stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
                <path d="M2 10l3-4 3 3 3-5 3 4" />
              </svg>
            </span>
            <span class="kpi-label">偏离</span>
            <strong class="kpi-value num" id="count-deviant">—</strong>
            <span class="kpi-caption" id="caption-deviant"></span>
          </div>
          <div class="kpi kpi-fail" id="kpi-error">
            <span class="kpi-icon" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                   stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="8" cy="8" r="6.2" /><path d="M8 4.8v4M8 11.2h.01" />
              </svg>
            </span>
            <span class="kpi-label">失败</span>
            <strong class="kpi-value num" id="count-error">—</strong>
            <span class="kpi-caption" id="caption-error"></span>
          </div>
          <div class="kpi kpi-none" id="stat-none" hidden>
            <span class="kpi-icon" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                   stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="8" cy="8" r="6.2" /><path d="M5 8h6" />
              </svg>
            </span>
            <span class="kpi-label">未报价</span>
            <strong class="kpi-value num" id="count-unknown">—</strong>
            <span class="kpi-caption" id="caption-unknown"></span>
          </div>
        </section>
```

样式（替换旧的 `.stat` 规则）：

```css
.kpi { flex:1; min-width:0; padding:13px 15px 12px; background:var(--surface);
  border:1px solid var(--border); border-radius:var(--radius); }
.kpi-icon { display:block; margin-bottom:7px; color:var(--muted); }
.kpi-label { display:block; color:var(--muted); font-size:11px; }
.kpi-value { display:block; color:var(--foreground); font-size:30px; font-weight:700; line-height:1.2; letter-spacing:-.8px; }
.kpi-caption { display:block; color:var(--muted); font-size:11px; }
.kpi-fail .kpi-value { color:var(--red); }
.kpi-fail .kpi-icon { color:var(--red); }
```

480px 断点里的 `.stats strong` 改成：

```css
@media (max-width:480px) { #api-state { display:none; } .kpi-value { font-size:24px; } }
```

- [ ] **Step 4: 改 `public/dashboard.js`**

`init()` 的 refs 里删掉 `statNone` 之外旧的统计 id（`countOk` 等 id 不变，**保留**），加上四个 caption：

```js
    captionOk: document.getElementById("caption-ok"),
    captionDeviant: document.getElementById("caption-deviant"),
    captionError: document.getElementById("caption-error"),
    captionUnknown: document.getElementById("caption-unknown"),
```

在写统计数字的那一段（约 676 行）之后补上说明行：

```js
      const total = state.rows.length;
      el.captionOk.textContent = shareCaption(counts.ok, total);
      el.captionDeviant.textContent = shareCaption(counts.deviant, total);
      el.captionError.textContent = shareCaption(counts.error, total);
      el.captionUnknown.textContent = shareCaption(counts.unknown, total);
```

并在文件顶部把 `shareCaption` 加进那个从纯函数区导入的 import（`shareCaption` 与 `init()` 在**同一个文件**里，所以**不需要 import** —— 直接用）。

- [ ] **Step 5: 同步契约测试、对比度矩阵，跑测试与冒烟**

两处测试要改：

1. **`test/dashboard-dom.test.js`**：Task 6 那条结构类名清单里的 `"stat"` 换成 `"kpi"`（旧的 `.stat` 规则已被 `.kpi` 取代）
2. **`test/contrast.test.js`** 的 `PAIRS` 追加：

```js
  // KPI 说明行与标题行副标题都是 --muted，与已有的「次要文字」组合重叠；
  // 仍然从规则读值再断言一次，把这两条规则的颜色钉住。
  ["KPI 说明行", fromRule(/\.kpi-caption\s*\{([^}]*)\}/, "color"), token("surface"), 4.5],
  ["标题行副标题", fromRule(/\.freshness\s*\{([^}]*)\}/, "color"), token("background"), 4.5],
```

Run: `npm test 2>&1 | grep -E "ℹ (tests|pass|fail)|^not ok"`
Expected: `fail 0`。若新增的对比度断言有一条不过，**停下来报告，不要下调阈值**。

**人工冒烟**：四张卡（未报价为 0 时只有三张）、图标与文字都在、说明行是「N 对中的 X%」、
失败卡的数字与图标是红的、窄到 480px 时状态文字消失但状态点还在。

- [ ] **Step 6: 提交**

```bash
git add public/index.html public/dashboard.js test/dashboard-render.test.js
git commit -m "feat: 概览改 KPI 卡（图标 + 小标签 + 大数字 + 真实占比说明行）"
```

---

### Task 9: 表格卡外观（工具条胶囊 / 吸顶表头 / 定高滚动 / 页脚计数）

取自 **beUI Pro 的 Data Table** 的视觉与结构（spec §4.1、§2 的第二次修订记录）。
**只取视觉，不取它的交互**：不做行勾选与「全选」（我们没有批量操作）、不做列排序（我们的排序是刻意的「失败优先」）、
不做虚拟滚动与分页（我们只有 38 行）。

**Files:**
- Modify: `public/index.html`（`.table-toolbar` 里的胶囊标记 + 表格卡样式）
- Test: `test/dashboard-dom.test.js`

**Interfaces:**
- Consumes: Task 6 已就位的 `.table-toolbar` / `.table-foot` / `#shown-count` / `#only-problems` / `#search`
- Produces: 新类名 **`.chip-body`**（可反色的胶囊体，替代旧的 `.toggle-box`——后者连同它的 `inset` 内填充规则一并删除）；
  id 一律不变，**`dashboard.js` 本任务零改动**

- [ ] **Step 1: 写失败的测试**

在 `test/dashboard-dom.test.js` 末尾追加：

```js
  test("表格卡：工具条、吸顶表头、定高滚动、页脚计数都在", () => {
    assert.ok(html.includes('class="table-toolbar"'), "缺少表格工具条");
    assert.ok(html.includes('class="table-foot"'), "缺少表格页脚");
    // 吸顶表头：必须给 th 本身上 sticky，并配实色底（半透明会透出行内容）
    const sticky = html.match(/th\s*\{[^}]*position:\s*sticky/);
    assert.ok(sticky, "th 缺少 position:sticky");
    assert.match(html, /th\s*\{[^}]*background:\s*var\(--surface-alt\)/, "吸顶表头必须是实色底");
    // 定高滚动：滚动必须发生在表格自己的容器里（页面级 sticky 会被 .table-card 的 overflow 掐掉）
    const scroll = html.match(/\.table-scroll\s*\{([^}]*)\}/)[1];
    assert.match(scroll, /max-height:/, ".table-scroll 缺少 max-height");
    assert.match(scroll, /overflow-y:\s*auto/, ".table-scroll 缺少 overflow-y:auto");
    assert.match(scroll, /scrollbar-gutter:\s*stable/, "缺少 scrollbar-gutter:stable（避免滚动条出现时列宽跳动）");
  });

  test("表格卡：筛选胶囊用 chip-body，且旧的 toggle-box 已清理", () => {
    assert.ok(html.includes('class="chip-body"'), "缺少胶囊体");
    assert.ok(!html.includes("toggle-box"), "旧的方块控件应已删除");
    assert.match(html, /\.chip-body\s*\{[^}]*border-radius:\s*999px/, "胶囊要是全圆角");
    // 选中态反色：用相邻兄弟选择器，不需要 :has() 也不需要 JS
    assert.match(html, /input:checked\s*\+\s*\.chip-body\s*\{[^}]*background:\s*var\(--foreground\)/,
      "选中态要用黑底浅字（与刷新按钮同一对色值）");
  });
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `node --disable-warning=ExperimentalWarning --test test/dashboard-dom.test.js 2>&1 | grep -cE "^not ok"`
Expected: 2 条失败

- [ ] **Step 3: 改标记与样式**

先把工具条里的方块控件换成胶囊体（**只改这一个类名，其余标记不动**）：

```html
            <label class="issue-toggle">
              <input type="checkbox" id="only-problems" />
              <span class="chip-body">仅异常</span>
            </label>
```

再加样式：

```css
/* 表格工具条：左侧搜索、右侧筛选胶囊 */
.table-toolbar { display:flex; align-items:center; gap:10px; padding:12px 14px; border-bottom:1px solid var(--border); }
.table-toolbar .search-label { flex:0 1 300px; height:36px; }

/* 筛选胶囊：全圆角；选中态反色（与刷新按钮同一对色值，不新增颜色） */
.issue-toggle { display:inline-flex; align-items:center; cursor:pointer; }
.issue-toggle input { position:absolute; opacity:0; }
.chip-body { display:inline-flex; align-items:center; height:36px; padding:0 14px;
  border:1px solid var(--border); border-radius:999px; background:var(--surface);
  color:var(--muted); font-size:12px; }
.issue-toggle input:checked + .chip-body { background:var(--foreground); border-color:var(--foreground); color:var(--surface); }
.issue-toggle input:focus-visible + .chip-body { outline:2px solid var(--ring); outline-offset:2px; }

/* 吸顶表头：实色底 + sticky（滚动发生在 .table-scroll 里，所以 sticky 以它为参照） */
th { position:sticky; top:0; z-index:1; padding:12px 10px; background:var(--surface-alt);
  color:var(--muted); font-size:11px; font-weight:600; letter-spacing:.04em; white-space:nowrap; }

/* 定高滚动：max-height 见 spec §13（提议 min(70vh, 720px)，人眼确认后再调） */
.table-scroll { overflow:auto; max-height:min(70vh, 720px); scrollbar-gutter:stable; }

/* 页脚计数条 */
.table-foot { display:flex; align-items:center; justify-content:space-between;
  padding:10px 14px; border-top:1px solid var(--border); color:var(--muted); font-size:11px; }
```

同时**删掉**旧的 `.toggle-box` 规则与 `.issue-toggle input:checked + .toggle-box` 那条 —— 方块控件已被胶囊取代，
留着就是死代码（它是全项目最后一处 `inset` 投影用法，删掉之后 `box-shadow` 在样式表里彻底消失）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test 2>&1 | grep -E "ℹ (tests|pass|fail)|^not ok"`
Expected: `fail 0`

- [ ] **Step 5: 人工冒烟（本任务最依赖人眼）**

`npm start`，在 1440 宽度下确认：

1. 页面往下滚时，**表头吸在表格容器顶部**，且滚动时不会有行内容从表头底下透出来（这是实色底的意义）
2. 表格**内部**出现纵向滚动条（页面本身不再被 38 行撑长），滚动时左栏与标题行**不动**
3. Tab 到表格的行：焦点框四边仍完整可见（`outline-offset:-2px` 那条修正不能被这次改动破掉）
4. 点「仅异常」：胶囊从浅底深字变成**黑底浅字**，表格只剩非 ok 的行
5. 页脚的 `N / M 对` 随筛选变化
6. 纯键盘：Tab 能到搜索框、胶囊，方向键/空格能切换胶囊

- [ ] **Step 6: 提交**

```bash
git add public/index.html test/dashboard-dom.test.js
git commit -m "style: 表格卡加工具条胶囊、吸顶表头、定高滚动与页脚计数"
```

---

### Task 10: 文档与冒烟清单

**Files:**
- Modify: `AGENTS.md`、`docs/ui-requirements.md`、`README.md`、`HANDOFF.md`

**Interfaces:**
- Consumes: 前面所有任务的最终形态

- [ ] **Step 1: 更新 `AGENTS.md` 的设计系统一节**

把「主题是浅色…」那几条改成反映新事实，并补两栏结构与字体栈：

```markdown
- 主题是浅色，中性色是中性灰（`--background:#f4f4f4`，`color-scheme:light`）。
- **字体**：全局正文栈 `Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`；
  **没有任何等宽声明**，数字靠 `.num`（`font-variant-numeric: tabular-nums`）对齐。
  注意中文在等宽与正文下字形相同（CJK 走系统回退），所以这个选择只影响拉丁与数字。
- **结构**：两栏 —— `.rail`（222px，链筛选 / 仅异常 / 搜索 / 令牌）+ `.content`（标题行 / KPI 卡 / 图例 / 表格卡）。
  视口 **<1280px** 时左栏折成主区上方的横条；**≤1024px** 丢两列并取消表格的 `min-width`。
```

- [ ] **Step 2: 更新 `docs/ui-requirements.md`**

- 新增结构需求（两栏、左栏链列表、窄屏折横条）与排版需求（正文族 + `tabular-nums`）的编号条目
- 更新 V1（色值集合）、V3（主题与 `--background` 的值）、V5（字体：**不再是「数字与代码用 JetBrains Mono」**）
- 重写 §12 已知缺口：渲染层仍只有假 DOM 覆盖、首轮 `/health` 503、`.legend` 窄屏折行，以及**新增**「左栏横条形态与 480px 取舍只有人眼能验」

- [ ] **Step 3: 扩 `README.md` 的冒烟清单到约 14 条**

在现有 10 条之后追加（编号 11 起）：

```markdown
11. 两栏：左栏在左、表格在右；把窗口缩到 1280 以下，左栏应折成主区上方的横条
12. 链列表：点「near」只剩涉及 near 的币对；点「全部」恢复；选中行有底色
13. 链计数与 `/latest` 的状态分布对得上（用第 2 步那条 curl 核对），异常角标只出现在真有异常的链上
14. KPI 说明行是「N 对中的 X%」；若某状态有量但占比极小，应显示 `<1%` 而不是 `0%`
15. 数字列（USD / 成本 / 较基准 / 可按 / 延迟）右对齐且各行小数点对齐
16. 往下滚时**表头吸在表格容器顶部**，不会有行内容从表头底下透出来；纵向滚动发生在**表格内部**，左栏与标题行不动
17. 「仅异常」胶囊选中后变**黑底浅字**，表格只剩非 ok 的行；页脚的 `N / M 对` 跟着变（且与工具条/标题行的计数一致）
```

- [ ] **Step 4: 更新 `HANDOFF.md` 的面板一节**

补：两栏结构与断点、左栏链列表的行为（只建一次、计数不过时刷新）、新纯函数 `formatSharePct` / `shareCaption` / `chainCounts`、以及「左栏在 <1280px 折横条」。

- [ ] **Step 5: 跑全套测试 + 按新清单人工过一遍**

Run: `npm test 2>&1 | grep -E "ℹ (tests|pass|fail)"`
Expected: `fail 0`

然后 `npm start`，**在 1440 / 1280 / 1024 三档各走一遍那 17 条**。

- [ ] **Step 6: 提交**

```bash
git add AGENTS.md docs/ui-requirements.md README.md HANDOFF.md
git commit -m "docs: 同步两栏结构与排版变更，冒烟清单扩到 15 条"
```

---

## 收尾检查（全部任务完成后）

- [ ] `npm test` 全绿，且用例数**比开工前多**（新增 `formatSharePct`×3 / `shareCaption`×1 / `chainCounts`×5 + 结构类名与排版各 2 + 横向预算 2 + 表格卡 2 + 渲染 3）
- [ ] `grep -c "JetBrains Mono\|mono" public/index.html public/dashboard.js` 全为 0
- [ ] **全项目再无 `box-shadow` 用法**（最后一处 `inset` 内填充随 `.toggle-box` 一并删掉）；`contrast.test.js` 那条「不用投影做层级」仍绿
- [ ] `git status` 干净；`git log --oneline feat/neutral-palette..HEAD` 有 10 个提交
- [ ] **没有**合并到 `main`；`data/monitor.db` 不在暂存区
- [ ] README 的 17 条冒烟清单在 1440 / 1280 / 1024 三档都过了一遍
- [ ] spec 第 13 节的五条「未决」逐条确认：表格定高滚动高度、左栏横条形态、480px 处理、4 个图标、链列表 `max-height:340px`
