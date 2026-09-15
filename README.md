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

## 部署

### systemd

把代码放到 `/opt/nearintents_monitoring`，配置文件放到 `/etc/nearintents-monitor/config.json`，数据目录 `/var/lib/nearintents-monitor/`（目录属主为 `nearintents` 用户）：

```bash
sudo useradd --system --home /opt/nearintents_monitoring nearintents
sudo mkdir -p /etc/nearintents-monitor /var/lib/nearintents-monitor
sudo cp config.example.json /etc/nearintents-monitor/config.json
sudo chown -R nearintents:nearintents /opt/nearintents_monitoring /var/lib/nearintents-monitor

sudo cp deploy/nearintents-monitor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nearintents-monitor
```

敏感项（Slack webhook、API bearer token）放在 `/etc/nearintents-monitor/env`，权限设 0600：

```
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx/yyy/zzz
SERVER_BEARER_TOKEN=
```

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
