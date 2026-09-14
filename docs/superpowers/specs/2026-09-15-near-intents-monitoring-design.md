# NEAR Intents 多链多 token 报价监控

日期：2026-09-15
状态：待评审

## 1. 目标

一个常驻服务，按固定频率对一份**手工维护的币对白名单**批量询价，把每次报价结果落盘成时间序列，按规则判定异常并通过 Slack 告警，同时通过只读 HTTP API 把数据暴露出来，供人工 `curl` 查看和将来的前端面板消费。

**非目标**（本期不做）：

- 不执行任何真实交易，不创建 deposit address（全程 `dry: true`）
- 不做前端页面。`near-intents.html` 只是参考实现，本期交付物是脚本/服务
- 不做套利、下单、资金调度
- 不做多用户、多租户、权限体系

## 2. 现状与实测结论

仓库当前只有一个文件 `near-intents.html`：一个纯前端页面，从 StableFlow 与 1Click 拉 token 列表、按规则推导 `assetId`、POST 一次报价并打印完整 request/response。它是要采集的数据源与请求体的**事实来源**，但它本身不是本期交付物。

以下结论均为实测（一次真实调用验证过，不是推测）：

| # | 结论 | 影响 |
|---|------|------|
| 1 | `POST https://test-api.stableflow.ai/v1/nearintents/quote` 无鉴权，是 1click `/v0/quote` 的开放代理 | 不需要 API key |
| 2 | `dry` 是**必填布尔**，缺失返回 400 `dry should not be empty` | 请求体必须显式带 `dry: true` |
| 3 | `dry: true` 时响应不生成 deposit address | 监控无副作用，不在对方系统留状态 |
| 4 | `recipient` 按**目标链**做真实地址格式校验。`0x0000...0000`、`0x1234` 被拒；checksummed 与全小写 EVM 地址都通过 | 每链需一份格式合法的哑地址，属配置项 |
| 5 | `EXACT_OUTPUT` 下 `amount` 是**目标 token 的最小单位**。实测 `amount:"1000000"` → `amountOutFormatted:"1.0"`（eth:USDC, 6 位）、`amountInFormatted:"1.301437"` | 现有 HTML 用 `from.decimals` 换算 amount，是 bug（两边 decimals 相同时才碰巧正确）。本期不复制该 bug |
| 6 | 成功响应字段：`correlationId`、`quote.{amountIn, amountInFormatted, amountInUsd, amountOut, amountOutFormatted, amountOutUsd, minAmountIn, minAmountOut, refundFee, withdrawFee, timeEstimate}`、`signature`、`timestamp` | 直接入库 |
| 7 | 代理会附加 `appFees: [{fee: 1}]` | 解读价差时注意，非纯净中间价 |
| 8 | 单次报价延迟 0.8–3.2s | 1 分钟一轮、几十对币对，3–5 并发足够 |
| 9 | StableFlow 列表 45 个 token / 15 条链，`support_payment` 与 `support_receive` 均为 45 | 全量矩阵 2025 对，太大；白名单是合理选择 |
| 10 | 45 个 token **全部**能在 1click token 列表匹配出 `assetId`，HTML 里那套 fallback 拼接规则实测一条都没命中 | 保留 fallback 作兜底，但解析失败必须启动即报错 |

## 3. 方案选择

| 方案 | 说明 | 判断 |
|------|------|------|
| **A. 单体 Node 服务** | 一个进程 = 采集循环 + HTTP API + SQLite + Slack 通知 | **采用**。零运行时依赖，一个 SQLite 文件，部署与排障都最简单。采集与 API 同生共死，但采集停摆本身就是需要被发现的状态，反而有利可观测性 |
| B. 双进程（poller 写库 / API 读库） | 各自可重启、可扩容 | 现阶段过度设计。存储层已隔离在 `store.js`，将来拆分不需要改别的模块 |
| C. JSONL 追加 + 内存索引 | 最省事 | 1 分钟粒度下文件增长快，且面板要的时间序列查询得自己实现。既然规划了前端面板，SQLite 是正解 |

