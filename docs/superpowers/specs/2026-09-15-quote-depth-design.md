# 报价深度（按金额档位）设计

日期：2026-09-15
状态：待评审
前置：
- `docs/superpowers/specs/2026-09-15-near-intents-monitoring-design.md`（后端，已合入 `main`）
- `docs/superpowers/specs/2026-09-15-quote-dashboard-design.md`（面板，已合入 `main`）

## 1. 目标

回答一个哨兵回答不了的问题：**这条路由最深能吃到多大，大额到底贵多少。**

现在每对币对只有一个固定金额（稳定币默认 1500），一轮一次报价，只能回答「通不通」。而流动性对金额大小有显著且**双向**的影响 —— 实测见 §2。

本期加入一个低频的**金额阶梯扫描**：对每对币对按几个名义美元档位各报一次价，把结果落盘并在面板上以「可按的最大档位」+ 展开后的成本曲线呈现。

**非目标**（本期不做）：

- 不把阶梯结果接入告警（不新增告警类型、不动 `pair_state`）。只在日汇总里加一行当前深度快照
- 不做深度的长期聚合（14 天前的深度原始数据会按既有保留策略消失，见 §10）
- 不做精确定位断点的二分搜索 —— 固定档位表只能粗测，目标是**跟踪断点随时间往哪边移动**
- 不改哨兵的频率、金额与告警语义。哨兵链路（`quotes` / `pair_state` / `detect` / 小时聚合）**逐字不变**

## 2. 实测依据（写档位表之前先量过）

一次性实测（`EXACT_OUTPUT`，档位 = 想收到的名义美元数），这是档位取值的唯一依据：

```
near:USDC>eth:USDC     100 → 0.4090%    1k → 0.1401%   10k → 0.1132% ← 最便宜
                     100k → 0.2093%     1M → No liquidity    5M → No liquidity
arb:USDC>near:USDC     100 → 0.1131%    1k → 0.1105%   10k → 0.1102%   100k → 0.1102%（平坦）
                                          1M → No liquidity
near:USDC>bera:USDT    100 → 0.2999%    1k → 0.2972%   10k → 0.2969%
                     100k → No liquidity   ← 比 eth 早一档就断
near:USDC>xlayer:USDC  所有档位都 No liquidity（该路由本就在故障中）
```

三条结论决定了整个设计：

1. **成本曲线是「L 形带尾巴」**：小额被**固定手续费**吃掉（eth 上 100 美元要 0.41%，1 万美元只要 0.11%），中段最便宜，大额开始变贵，再大**直接没有报价**。所以「大额更吃亏」只是曲线的后半段，前半段是反的 —— 只测大额会得出错误结论。
2. **断点逐路由差异极大**：`bera` 在 10k~100k 之间断，`eth` 能到 100k 但 1M 断。固定档位表永远只是粗测。
3. **失败形态干净**：大额是 `No liquidity available` 这个明确的 400，不是报价变差。所以「某档没有报价」本身就是干脆的信号。

## 3. 三个已确认的决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 探测策略 | **1 分钟单档哨兵 + 每 15 分钟 5 档深度扫描** | 5 档 × 38 对 = 190 次 / 15min = **0.21 req/s**，比哨兵那轮（0.63 req/s）还轻；且哨兵链路完全不动 |
| 档位取值 | **100 / 1k / 10k / 100k / 1M**（名义美元） | 正好覆盖实测出来的三种形态：小额吃亏、中段平坦、大额触顶 |
| 是否告警 | **纯展示**，不新增告警；只在日汇总加一行当前深度快照 | 大额触顶是**稳定的路由特征**（多个对常年如此），接入告警会制造永久噪声；且实测只做了一次，断点会不会动尚未证明，先看几天数据再决定是否加边沿告警更划算 |

## 4. 数据模型：单独一张 `depth_quotes` 表

