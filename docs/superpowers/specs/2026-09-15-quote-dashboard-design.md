# 报价监控面板 设计

日期：2026-09-15
状态：待评审
前置：`docs/superpowers/specs/2026-09-15-near-intents-monitoring-design.md`（后端，已实现并合入 `main`）

## 1. 目标

一个由现有监控服务托管的只读页面，回答一个问题：**现在这 38 对的报价情况怎么样**。

打开就是运维巡检：一屏扫完所有币对的当前状态、成交价、相对基准的偏离、延迟；红的行能看清对方返回的原文错误；点行能展开排障细节。

**非目标**（本期不做）：

- 历史图表与时间序列视图（`/history`、`/alerts` 本期不消费）
- 导出、分享、多页路由、深色/浅色切换
- 移动端 App 级适配（窄屏折叠成卡片即可，不做打磨）
- 任何写操作 —— 后端 API 是只读的
- 实时推送（后端没有事件流，本期也不加，见 §3）

## 2. 现状与约束

已被现有项目锁死、不需要决策的前提：

| 约束 | 来源 | 后果 |
|---|---|---|
| 零运行时依赖 | 后端 `package.json` | 不能引 React / Chart.js / 任何 npm 包 |
| 无构建步骤 | 同上 | 纯 HTML + CSS + 原生 ES 模块，浏览器直接跑 |
| UI 文案中文 | 项目约定（AGENTS 与后端一致） | 页面文案、错误提示全中文；标识符英文 |
| 后端只读、CORS 默认 `*` | 后端 spec §8 | 页面只能读；同源部署后 CORS 不再参与 |
| 后端零改动最小化 | 用户决策（本期只加一条静态路由） | 不给后端加 SSE / 聚合端点 / 配置端点 |

**数据现实**（读 `data/monitor.db` 实测，2026-09-15）：38 对；10 轮报价共 380 条；38 个小时桶；50 条告警事件；状态分布 33 `ok` / 5 `error`。所以页面首次打开时窗口内样本是 10 条量级，不是满一天的 1440 条 —— 基准数字会跳，这是数据阶段问题而非缺陷。

**API 契约**（本设计消费的字段，已在内存库上起真实 server 验证过形状，非凭记忆）：

```
GET /pairs                → { pairs: [ { id, label, fromKey, toKey, fromAsset, toAsset,
                                        swapType, amount, amountMinor, fromDecimals, toDecimals,
                                        enabled, updatedAt,
                                        state: { status, statusSince, lastOkTs, consecutiveFailures } | null } ] }

GET /latest               → { latest: [ { id, ts, pairId, ok, httpStatus, latencyMs,
                                         amountIn, amountOut, amountInUsd, amountOutUsd,
                                         minAmountIn, minAmountOut, timeEstimate, correlationId,
                                         errorCode, errorMessage,
                                         stateStatus, stateSince, stateFailures } ] }

GET /stats?window=1h      → { window, since, resolution: "raw",
                              pairs: [ { pairId, n, okN, okRate,
                                         metric: { median, p95, min, max },
                                         latency: { median, p95 } } ] }

GET /health               → { ok, startedAt, lastRoundTs, lastRoundAgeMs, lastRoundDurationMs,
                              consecutiveRoundErrors, pairs, dbBytes }
```

两处必须注意的细节：

1. **`/latest` 不带 decimals。** 金额是链上最小单位的字符串（如 `"1501955004"` = 1501.955004 USDC），要除以 `10^decimals` 才是人类可读值。decimals 只在 `/pairs` 里（`fromDecimals`/`toDecimals`）。所以**必须 fetch `/pairs` 再做关联**，不能只靠 `/latest`。
2. **`window=7d` 会切到 `resolution: "hourly"`**，此时 `metric` 只有 `{mean,min,max}`、没有 `median`。本期只用 `1h`（`resolution: "raw"`，有 `median`），但代码不能假设 `metric.median` 一定存在。

## 3. 方案选择

