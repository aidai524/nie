# NEAR Intents 多链报价监控

零依赖的常驻 Node 服务：每分钟对 38 条币对白名单批量 dry-run 询价，把结果落进 SQLite，按规则判定异常并推 Slack，同时暴露只读 HTTP API 供人工排查与后续前端面板消费。

- 设计文档：`docs/superpowers/specs/2026-09-15-near-intents-monitoring-design.md`
- 实现计划：`docs/superpowers/plans/2026-09-15-near-intents-monitoring.md`

## 环境要求

- Node.js >= 24（使用内置 `node:sqlite`、`node:http`、全局 `fetch`，无任何运行时依赖）
- 无 `node_modules`，无需 `npm install`

## 快速开始

```bash
cp config.example.json config.json
```

编辑 `config.json`：

- 填上 Slack 通知：把 `slack.webhookUrl` 填成真实 webhook（或用环境变量 `SLACK_WEBHOOK_URL` 提供），`slack.enabled` 保持 `true`。
- 或者关闭 Slack：把 `slack.enabled` 改成 `false`。

跑一轮验收（不真的发 Slack，只把消息写进日志）：

```bash
npm run once -- --no-notify
```

常驻运行（1 分钟一轮）：

```bash
npm start
```

## 测试

```bash
npm test
```

281 个用例：配置 21、金额与数值 15、币对解析 18、HTTP 12、SQLite 32、判定 21、报价 16、通知 21、服务端 25、装配 33、面板 61、深度 6。

## 命令行参数

| 参数 | 含义 |
| --- | --- |
| `--once` | 只跑一轮就退出（`npm run once` 等价于 `npm start -- --once`） |
| `--no-notify` | 不真的发 Slack，只把消息写进日志 |
| `--config <path>` | 配置文件路径（默认 `config.json`） |
| `--data <path>` | SQLite 文件路径（默认 `data/monitor.db`） |

## 币对报红多数是对方侧状态，不是你的部署坏了

验收实测在**正确安装**上就有 5/38 对报红（`No liquidity available`、`Internal server error`），而且这些状态几小时内就会变化。看到红色币对时先别急着修自己的部署：

- 一条 `error` 状态的币对通常反映的是**对手方**此刻的状态，不是你的安装问题。已观测到的例子：`No liquidity available`（对方暂时没有流动性）、临时性的最低额 `limits`、`Internal server error`（对方侧报错）。这些都会在几小时内自行变化。
- 看错误码判断归属：
  - `limits`：该链的最低兑换额高于默认的 1500。给这条币对在 `config.json` 里显式加 `"amount": "<更大的值>"` 即可，不是故障。
  - `recipient is not valid`：这是真正的**配置**问题——把 `addresses.<chain>` 换成你自己控制的合法地址再重跑。
- 验收运行本身就是在正确安装上看到若干红色币对，所以红色是「监控如实记录了真实状态」的预期信息，不是需要修的缺陷。

## 部署

### systemd

代码目录 `/opt/nearintents_monitoring`（systemd unit 的 `WorkingDirectory`）、配置文件 `/etc/nearintents-monitor/config.json`、数据目录 `/var/lib/nearintents-monitor/`（属主为 `nearintents` 用户）。按顺序执行，每一步都可直接复制：

```bash
# 1. 放代码。`useradd --system` 不会替你创建 home 目录，所以先建目录再放代码。
#    二选一：从本地这份代码拷贝，或从远程仓库克隆。
sudo mkdir -p /opt/nearintents_monitoring
sudo cp -r . /opt/nearintents_monitoring
# sudo git clone <你的仓库地址> /opt/nearintents_monitoring   # clone 会自建目录，勿先 mkdir

# 2. 建系统用户（home 指到代码目录）
sudo useradd --system --home /opt/nearintents_monitoring nearintents

# 3. 建配置与数据目录，放配置文件
sudo mkdir -p /etc/nearintents-monitor /var/lib/nearintents-monitor
sudo cp config.example.json /etc/nearintents-monitor/config.json

# 4. 代码与数据目录归 nearintents
sudo chown -R nearintents:nearintents /opt/nearintents_monitoring /var/lib/nearintents-monitor
```