运行时：**Node.js 24**，ESM，**零运行时依赖**。已实测可用：内置 `fetch`、`node:sqlite`（`DatabaseSync`）、`node:http`、`node:test`。

## 4. 架构

```
nearintents_monitoring/
  config.example.json          # 进版本库的示例配置
  config.json                  # 真实配置（含 Slack URL），加入 .gitignore
  src/
    index.js     # 入口：加载配置 → 起 HTTP → 起采集循环；解析 CLI 参数
    config.js    # 读取、校验、填默认值、环境变量覆盖
    assets.js    # token 列表拉取/缓存 + assetId 解析
    quote.js     # 单次报价请求：并发控制、超时、错误归类
    store.js     # node:sqlite：建表、写入、查询、小时聚合、保留策略
    detect.js    # 异常判定：硬失败 + 滚动中位数偏移 + 状态机
    notify.js    # Slack：边沿触发、去重、恢复通知、日汇总
    server.js    # HTTP API + CORS + 可选 Bearer
  test/          # node:test
  deploy/
    nearintents-monitor.service  # systemd unit
    Dockerfile
  data/monitor.db
```

模块边界与依赖方向（单向，无环）：

- `config` → 无依赖，纯函数 + 文件读取
- `assets` → 无依赖，输入是原始 token 列表数组（**不自己发请求**），因此可离线单测
- `quote` → 依赖 `assets` 产出的 assetId，不做判定、不写库
- `store` → 只依赖 sqlite，不认识 HTTP 与业务语义
- `detect` → 纯函数：输入「一对币对的最近 N 条报价 + 当前配置 + 该对上次状态」，输出新状态与事件，不碰数据库。**每一轮异常都会产出事件**，它不负责克制
- `notify` → 只认「事件」这一个输入，不认识币对来源。**「什么时候真的发」全在这里**：边沿抑制（同一对持续异常在 `realertMinutes` 内只发第一次）与日汇总
- `server` → 只读 `store`
- `index` → 唯一知道全局流程的地方，负责把上面这些串起来

业务语义不泄漏进 `store`，判定逻辑不泄漏进 `index`，两边都能独立测试。

## 5. 数据模型

`pairs`

| 列 | 说明 |
|----|------|
| `id` | 主键，如 `eth:USDC>near:USDC` |
| `label` | 展示名，默认由 id 生成 |
| `from_asset` / `to_asset` | 解析后的 assetId |
| `swap_type` | `EXACT_OUTPUT`（本期默认）或 `EXACT_INPUT` |
| `amount` | 人类可读金额，字符串（避免浮点） |
| `amount_minor` | 换算后的最小单位，采集时直接用 |
| `from_decimals` / `to_decimals` | 用于换算与展示 |
| `enabled` | 0/1，配置里关掉的币对保留历史 |

`quotes`（每轮每对一行）

| 列 | 说明 |
|----|------|
| `id`, `ts`, `pair_id` | `ts` 为 ISO8601 UTC |
| `ok` | 0/1 |
| `http_status`, `latency_ms` | |
| `amount_in`, `amount_out`, `amount_in_usd`, `amount_out_usd` | 字符串原样存，避免精度损失 |
| `min_amount_in`, `min_amount_out`, `time_estimate`, `correlation_id` | |
| `error_code` | `http_4xx` / `http_5xx` / `timeout` / `network` / `bad_shape` |
| `error_message` | 截断到 500 字符 |

索引：`(pair_id, ts)`、`(ts)`。

`pair_state`（每对一个状态行，判定状态机的落盘）

`pair_id` 主键、`status`（`ok` / `error` / `deviant`）、`status_since`、`last_ok_ts`、`last_alert_ts`、`consecutive_failures`。

`alerts`

`id, ts, pair_id, kind`（`error` / `deviation` / `recover`）、`detail`（JSON）、`notified`（0/1）。

`quotes_hourly`（保留策略用）

按 `(pair_id, hour)` 聚合：`n, ok_n, amount_in_avg/min/max, amount_out_avg/min/max, latency_avg_ms`。`amount_in` 与 `amount_out` 都留，因为偏离指标用的是哪一侧取决于 `swap_type`（见 §7）。写入用 `INSERT OR REPLACE` 保证幂等。