| 方案 | 说明 | 判断 |
|---|---|---|
| **A. 静态文件 + 定时轮询** | 页面每 30 秒并行拉 `/latest`、`/stats?window=1h`、`/health`，纯前端渲染；后端只加一条静态路由 | **采用**。后端已经为它准备好了（CORS、`res=raw\|hourly`、`window=1h\|24h\|7d`），轮询 30 秒对 1 分钟一轮的采集节奏完全够用 |
| B. 后端 SSE / WebSocket 推送 | 数据一变即推 | 否。要在已经合并送审过的后端里加事件流与连接生命周期管理，收益只是把延迟从 30 秒压到 0；而数据本身每 60 秒才更新一次，延迟下限是采集周期，不是传输方式 |
| C. 只手动刷新 | 不自动轮询 | 否。面板的价值就是「扫一眼」，手动刷新等于没有面板 |

## 4. 页面结构

```
┌ 顶栏 ─────────────────────────────────────────────────────────────┐
│ NEAR Intents 报价监控     ● 33 正常   ● 0 偏离   ● 5 失败          │
│ 最后更新 12 秒前 · 采集正常 · 阈值 10%（服务端配置）   [手动刷新]   │
├ 过滤 ─────────────────────────────────────────────────────────────┤
│ [全部 | 仅异常]  [链 ▾]  [搜索币对…]                               │
├ 主表 ─────────────────────────────────────────────────────────────┤
│ 币对 │ 状态 │ 付 → 得 │ USD │ 偏离 │ 延迟 │ 最后报价 │ 备注        │
│ …点任意行展开详情…                                                │
└───────────────────────────────────────────────────────────────────┘
```

**状态色**：`ok` 绿 / `deviant` 黄 / `error` 红，沿用 `near-intents.html` 的 CSS 变量（`--ok` / `--err` / `--accent`），新增一个 `--warn`。

**默认排序**：`error` → `deviant` → `ok`，同状态内按币对 id 字典序。理由：打开页面第一眼必须是坏的那些；稳定的次序也让相邻两次刷新的对比有意义。

**过滤语义**（两处容易含糊，先定死）：

- `[全部 | 仅异常]`：`仅异常` = 状态**不是** `ok` 的，即 `error` 与 `deviant` 都算
- `[链 ▾]`：下拉列出所有在 `fromKey` 或 `toKey` 里出现过的链（去重、按字母序）；选中后只显示**涉及该链**的币对（不论它是源还是目标）。理由是白名单是以 NEAR 稳定币为枢纽的双向形状，单看源或单看目标都会漏掉一半
- `[搜索币对…]`：对 `fromKey → toKey` 做不区分大小写的子串匹配

**空态**：服务不可达、以及「服务在跑但库还是空的」（采集未满一轮）是两种不同的空态，文案要分开 —— 前者指向服务进程，后者指向「等一轮」。

## 5. 每行字段与来源

| 列 | 来源 | 规则 |
|---|---|---|
| 币对 | `/pairs` 的 `fromKey → toKey` | |
| 状态 | **`/latest` 的 `stateStatus`** | 见 §5.1。**不用 `/pairs` 里的 `state`** —— 那是启动那一刻的快照，到第二次刷新就陈旧了 |
| 付 → 得 | `/latest` 的 `amountIn`、`amountOut` ÷ `10^decimals` | decimals 来自 `/pairs`；格式规则见下 |
| USD | `/latest` 的 `amountInUsd` | 只显示源侧；目标侧 USD 与它冗余 |
| 偏离 | `(Number(amountIn) − stats.metric.median) / stats.metric.median × 100` | 见 §5.1；保留 2 位小数并带正负号 |
| 延迟 | `/latest` 的 `latencyMs` | `> 5000` 标黄 |
| 最后报价 | `/latest` 的 `ts` | 相对时间，`title` 里放绝对 ISO 时间 |
| 备注 | `/latest` 的 `errorCode` + `errorMessage` | **直接显示对方返回的原文，不翻译** |

**金额格式规则**（`formatAmount`，必须可单测，所以规则要穷尽且确定）：

- `null` / `undefined` / 非数字 → `—`
- `0` → `0`
- `|v| >= 1000` → 千分位分隔 + 2 位小数（`1,501.96`）
- `1 <= |v| < 1000` → 4 位小数（`1.5019`）
- `|v| < 1` → 6 位**有效数字**（`0.000001` 而**不是** `0.0000`；`0.051234` → `0.051234`）

