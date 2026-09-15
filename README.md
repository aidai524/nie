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