`meta`：`key/value`，存 `last_digest_ts`、`last_rollup_hour`、`schema_version`。

## 6. 采集循环

1. **启动**：加载配置 → 拉两份 token 列表 → 解析白名单里所有 `network:symbol` 到 assetId。**任何一个解析不到就启动失败并打印清单**，不静默降级。
2. **每轮**（默认 60s）：统一计算 deadline（`now + 10min`）→ 以并发上限 5 发出所有请求 → 单条超时 15s → **失败不重试**（1 分钟后就是下一轮，重试只会加重对方负担）。
3. **写库**：全部 `quotes` 落盘 → 更新 `pair_state`。
4. **判定与告警**：读最近 1 小时的报价 → 跑状态机 → 产生事件 → 按边沿触发推 Slack → 事件写 `alerts`。
5. **维护**：每小时做一次小时聚合 + 清理超过保留期的原始数据。
6. **循环控制**：支持 `--once`（跑一轮就退出，便于调试与将来切 cron/launchd）、`--config <path>`、`--no-notify`（不真发 Slack，只在日志里打印将要发出的消息）。收到 `SIGINT`/`SIGTERM` 时结束当前轮再退出，不丢数据。

调度采用「距上一轮**开始**满 `intervalSec` 就开下一轮」，即真实周期约等于 `intervalSec`，不叠加轮次耗时。若某一轮耗时超过 `intervalSec`（大量超时的极端情况），下一轮立即开始并记一条日志——宁可延后也不并发叠加。不做「对齐整分钟」：没有理由让别人系统的整点高峰决定我们的请求时刻。

## 7. 异常判定与告警

本期实现 B 档规则，阈值全部可配。判定逻辑是纯函数，只读库里的历史，所以**改阈值立刻生效、无需重采**。

**硬失败**：非 2xx / 超时 / 网络错误 / 响应缺少 `quote` 字段 / `amountIn` 缺失或不可解析。

**价格偏移**：把本轮的价格侧数值与**近 1 小时成功报价的中位数**比较，偏离超过 `priceDeviationPct`（默认 10）即判 `deviant`。样本数少于 `minSamples`（默认 5）时不判定——冷启动阶段不应报警。用中位数而非均值，避免单次异常值污染基准。

**「价格侧」是哪一侧由 `swap_type` 决定**：`EXACT_OUTPUT` 时目标数量固定，看 `amountIn`；`EXACT_INPUT` 时输入数量固定，看 `amountOut`。写死一侧会在有人把某个币对改成 `EXACT_INPUT` 时静默失效——这是需要测试锁住的边界。两侧都可比的共同原因是：该币对的固定侧数量在整个监控期内不变。

**状态机（边沿触发）**，每对独立：

- `ok → error|deviant`：推送一条告警
- 持续异常：`realertMinutes`（默认 30）内不重复推，超过则重推一条提醒
- `error|deviant → ok`：推送一条「已恢复」，附带异常持续时长
- 抖动（同一对在一轮内反复切换）天然被 `realertMinutes` 抑制

**日汇总**（默认开启，可关）：每天服务器本地时区的 `digestHourLocal`（默认 9 点）推一条过去 24 小时的汇总——总轮次、成功率、异常最多的前 3 对、延迟 P95。日报时间用 `meta.last_digest_ts` 判定，进程重启不会重复推或漏推。

**消息形态**：`{"text": "..."}` 加 Slack mrkdwn，不使用 blocks。形如：

```
:red_circle: *eth:USDC → near:USDC* 报价失败
HTTP 400 — tokenOut is not valid
连续失败 1 次 · 上次成功 2026-09-15T00:12:03Z
```

`slack.mention` 可配置（如 `<!channel>`），默认空。

## 8. HTTP API

全部只读 `GET`，返回 JSON。