敏感项（Slack webhook、API bearer token）放在 `/etc/nearintents-monitor/env`，权限设 0600：

```bash
sudo tee /etc/nearintents-monitor/env > /dev/null <<'EOF'
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx/yyy/zzz
SERVER_BEARER_TOKEN=
EOF
sudo chown nearintents:nearintents /etc/nearintents-monitor/env
sudo chmod 600 /etc/nearintents-monitor/env
```

安装 unit 并启动：

```bash
sudo cp deploy/nearintents-monitor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nearintents-monitor
```

以上路径与 unit 里的配置一一对应：`WorkingDirectory=/opt/nearintents_monitoring`、`--config /etc/nearintents-monitor/config.json`、`--data /var/lib/nearintents-monitor/monitor.db`、`EnvironmentFile=-/etc/nearintents-monitor/env`。

### Docker

```bash
docker build -t nearintents-monitor -f deploy/Dockerfile .
docker run -d --name nearintents-monitor \
  -p 8787:8787 \
  -v nearintents-data:/app/data \
  -v "$PWD/config.json:/app/config.json:ro" \
  nearintents-monitor
```

数据卷挂载在 `/app/data`，容器内以 `node` 用户运行。

## HTTP API

只读，默认监听 `http://127.0.0.1:8787`。所有响应为 JSON。

| 端点 | 说明 |
| --- | --- |
| `GET /health` | 健康状态：`ok`、`startedAt`、`lastRoundTs`、`lastRoundAgeMs`、`lastRoundDurationMs`、`consecutiveRoundErrors`、`pairs`、`dbBytes`；距上一轮超过 3 个轮次时返回 503 |
| `GET /pairs` | 全部币对及当前状态 |
| `GET /latest?status=error` | 每对最新一条报价，可用 `status`（`ok` / `error` / `deviant`）过滤 |
| `GET /history?pair=&from=&to=&limit=&res=` | 原始报价行，`res=hourly` 切换为小时聚合 |
| `GET /stats?window=1h` | 窗口统计（`1h` / `24h` / `7d`），含每对 `okRate` |
| `GET /alerts?limit=&since=` | 历史告警记录 |

## 数据存储

- 活库默认落在 `data/monitor.db`，**不入库** —— 它每分钟都在变，跟进去会在 git 历史里一次次堆完整副本
  （git 对二进制不做增量），而历史里的二进制删不干净。
- `config.json` 同样不入库（可能含 Slack webhook）。
- **想留一份数据，就另存为带日期的快照**：

  ```bash
  cp data/monitor.db data/snapshots/monitor-$(date +%F).db
  git add data/snapshots/ && git commit -m "data: 快照 <日期>"
  ```

  日期化的文件名让 git 把它记成新文件，只占一份存储、也不会被后续运行改写。
  仓库里现有一份首次推送时留下的 `data/snapshots/monitor-2026-09-16.db`
  （22.5 小时：15,504 条报价 + 6,240 条深度数据 + 2,426 条告警）。
- `*.db-wal` / `*.db-shm` **永不入库** —— 它们是事务中间文件，跟库一起提交会在别人检出时造成库不一致。
- 原始报价保留 14 天，之后按小时聚合永久保留（`config.json` 里的 `retention` 可调）。

## 面板

服务起来后，浏览器打开 `http://<host>:8787/` 即是面板 —— 与 API 同源，不需要额外部署任何东西。
（`npm start` 默认监听 `127.0.0.1:8787`；绑到别的地址就换成对应的主机名。）

面板的视觉语言取自 `ui/app/globals.css`（一份 v0 生成的参考 UI），**已零依赖移植进 `public/index.html`**
—— 去掉了 3 行 Tailwind `@import` 与 `@theme` 块，其余 44 个自定义类名与 13 个令牌原样保留，
没有任何 Tailwind 工具类或 `@apply`。要改样式就读 `public/index.html` 的 `<style>`（那是现在唯一的事实来源）
与 `AGENTS.md` 里的护栏。`design/clickhouse/` 是上一版设计系统，**已弃用，仅存档**。