**不要用 `toLocaleString`**：它的输出取决于运行环境的 locale，会让单测在不同的机器上得到不同结果。手写千分位。

**相对时间规则**（`formatRelativeTime(tsIso, nowIso)`，`nowIso` 必须作参数传入以便测试）：

- 无法解析或为 `null` → `—`
- 差值 < 0（时钟偏移导致的未来时间）→ `刚刚`
- < 60 秒 → `N 秒前`
- < 60 分钟 → `N 分钟前`
- < 24 小时 → `N 小时前`
- 其余 → `N 天前`


**展开详情**（点行）：`correlationId`、`minAmountOut` vs `amountOut`、`stateFailures`（连续失败次数）、`httpStatus`、`timeEstimate`、`swapType`、该对的配置金额 `amount`。

### 5.1 状态与偏离的口径（本设计最重要的一条）

**状态列一律取 `stateStatus`（即服务端 `pair_state.status`），页面绝不自己判定状态。**

理由：状态是服务端用**真实配置**下的 `detect.priceDeviationPct`（默认 10）与 `detect.minSamples`（默认 5）算出来的。这两个值都不在 API 里暴露。若页面自己拿 10 和 5 去判定，运维一旦改了配置，页面就会与告警说法不一致 —— 而会骗人的监控面板比没有面板更糟。

**偏离列只做展示，不做判定**：

- `stats.metric.median` 存在 → 显示百分比（如 `+1.30%`），正负号保留
- 该对在 `/stats` 里没有条目，或 `metric` 为 `null` → 显示 `—`（窗口内没有可用的成功样本）
- `stats.okN < 5` → 数字照常显示，但降饱和度渲染并在 `title` 里说明「样本 N 条，服务端样本不足时不判定偏离」。**不隐藏数字**：隐藏会让人以为「没有偏离」，而实际是「暂时测不准」

**顶栏要显示当前阈值**（`阈值 10%（服务端配置）`）—— 因为页面不持有这个值，运维需要知道页面上的黄色是谁定的。

## 6. 数据获取与刷新

**请求编排**：

- 启动时一次：`/pairs`（币对表 + decimals + 配置金额），失败则整页显示「服务不可达」
- **每次刷新并行发三个**：`/latest`、`/stats?window=1h`、`/health`。三个 payload 都很小（38 对量级），但 `/health` 是判断「服务活着但采集停了」的唯一手段，不能等出错才拉
- **不做单币对下拉查询** —— 38 对全量拉一次比按下钻再查更便宜，也省掉缓存与失效逻辑

**节奏**：

- 每 **30 秒**一次（采集周期 60 秒，30 秒足够把延迟压到半个周期以内）
- `document.visibilityState === "hidden"` 时**暂停**轮询；重新可见时立即刷一次。避免后台标签页常年轰击服务
- 失败时指数退避：30s → 60s → 120s 封顶；成功后复位
- 顶栏始终显示「最后更新 N 秒前」，并且**当 `lastRoundAgeMs` 超过 3 个采集周期时把这一行标黄** —— 复用服务端 `/health` 的陈旧判定口径

**失败与陈旧态**：

- 请求失败 → 保留上一次的数据继续显示，顶栏换红字「服务不可达（已重试 N 次）」，页面不清空。理由：陈旧但真实的数据比空白有用，但必须明确标注陈旧
- `/health` 是判断「服务活着但采集停了」的唯一手段，所以与另外两个请求**同频并行**拉取，并据此在两处给信号：顶栏文案 + `consecutiveRoundErrors > 0` 时追加「采集轮次连续失败 N 次」

**令牌**：

- 若后端配了 `server.bearerToken`，所有 API 请求要带 `Authorization: Bearer <token>`。令牌取自 `localStorage`，由页面在收到 **401** 时弹出一个输入框让用户填（填完重试）
- 静态页面本身**不做令牌校验**（否则拿不到页面就没法提交令牌）—— 这是有意的，页面里没有任何密钥，数据仍受保护

## 7. 后端改动（本期唯一一处）