| 端点 | 说明 |
|------|------|
| `/health` | `{ok, lastRoundTs, lastRoundAgeMs, pairs, consecutiveRoundErrors, dbBytes}`。最近一轮超过 3×interval 未完成时返回 503 |
| `/pairs` | 白名单及其当前 `pair_state` |
| `/latest` | 每对最新一条报价 + 状态。支持 `?status=error` 过滤 |
| `/history` | `?pair=&from=&to=&limit=`，默认按时间倒序，`limit` 上限 5000 |
| `/stats` | `?window=1h\|24h\|7d`，按对的成功率、`amount_in` 分位、延迟分位 |
| `/alerts` | `?limit=&since=` |

- **CORS**：`server.cors` 可配来源，默认 `*`（面向将来面板）。只读接口，无凭据，风险可控。
- **鉴权**：`server.bearerToken` 配了才校验；不配则不校验（默认监听 `127.0.0.1`，服务器部署时用反代加 TLS）。
- **时间序列**：`/history` 同时接受 `?res=raw|hourly`，`hourly` 走 `quotes_hourly`，供面板画长周期图表时避免拉原始数据。
- 所有时间参数与返回均为 ISO8601 UTC，避免时区歧义。

## 9. 配置

`config.json`（真实文件，gitignore）＋ `config.example.json`（进版本库）。敏感项支持环境变量覆盖：`SLACK_WEBHOOK_URL`、`SERVER_BEARER_TOKEN`。

```jsonc
// 下方数组与地址表均为节选示意，不是待填占位符
{
  "intervalSec": 60,
  "concurrency": 5,
  "requestTimeoutMs": 15000,
  "quoteEndpoint": "https://test-api.stableflow.ai/v1/nearintents/quote",
  "tokensSources": {
    "stableflow": "https://test-api.stableflow.ai/v1/pay/tokens",
    "oneclick": "https://1click.chaindefuser.com/v0/tokens"
  },
  "defaults": {
    "swapType": "EXACT_OUTPUT",
    "slippageTolerance": 10,
    "confidentiality": "advanced",
    "deadlineMs": 600000
  },
  "defaultAmounts": { "USDC": "100", "USDT": "100", "DAI": "100",
                      "ETH": "0.05", "WETH": "0.05", "SOL": "1",
                      "BNB": "0.1", "AVAX": "5", "POL": "100",
                      "TRX": "100", "ZEC": "0.5" },
  "addresses": { "near": "monitor.near", "eth": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "sol": "...", "...": "..." },
  "pairs": [ { "from": "near:USDC", "to": "eth:USDC" }, { "from": "eth:USDC", "to": "near:USDC", "amount": "50" } ],
  "detect": { "priceDeviationPct": 10, "minSamples": 5, "realertMinutes": 30,
              "rollingWindowMinutes": 60 },
  "slack": { "enabled": true, "webhookUrl": "", "mention": "",
             "digest": { "enabled": true, "hourLocal": 9 } },
  "retention": { "rawDays": 14, "hourlyDays": 0 },
  "server": { "host": "127.0.0.1", "port": 8787, "cors": "*", "bearerToken": "" }
}
```

约定：

- 白名单用 `network:symbol` 表达人类可读的币对，assetId 由脚本解析——**配置里不出现 assetId**，避免手工维护 64 位哈希
- `amount` 缺省时按 `defaultAmounts[目标 token 的 symbol]` 取，再缺省则用 `"1"`
- `retention.hourlyDays: 0` 表示小时聚合永久保留
- 每链的哑地址由脚本内置一份合法默认表（EVM 用 checksummed 真实地址），`addresses` 可覆盖
- 缺失的目标链地址视为**配置错误，启动即失败**，不猜
- 未知的 `network` 或 `symbol`（不在 token 列表里）视为配置错误，启动即失败，错误信息列出具体是哪一条

## 10. 默认白名单（38 对）

以 `near:USDC` 为枢纽，覆盖 15 条链，全部双向。选取原则：每条链上最有代表性的稳定币；没有稳定币的链（zec）用其原生币。

- **各链主稳定币 ↔ `near:USDC`（双向，14 链 → 28 对）**：eth:USDC、sol:USDC、bsc:USDC、tron:USDT、avax:USDC、arb:USDC、base:USDC、gnosis:USDC、pol:USDC、op:USDC、bera:USDT、xlayer:USDC、scroll:USDT、zec:ZEC
- **NEAR 内部（4 对）**：`near:USDT ↔ near:USDC`、`near:ETH ↔ near:USDC`（双向）
- **代表性跨链走廊（双向，6 对）**：`eth:USDC ↔ sol:USDC`、`eth:USDC ↔ base:USDC`（L2 路径）、`bsc:USDT ↔ tron:USDT`（CEX 走廊）