服务只对外暴露三个静态路径：`/`、`/index.html`、`/dashboard.js`。**其余路径仍一律 404** ——
不是通用静态服务器，所以也不存在目录穿越的问题。这三个路径**不校验访问令牌**（见下），
因为它们本身不含任何密钥。

### 面板上每一列是什么意思

| 列 | 含义 |
|---|---|
| 币对 | 白名单里的 `源 → 目标`，下方小字是**源链 · 目标链**（白名单是枢纽辐射形状，两个链是区分维度） |
| 状态 | **服务端判定的结果**，不是页面自己算的：`正常` / `偏离` / `失败` / `未报价`（尚未采集到）。**失败时鼠标悬停在徽章上能看到对方原文**；完整原文在展开详情里也有一行 |
| 付 → 得 | 这一对当前的报价：付出多少源币、得到多少目标币 |
| USD | 源侧金额的美元估值 |
| 成本 | 这次报价的**总损耗**：`(付出美元 − 收到美元) / 付出美元`。含对方手续费与桥接费 |
| 较基准 | 当前报价相对**近 1 小时成功报价中位数**的变化。**与告警判定用的是同一个数** |
| 可按 | **已验证可通过的最大金额档位**，以名义美元表示（`$1M` / `$100k` / …）。`—` = 测过但全档不通；`?` = 本次没测它（拿不到价格，无法折算金额）；整列消失 = 深度扫描已关闭。展开后**每个档位是独立的一块**（不通的块上悬停可看对方原文） |
| 延迟 | 单次询价耗时 |
| 最后报价 | 相对时间 |

列的顺序与三个口径的说明都照参考 UI：图例那行常驻显示在表格上方（`成本`/`较基准`/`可按` 各是什么意思），
所以不必靠悬停 `title` 去猜 —— 触屏和键盘也读得到。

「成本」与「较基准」回答的是两个不同的问题，**不要看混**：

- **成本**：我现在换，要付多少代价？它一直在（稳定币之间典型是 0.11%），跟历史无关
- **较基准**：这条路由是不是在变差？它拿当前报价跟**它自己**近一小时的中位数比，所以一条一直收 0.11% 的路，这里显示 0.00%

所以「付 1501.66 → 得 1500.00、较基准 0.00%」并不矛盾：0.11% 是成本，而它一直就是 0.11%，没变。

成本列用**美元**口径而不是拿两个最小单位相除 —— 后者在两个 token 小数位不同时会算出天文数字
（实测 `bsc:USDC`（18 位）→ `near:USDC`（6 位）得到 100110509950192%）。美元口径与小数位无关，对所有币对都成立。

较基准列带 `*` 表示窗口内成功样本不足 5 条：此时服务端不会判定偏离，所以这个数字仅供参考。
样本不足时页面**照常显示数字**而不是藏起来 —— 藏起来会让人误读成「没有变化」，而实际是「暂时测不准」。

点任意一行会展开排障详情：`correlationId`（拿去找对方查）、`minAmountOut` / `minAmountIn`（看滑点与最低额）、
`HTTP`、`swapType`、该对的配置金额、连续失败次数、当前状态起始时间；
失败时还多一行**失败原文**（占满一行），以及 5 个金额档位各自独立的分块。

行**可用键盘操作**：`Tab` 聚焦、`Enter` 或空格展开/收起（展开态有 `aria-expanded`）。

### 报红多半不是你的问题

面板上 `error` 状态的含义与排查方式，与上面「币对报红多数是对方侧状态，不是你的部署坏了」一节**完全相同** ——
备注列显示的就是那里说的「对方返回的原文」，所以照那一节读错误码即可（`limits` 加 `amount`、`recipient is not valid` 换地址）。
这里不重复一遍。

### 刷新与故障时的表现

- 每 **30 秒**自动刷新一次（采集本身是 60 秒一轮）
- 标签页切到后台时**暂停轮询**，切回来立即刷一次；暂停时顶栏的「下次自动刷新 N 秒」会消失（不显示一个不会到点的倒计时）
- 服务不可达时指数退避（30s → 60s → 120s 封顶），提示条显示「服务不可达（已重试 N 次）」，
  右上角状态点转红并显示 `API OFFLINE`，并且**保留上一次的数据**继续显示 ——
  陈旧但真实的数据比空白有用，但必须明确标注陈旧。数据陈旧与否直接采信 `/health` 的判定