```sql
CREATE TABLE IF NOT EXISTS depth_quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  pair_id TEXT NOT NULL,
  tier_usd INTEGER NOT NULL,          -- 100 / 1000 / 10000 / 100000 / 1000000
  ok INTEGER NOT NULL,
  http_status INTEGER,
  latency_ms INTEGER,
  amount_minor TEXT,                  -- 本次按档位折算出的目标币最小单位
  amount_in TEXT,
  amount_out TEXT,
  amount_in_usd TEXT,
  amount_out_usd TEXT,
  min_amount_out TEXT,
  time_estimate INTEGER,
  correlation_id TEXT,
  error_code TEXT,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_depth_pair_ts ON depth_quotes(pair_id, ts);
CREATE INDEX IF NOT EXISTS idx_depth_ts ON depth_quotes(ts);
```

**为什么不给 `quotes` 加一列档位判别。** 那样会弄坏哨兵链路：

- `/latest` 的实现是 `SELECT ... MAX(id) GROUP BY pair_id`。加了阶梯之后，某一对的「最新一条」可能是 1M 档的**失败**行，于是面板主表会显示成那一对坏了 —— 而它对 1500 档其实好得很。这是个静默的错误，比崩溃更糟
- 要修就得给 `quotes` 加 `kind` 判别列，然后改 `getLatestPerPair`、`getHistory`、`getStats`、`getRecentQuotes`、小时聚合、以及 `detect` 的取数路径 —— 也就是把选「策略 A」时想避开的那条链路全部改动，并让 230 个既有测试面临回归风险

两类事实分两张表，与既有 `alerts`（发生过什么）和 `pair_state`（现在是什么）分开的理由一致。**哨兵链路的代码一行不改。**

## 5. 档位折算：名义美元 → 目标币最小单位

`amount` 是**目标币**数量（`EXACT_OUTPUT`），所以「想收到 100 美元」要换算成目标币数量。

目标币的美元单价从**哨兵最近一次成功报价**推出：`单价 = amountOutUsd / amountOut`，于是

```
amountMinor = round(tierUsd × amountOut / amountOutUsd)
```

`amountOutUsd / amountOut` 在推导里消掉了，所以不需要单独算单价，直接从报价行算。

```js
export function depthAmountMinor(quote, tierUsd) { ... }   // 纯函数，返回十进制整数字符串或 null
```

守卫（返回 `null` 表示这一对本次跳过，不猜）：

- `quote` 为 `null`、`quote.ok` 非真、或 `amountOut`/`amountOutUsd` 缺失
- `amountOutUsd <= 0`、`tierUsd <= 0`
- 算出的结果非有限、非正、或不是整数（四舍五入后）

**取数来源**：`store.getRecentQuotes(pairId, nowIso − 1h, 1)` 里第一条 `ok` 的行。哨兵的轮次先跑、扫描后跑（同一个 `runMaintenance` 里按顺序），所以第一次扫描时价格已经存在。一小时内没有任何成功报价的对**跳过整对**并在日志里说一次（不每天刷屏）。

**为什么不用 `amountIn/amountOut` 之类的最小单位比值**：两个字段各自是所在链的最小单位，小数位不同时相除毫无意义 —— 面板那轮已经实测过 `bsc:USDC`(18位) → `near:USDC`(6位) 得到 100110509950192%。这里用 `amountOutUsd / amountOut`，与小数位无关。

## 6. 扫描任务与调度

挂在既有的 `runMaintenance(ctx)` 里（它每轮都被调用一次），不新增定时器。逻辑放在一个**导出的** `runDepthSweep(ctx)` 里，便于用注入的 `fetchImpl` 单测：

```
若 depth.enabled 且 now − meta.last_sweep_ts >= depth.intervalSec:
    挑出哨兵给不出价格的对（跳过）
    并行发 38 对 × 5 档（并发 depth.concurrency）
    写 depth_quotes
    meta.last_sweep_ts = now
```

- 复用 `quotePair`（把 `amountMinor` 换成档位折算值即可），因此错误归类、`limits` 识别、超时处理全部复用既有逻辑
- 用 `mapLimit` 控并发
- `--once` 时如果到点也会跑一次（便于验证）