`src/server.js` 加一张**显式白名单**的静态路由表，不做通用静态服务器（避免路径穿越，也不需要 `..` 处理逻辑）：

```js
const PUBLIC_FILES = {
  "/":             ["public/index.html",   "text/html; charset=utf-8"],
  "/index.html":   ["public/index.html",   "text/html; charset=utf-8"],
  "/dashboard.js": ["public/dashboard.js", "text/javascript; charset=utf-8"],
};
```

- 命中的路径在 **方法校验之后、bearer 校验之前**处理（于是 `OPTIONS /` 仍是 204、`POST /` 仍是 405，而 GET 不需要令牌）
- 文件读取失败 → 500 并记录，不抛未捕获异常（沿用既有 `try/catch` 兜底）
- 静态路由也要带 CORS 头（与其他路径一致，虽然同源时用不上）
- 其余路径与行为完全不变

## 8. 模块划分与可测性

项目零依赖、无 DOM 测试框架，所以页面渲染代码无法在仓库内单测。因此把逻辑切成两层：

| 文件 | 职责 | 可测性 |
|---|---|---|
| `public/dashboard.js` | 纯函数：金额换算（base unit → 人类可读）、偏离计算、相对时间、排序优先级、状态归并、币对与报价的关联；以及一个 `init()` | 纯函数**不碰 `document`**，可被 `node:test` 直接 `import` 测试 |
| `public/index.html` | 标记 + 样式，`<script type="module" src="/dashboard.js">` 调用 `init()` | 不单测；靠手工冒烟 |

约束：`public/dashboard.js` **在模块顶层不得访问 `document`/`window`/`fetch`**，否则 `node:test` 一 import 就炸。所有 DOM 与网络访问都关在 `init()` 及其下游函数里。

**新增测试**：

- `test/dashboard.test.js` —— 测纯函数：金额换算（§5 四条分档全部覆盖，含 6/8/18 位小数、`0.000001` 不显示为 `0.0000`、`null` 输入）、偏离计算（正负、`median` 为 `null`、`median` 为 0 的除零保护）、相对时间（秒/分/时/天、未来时间、`null`）、排序优先级（error < deviant < ok，同状态按 id）、`/pairs` 与 `/latest` 的关联（币对缺少 decimals、`/latest` 有而 `/pairs` 没有的孤儿行）
- `test/server.test.js` 追加 —— 静态路由：`GET /` 返回 200 + `text/html` + 内容含面板标题；`GET /dashboard.js` 返回 200 + `text/javascript`；未列出的路径仍 404（特别是 `/public/index.html` 与 `/../package.json` 必须 404，证明没有目录穿越）

**手工冒烟**（唯一需要人眼的一步）：`npm start`，浏览器打开 `http://127.0.0.1:8787/`，对照 `data/monitor.db` 里的 5 条红对核实错误原文与状态色。

## 9. 风险与未决

| 风险 | 处理 |
|---|---|
| 渲染代码无自动化回归保护，只有纯函数被测 | 接受。纯函数承接了全部算术与排序（也就是会出错的那部分），DOM 部分只是赋值。冒烟清单写进 README 的「面板」一节 |
| 基准窗口只有 10 个样本时数字跳动 | 接受且刻意与告警同口径（都用近 1 小时中位数）。面板显示的数字必须就是告警用的那个数，否则面板会骗人 |
| 页面与后端 API 契约漂移（后端改了字段名页面不报错，只是显示空） | 缓解：`/pairs` 或 `/latest` 解析后若关键字段缺失，页面在顶栏显示一条「接口字段缺失」告警而不是静默显示空值。契约形状已在本 spec §2 逐字固定 |
| 每次刷新 3 个请求 × 每 30 秒 × 多标签页 | 可接受（38 对量级的 payload），且隐藏标签页会暂停。不做请求合并或 ETag —— YAGNI |

**未决（不阻塞实现）**：是否给 `/health` 或新端点暴露 `detect` 的阈值与 `intervalSec`，让页面不必在顶栏硬编码「10%」这个展示值。本期用顶栏文案标注「服务端配置」代替；若将来阈值经常被调，再加端点。