- 图例里的「偏离阈值 10%（服务端配置）」是**展示文案**，页面并不持有这个配置值。改了
  `detect.priceDeviationPct` 之后，页面不需要改任何东西 —— 因为状态本来就是服务端判定的
- 行**可用键盘操作**：`Tab` 聚焦、`Enter` 或空格展开/收起（展开态有 `aria-expanded`）

### 配了访问令牌怎么办

若 `config.json` 里设了 `server.bearerToken`，页面会弹出令牌输入框。填一次即可，令牌存在浏览器的
localStorage 里。静态页面本身不校验令牌（否则你连页面都拿不到，也就没机会提交令牌），但**数据端点仍然受保护**。

### 面板冒烟（改过 `public/` 或 `src/server.js` 之后跑一遍）

面板的渲染代码没有自动化测试能覆盖（仓库零依赖、没有 DOM 测试框架），所以改完这两处要手工过一遍：

1. `npm start`，浏览器打开 `http://127.0.0.1:8787/`
2. 顶栏计数应与 `/latest` 的状态分布一致 —— 用这条命令核对：

   ```bash
   curl -s localhost:8787/latest | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c={};for(const q of JSON.parse(s).latest){const k=q.stateStatus??"unknown";c[k]=(c[k]??0)+1}console.log(c)})'
   ```

3. 状态是 `error` 的行，备注里应显示**对方返回的原文**（如 `Internal server error`），而不是「未知错误」
4. 点任意一行应展开详情（correlationId / minAmountOut / 连续失败…），再点一次收起
5. 「仅异常」勾上后只留非 ok 的行；选一条链后只剩涉及它的币对；搜索框输入 `zec` 应能筛出 zec 相关
6. `kill -INT` 停掉服务，等 30 秒，页面应显示「服务不可达（已重试 N 次）」**且表格不清空**
7. 重新 `npm start`，约 30 秒内页面应自行恢复
8. 「可按」列应显示每对能通过的最大档位（如 `1M` / `10k` / `—`）；展开某一行应看到 5 档曲线，
   不通的档位后面跟着对方原文（如 `No liquidity available`）
9. 把 `config.json` 的 `depth.enabled` 改成 `false` 并重启，面板的「可按」整列应消失（不是变成一列破折号）

关于第 6 步的一个细节：若信号发出时正好有一轮采集在进行，进程会**先跑完这一轮再退出**
（最多约 15 秒，即一轮 38 对的耗时）；轮次之间发信号则是立即退出。这是 `main` 里
「当前轮结束后退出」的既有语义，不是卡住。

## 深度扫描（按金额档位）

哨兵（每分钟一轮）只回答「这条路由通不通」。流动性对金额大小有明显且**双向**的影响，所以另有一个低频的
**金额阶梯扫描**回答第二个问题：**这条路由最深能吃到多大、大额贵多少。**

### 频率、负载与档位

- 每 **15 分钟**一次，38 对 × 5 档 = **190 次请求**（折算约 0.21 req/s，比哨兵那轮还轻）
- 档位是**名义美元**：`100 / 1k / 10k / 100k / 1M`。脚本用哨兵最近一次成功报价的单价
  （`amountOutUsd / amountOut`）把美元折算成目标币数量 —— 所以 `near:USDC → zec:ZEC` 的「0.5」
  不会被误当成 0.5 美元
- 一小时内没有成功报价的币对**整对跳过**并在日志里说明（没有价格就无法折算）

**扫描是阻塞的**，一次约 2–2.5 分钟（实测 165 次请求用了 129 秒）。所以**每 15 轮里有 1 轮哨兵会被推迟**，日志会打出
「上一轮耗时超过 intervalSec，立即开始下一轮」。这是刻意的取舍：改成后台并发会让两条路径同时打
API、同时写库，换来的只是哨兵不迟到。

### 成本曲线是 L 形带尾巴，不是「越大越贵」