**代价（已确认接受）**：扫描是**阻塞**的，190 次请求 ÷ 并发 3 ≈ 1–2 分钟。所以**每 15 轮里有 1 轮的哨兵会被推迟**，日志会打出「上一轮耗时超过 intervalSec，立即开始下一轮」。不改成后台并发的理由：那样会有两条路径同时打 API、同时写库，换来的只是哨兵不迟到，不划算。

## 7. API

新增 `GET /depth`：

```jsonc
{
  "enabled": true,                       // 来自 config.depth.enabled，让页面能区分「关了」与「还没扫过」
  "ts": "2026-09-15T07:30:00.000Z",      // 本次扫描的时间戳；没有扫描过时为 null
  "tiers": [100, 1000, 10000, 100000, 1000000],
  "rows": [
    { "pairId": "near:USDC>eth:USDC", "tierUsd": 100, "ok": true,
      "amountInUsd": "100.41", "amountOutUsd": "100.00",
      "errorCode": null, "errorMessage": null, "latencyMs": 1306 }
  ]
}
```

- 返回**最近一次扫描**的全部行（最多 190 行），`?pair=` 可过滤
- **不返回 `costPct`** —— 成本由页面用已有的纯函数 `computeCostPct` 算。服务端再算一遍就会出现两处口径，将来必然对不上
- 没有扫描数据时返回 `{ enabled: true, ts: null, tiers: [...], rows: [] }`，**不是 404**（「还没扫过」是正常状态，不是错误）
- 既有的六个端点逐字不变

## 8. 面板

**主表新增一列「可按」**（放在「成本」之后）：这一对**能通过的最大档位**。状态判定不能含糊：

| 状态 | 显示 |
|---|---|
| `/depth` 报 `enabled: false` | **整列隐藏**（表头与所有单元格），不报歧义的 `—` —— 否则与「全档不通」图形完全一样，而手机上悬停不了、区分不出来 |
| `enabled: true` 但 `ts === null`，或本次拉取失败 | `?`，悬停说明「还没有扫描过（最长等一个 intervalSec）」 |
| 有数据，该对至少一档能通 | 最大可通档位，如 `1M`，悬停说明「档位是名义美元；展开看完整曲线」 |
| 有数据，该对所有档位都不通 | `—`，悬停说明「所有档位都没有报价」 |

隐藏用类名（与既有 `.hide-narrow` 同一套做法），而不是在 HTML 里不渲染 —— 表头始终存在于 HTML 里，DOM 契约测试仍按 10 列断言。

**`formatTier` 的规则要穷尽**（否则遇到非整十倍的档位会得到意外输出）：`>= 10^6` 除以 10^6 加 `M`；否则 `>= 10^3` 除以 10^3 加 `k`；否则原数字。小数部分用 `toString` 自然剥离（`1` 不显示为 `1.0`）。于是 `1000000→1M`、`2500000→2.5M`、`100000→100k`、`1500→1.5k`、`100→100`。

**展开行里加完整曲线**：5 行，每行是档位、通/不通、成本、对方原文（不通时）。

**日汇总加一行快照**：

```
深度（最近一次扫描）：1M 档 12/38 可通 · 100k 档 29/38 · 3 对全档不通
```

取数：`init()` 的每次刷新再多拉一个 `/depth`（第 4 个请求，payload 约 190 行，很小）。`/depth` 拉失败不影响主表渲染，只是「可按」列显示 `?`。

纯函数新增（可测）：

- `largestPassingTier(rows)` —— 从某对的档位行里挑出能通过的最大档位，全不通给 `null`
- `buildDepthIndex(rows)` —— 按 pairId 归并成 `Map<pairId, { maxTierUsd, byTier }>`
- `formatTier(usd)` —— 按 §8 的规则：`1000000` → `1M`、`2500000` → `2.5M`、`100000` → `100k`、`1500` → `1.5k`、`100` → `100`

## 9. 配置

```jsonc
"depth": {
  "enabled": true,
  "intervalSec": 900,
  "tiers": [100, 1000, 10000, 100000, 1000000],
  "concurrency": 3
}
```