这是「能立刻跑起来、覆盖所有链、成本可控」的起点，不是终态。要扩到全量 2025 对只需改 `config.json`。

## 11. 部署

目标是**服务器常驻**。

- **systemd**（主选）：`deploy/nearintents-monitor.service`，`Restart=always`、`RestartSec=5`、`WorkingDirectory` 指向仓库、`EnvironmentFile` 提供 `SLACK_WEBHOOK_URL`、`After=network-online.target`。日志走 journald。
- **Docker**（备选）：`deploy/Dockerfile` 基于 `node:24-alpine`，`data/` 挂卷持久化。
- 进程内已有 `--once`，将来若想改由 systemd timer / cron 驱动，不需要改代码。

单实例运行即可——SQLite 单写者，天然不支持多实例同时写同一文件，而在 1 分钟粒度下没有横向扩展的必要。

## 12. 测试策略

`node:test`，零依赖。

**单元测试**（不联网）：
- `assets`：assetId 解析（1click 命中路径、fallback 路径、解析失败抛错）、`network:symbol` 查找
- `config`：默认值填充、缺地址报错、环境变量覆盖、`defaultAmounts` 回退
- 金额换算：`1` → `1000000`（6 位）、`0.05` → `50000000000000000`（18 位）、小数位超限报错、`EXACT_OUTPUT` 用**目标** decimals（回归测试，锁住 HTML 那个 bug 不会回来）
- `detect`：全部状态迁移（ok→error、error→ok、ok→deviant、抖动抑制、样本不足不判），以及 `EXACT_INPUT` 币对改用 `amountOut` 作为偏离指标
- `store`：建表幂等、写入-查询往返、小时聚合幂等性、保留策略边界（14 天前删、当天留）
- `notify`：边沿抑制（首次发、`realertMinutes` 内不发、超过后重发、恢复必发）、日汇总的 `last_digest_ts` 去重、`--no-notify` 不真发

**集成测试**（本地 stub，不碰真实 API）：
- `quote`：注入 stub `fetch`，覆盖 2xx 成功、400、5xx、超时、响应形状不对
- `server`：临时端口起服务，打全部端点，覆盖 CORS 头、`limit` 上限、503 条件、Bearer 开/关

**冒烟**：`node src/index.js --once --no-notify` 打真实 API 跑一轮，人工看输出与库内容。这是唯一会真正联网的测试，不进 CI。

## 13. 风险与未决

| 风险 | 处理 |
|------|------|
| 对方无文档说明限流策略 | 并发默认 5、1 分钟间隔，实测每请求 0.8–3.2s，量级很小。遇到 429 时记录错误码并在日志里显式提示，后续按需加退避 |
| `test-api.stableflow.ai` 是测试环境，可能变更或下线 | 端点全部在 `config.json` 里，且有 `quoteEndpoint` 与 `tokensSources` 两个可替换入口；`/health` 会暴露连续失败，能在宕机早期发现 |
| 报价接口的 rate limit / 稳定性是黑盒 | 硬失败与价格偏移分开记录，失败率趋势可从 `/stats` 看出 |
| SQLite 单写者 | 单实例部署，已在上文说明 |
| 1 分钟 × 38 对 = 每天约 5.5 万行 | 原始数据 14 天约 77 万行，SQLite 无压力；小时聚合永久保留保证长周期查询不掉精度 |
| 哑地址是真实存在的地址 | 全程 `dry: true`，不生成 deposit address，不会向这些地址发起任何真实转移 |

**未决（不阻塞实现）**：是否要把「结构异常」（`amountOutUsd` 为 0、`minAmountOut > amountOut`、`timeEstimate` 暴涨）纳入判定。设计上 `detect.js` 的事件类型是可扩展的，本期按 B 档实现，后续加规则不影响其他模块。