实测（`EXACT_OUTPUT`，档位 = 想收到的美元数）：

```
near:USDC>eth:USDC     100 → 0.41%   1k → 0.14%   10k → 0.11%   100k → 0.11%
                                            1M → No liquidity
arb:USDC>near:USDC     100 → 0.11%   1k → 0.11%   10k → 0.11%   100k → 0.11%（平坦）
                                            1M → No liquidity
near:USDC>bera:USDT    100 → 0.29%   1k → 0.29%   10k → 0.29%
                     100k → No liquidity   ← 比 eth 早一档就断
near:USDC>zec:ZEC      100 → 0.58%   1k → 0.26%   10k → 0.24%   100k → 0.26%
                                            1M → No liquidity
```

**这张表本身也会变。** 两次测量之间 `eth` 的 100k 档从 0.21% 变成了 0.11%（比 10k 还便宜），
`bera` 的整条中段也从 0.30% 掉到 0.29% —— 曲线和断点都是会漂的，这正是要盯它的原因。

三条要记住的：

1. **小额被固定手续费吃掉**（eth 上 100 美元要 0.41%，1 万美元只要 0.11%）—— 所以「大额更吃亏」只是曲线的后半段
2. **断点逐路由差异极大**：`bera` 在 10k~100k 之间断，`eth` 能到 100k 但 1M 断
3. **失败形态很干净**：大额是 `No liquidity available` 这个明确的 400，不是报价变差。
   所以「某一档没有报价」本身就是干脆的信号

「可按」列的四种读法要分清：档位（如 `100k`）＝能通过的最大档位；`—` ＝**测了，所有档位都不通**；
`?` ＝**本次没测它**（哨兵拿不到价格，无法折算金额）或还没扫描过；整列消失 ＝`depth.enabled: false`。
`—` 与 `?` 不能混 —— 把「没测」显示成「做不了」就是谎报

固定档位表只能粗测 —— 它的价值在于**跟踪断点随时间往哪边移动**，不在精确定位。

### 大额不通**不报警**

那是**稳定的路由特征**（多个对常年如此），接进告警会天天响，而现有告警体系是精心设计成「只在状态变化时响」的。
深度数据只在两处露面：面板的「可按」列与展开曲线，以及**日汇总里的一行快照**：

```
深度（最近一次扫描，可通对数/已扫描对数）：100 29/33 · 1k 31/33 · 10k 31/33 · 100k 24/33 · 1M 0/33（5 对无可用价格未扫描）
```

分母是**实际扫到的对数**（33），不是白名单的 38 —— 那 5 对因为一小时内没有成功报价而无法折算金额，
它们不是「做不了 100 档」，把它们算进分母会让这一行谎报。未扫描的对数会单独说明。

先看几天数据。如果断点其实很稳定，那再加「变化时才提醒」就是白加一套状态机；如果它确实会动，那时再加更划算。

### 配置

```jsonc
"depth": {
  "enabled": true,
  "intervalSec": 900,
  "tiers": [100, 1000, 10000, 100000, 1000000],
  "concurrency": 3
}
```

- `tiers` 必须是非空、严格递增的正整数数组，且**最多 10 项** —— 每多一项都会成倍增加对方 API 的负载
- `intervalSec` 不得小于 60（比哨兵还快的深度扫描没有意义）
- `enabled: false` 时完全不跑扫描，面板会**隐藏「可按」整列**（而不是显示一列破折号 —— 那会与
  「所有档位都不通」长得一样，而手机上悬停不了、区分不出来）

### 数据与保留

深度数据落在**独立的 `depth_quotes` 表**里，与哨兵的 `quotes` 表完全分开。这样 `/latest`、`pair_state`、
小时聚合与告警判定的语义一行都不用改 —— 混在一起会让某一对的「最新一条」变成 1M 档的失败行，
面板就会把它显示成坏了。

保留策略沿用同一个 `retention.rawDays`（默认 14 天）。**刻意不做长期聚合**，所以 14 天前的深度历史会消失。
要留的话加一张按天的聚合表即可 —— 等先看几天数据再决定粒度和是否值得。