校验规则：

- `tiers` 必须是**非空数组**，每项是正整数，严格递增，去重，且**最多 10 项**（上界是为了防止有人写 100 个档位把对方 API 打爆）
- `intervalSec` 整数且 **>= 60**（比哨兵还快的深度扫描没有意义）
- `concurrency` 整数且 1..50（与既有 `concurrency` 同规则）
- `enabled: false` 时完全不跑扫描；面板隐藏「可按」整列（见 §8）。日汇总也省略深度那一行

## 10. 保留与容量

- 扫描 190 行/次 × 96 次/天 ≈ **18,240 行/天**（相对哨兵的 ~54,720 行/天是 **+33%**）
- 沿用既有的 `retention.rawDays`（默认 14 天）一起清理 → 稳态约 **256k 行 / 约 50 MB**
- 清理挂在既有的每小时后保留策略里（与 `pruneRaw` 同一处），新增 `pruneDepth(beforeIso)`

**刻意不做长期聚合**，代价是 14 天前的深度历史会消失。理由：阶梯的价值集中在「现在能吃到多大、断点有没有在动」，14 天原始数据足够回答；深度的长时间序列要不要留、按什么粒度留（按天？按档位？），等先看几天真实数据再定更划算。若将来要留，加一张按天的聚合表即可。

## 11. 测试策略

**纯函数（可单测，不碰 DOM）**：

- `depthAmountMinor` —— 正常折算（含 6/8/18 位小数）、`amountOutUsd` 为 0/负/缺失、`amountOut` 缺失、`tierUsd` 非正、结果非正整数时返回 `null`
- `largestPassingTier` —— 全通、部分通、全不通（`null`）、空数组
- `buildDepthIndex` —— 归并多个币对、同一币对的多个档位、空输入
- `formatTier` —— 100 / 1k / 10k / 100k / 1M / 未知档位

**store**：`insertDepthQuotes`（含事务与回滚）、`getLatestSweep`（取最近一次 `ts` 的全部行，不能混入更早的扫描）、`pruneDepth` 边界

**扫描任务**（`index.js`）：用注入的 `fetchImpl` 跑一次 `runDepthSweep`，断言写了 38×5 行、挑不出价格的对被跳过、`meta.last_sweep_ts` 被推进、`depth.enabled: false` 时完全不跑

**server**：`GET /depth` 有数据 / 无数据（`ts: null` 而不是 404）/ `?pair=` 过滤

**DOM 契约**：表头 10 列含「可按」；展开行里含档位曲线的容器

预计新增 **35–45 个用例**（当前 230）。

## 12. 风险与未决

| 风险 | 处理 |
|---|---|
| 断点只测了一次，可能完全稳定 | 这正是选「纯展示」的原因 —— 先积累数据，若证明会动再加边沿告警。代价是初期不会主动通知你 |
| 5 档 × 38 对里有若干对必然全档失败（`→ tron:USDT`、`→ xlayer:USDC`、`→ bsc:USDC` 这几个目标链目前就是坏的） | 这是**预期信息**，不是缺陷。面板与日汇总如实展示即可，不要为此加特例 |
| 扫描阻塞会推迟哨兵 | 已确认接受。日志会显式打出「立即开始下一轮」，可观测 |
| 折算依赖哨兵报价的价格，哨兵坏掉的对手方链上就扫不了 | 跳过并在日志里说一次。这类对本来就在哨兵那层红着，不会因此被忽略 |
| 14 天后深度历史消失 | 已确认接受，见 §10。要留就加按天聚合 |
| 档位表是粗测，无法精确定位断点 | 刻意如此（非目标里写明）。要精确定位需要二分搜索，成本高且断点会漂移，不值得 |

**未决（不阻塞实现）**：日汇总里的深度快照文案格式（先按 §8 那一行做）；`/depth` 是否需要历史查询端点（本期只给「最近一次」，面板只画当前曲线；若将来要画趋势再加 `?from=&to=`）。
