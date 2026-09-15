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

179 个用例，覆盖配置、金额解析、币对解析、HTTP、SQLite、判定、通知与服务端。

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
| `GET /health` | 健康状态：`ok`、`lastRoundTs`、`pairs`、`dbBytes`；距上一轮超过 3 个轮次时返回 503 |
| `GET /pairs` | 全部币对及当前状态 |
| `GET /latest?status=error` | 每对最新一条报价，可用 `status`（`ok` / `error` / `deviant`）过滤 |
| `GET /history?pair=&from=&to=&limit=&res=` | 原始报价行，`res=hourly` 切换为小时聚合 |
| `GET /stats?window=1h` | 窗口统计（`1h` / `24h` / `7d`），含每对 `okRate` |
| `GET /alerts?limit=&since=` | 历史告警记录 |

## 数据存储

- 数据文件默认落在 `data/monitor.db`，`data/` 与 `config.json` 均在 `.gitignore` 中，不会入库。
- 原始报价保留 14 天，之后按小时聚合永久保留（`config.json` 里的 `retention` 可调）。

## 面板

服务起来后，浏览器打开 `http://<host>:8787/` 即是面板 —— 与 API 同源，不需要额外部署任何东西。
（`npm start` 默认监听 `127.0.0.1:8787`；绑到别的地址就换成对应的主机名。）

服务只对外暴露三个静态路径：`/`、`/index.html`、`/dashboard.js`。**其余路径仍一律 404** ——
不是通用静态服务器，所以也不存在目录穿越的问题。这三个路径**不校验访问令牌**（见下），
因为它们本身不含任何密钥。

### 面板上每一列是什么意思

| 列 | 含义 |
|---|---|
| 币对 | 白名单里的 `源 → 目标` |
| 状态 | **服务端判定的结果**，不是页面自己算的：`正常` / `偏离` / `失败` / `未知`（尚未采集到） |
| 付 → 得 | 这一对当前的报价：付出多少源币、得到多少目标币 |
| 成本 | 这次报价的**总损耗**：`(付出美元 − 收到美元) / 付出美元`。含对方手续费与桥接费 |
| USD | 源侧金额的美元估值 |
| 较基准 | 当前报价相对**近 1 小时成功报价中位数**的变化。**与告警判定用的是同一个数** |
| 延迟 | 单次询价耗时，超过 5 秒标黄 |
| 最后报价 | 相对时间（悬停显示绝对时间） |
| 备注 | 失败时显示**对方返回的原文**，不做翻译 |

「成本」与「较基准」回答的是两个不同的问题，**不要看混**：

- **成本**：我现在换，要付多少代价？它一直在（稳定币之间典型是 0.11%），跟历史无关
- **较基准**：这条路由是不是在变差？它拿当前报价跟**它自己**近一小时的中位数比，所以一条一直收 0.11% 的路，这里显示 0.00%

所以「付 1501.66 → 得 1500.00、较基准 0.00%」并不矛盾：0.11% 是成本，而它一直就是 0.11%，没变。

成本列用**美元**口径而不是拿两个最小单位相除 —— 后者在两个 token 小数位不同时会算出天文数字
（实测 `bsc:USDC`（18 位）→ `near:USDC`（6 位）得到 100110509950192%）。美元口径与小数位无关，对所有币对都成立。

较基准列带 `*` 表示窗口内成功样本不足 5 条：此时服务端不会判定偏离，所以这个数字仅供参考。
样本不足时页面**照常显示数字**而不是藏起来 —— 藏起来会让人误读成「没有变化」，而实际是「暂时测不准」。

点任意一行会展开排障详情：`correlationId`（拿去找对方查）、`minAmountOut` / `minAmountIn`（看滑点与最低额）、
`HTTP`、`swapType`、该对的配置金额、连续失败次数、当前状态起始时间。

### 报红多半不是你的问题

面板上 `error` 状态的含义与排查方式，与上面「币对报红多数是对方侧状态，不是你的部署坏了」一节**完全相同** ——
备注列显示的就是那里说的「对方返回的原文」，所以照那一节读错误码即可（`limits` 加 `amount`、`recipient is not valid` 换地址）。
这里不重复一遍。

### 刷新与故障时的表现

- 每 **30 秒**自动刷新一次（采集本身是 60 秒一轮）
- 标签页切到后台时**暂停轮询**，切回来立即刷一次
- 服务不可达时指数退避（30s → 60s → 120s 封顶），顶栏显示「服务不可达（已重试 N 次）」，
  并且**保留上一次的数据**继续显示 —— 陈旧但真实的数据比空白有用。数据陈旧与否直接采信 `/health` 的判定
- 顶栏的「阈值 10%（服务端配置）」是**展示文案**，页面并不持有这个配置值。改了
  `detect.priceDeviationPct` 之后，页面不需要改任何东西 —— 因为状态本来就是服务端判定的

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

关于第 6 步的一个细节：若信号发出时正好有一轮采集在进行，进程会**先跑完这一轮再退出**
（最多约 15 秒，即一轮 38 对的耗时）；轮次之间发信号则是立即退出。这是 `main` 里
「当前轮结束后退出」的既有语义，不是卡住。
