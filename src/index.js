import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { ConfigError, loadConfig } from "./config.js";
import { buildPairs, normalizeTokens } from "./assets.js";
import { fetchJson } from "./http.js";
import { hourFloorIso, openStore } from "./store.js";
import { STATUS, evaluate } from "./detect.js";
import { quoteAll } from "./quote.js";
import { createNotifier, decideDigestAction, decideEventAction, formatDigest, formatEvent } from "./notify.js";
import { createServer } from "./server.js";

const USAGE = `
NEAR Intents 多链报价监控

用法: node src/index.js [选项]

  --config <path>   配置文件路径（默认 config.json）
  --data <path>     SQLite 文件路径（默认 data/monitor.db）
  --once            只跑一轮就退出
  --no-notify       不真的发 Slack，只把消息写进日志
  -h, --help        显示本帮助
`;

export function parseArgs(argv) {
  const args = { once: false, notify: true, configPath: "config.json", dataPath: "data/monitor.db", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--once") args.once = true;
    else if (token === "--no-notify") args.notify = false;
    else if (token === "--help" || token === "-h") args.help = true;
    else if (token === "--config") { args.configPath = argv[index + 1]; index += 1; }
    else if (token === "--data") { args.dataPath = argv[index + 1]; index += 1; }
    else if (token.startsWith("--config=")) args.configPath = token.slice("--config=".length);
    else if (token.startsWith("--data=")) args.dataPath = token.slice("--data=".length);
    else throw new ConfigError([`未知参数 ${token}（可用: --config --data --once --no-notify --help）`]);
  }
  if (!args.configPath) throw new ConfigError(["--config 需要一个路径参数"]);
  if (!args.dataPath) throw new ConfigError(["--data 需要一个路径参数"]);
  return args;
}

export function createLogger(stream = console) {
  const write = (level, message) => stream.log(`${new Date().toISOString()} [${level}] ${message}`);
  return {
    info: (message) => write("INFO", message),
    warn: (message) => write("WARN", message),
    error: (message) => write("ERROR", message),
  };
}

/** 可被 interrupt 的 sleep：收到 SIGINT 时立即结束等待，不用等满 intervalSec */
export function createWakeup() {
  let interruptPending = null;
  return {
    interrupt() {
      if (interruptPending) interruptPending();
    },
    wait(ms) {
      if (ms <= 0) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(() => { interruptPending = null; resolve(); }, ms);
        interruptPending = () => { clearTimeout(timer); interruptPending = null; resolve(); };
      });
    },
  };
}

export async function loadPairs({ config, fetchImpl, logger }) {
  const [stableflow, oneclick] = await Promise.all([
    fetchJson(config.tokensSources.stableflow, { timeoutMs: config.requestTimeoutMs, fetchImpl }),
    fetchJson(config.tokensSources.oneclick, { timeoutMs: config.requestTimeoutMs, fetchImpl })
      .catch((error) => {
        logger.warn(`1click token 列表拉取失败，退回本地拼接 assetId: ${error.message}`);
        return { payload: [] };
      }),
  ]);

  const payload = stableflow.payload;
  if (payload?.code !== 200 || !Array.isArray(payload?.data)) {
    throw new ConfigError([`StableFlow token 列表格式异常（code=${payload?.code}），无法解析白名单`]);
  }

  return buildPairs({
    pairDefs: config.pairs,
    tokens: normalizeTokens({ stableflow: payload.data, oneclick: oneclick.payload }),
    addresses: config.addresses,
    defaults: config.defaults,
    defaultAmounts: config.defaultAmounts,
  });
}

export async function runRound(ctx) {
  const { config, pairs, store, notifier, logger, fetchImpl, metrics } = ctx;
  const now = ctx.now ?? new Date();
  const nowIso = now.toISOString();
  const startedAt = Date.now();
  const deadline = new Date(now.getTime() + config.defaults.deadlineMs).toISOString();
  const sinceIso = new Date(now.getTime() - config.detect.rollingWindowMinutes * 60000).toISOString();

  // 关键顺序：先读历史再写本轮，保证基准不含当前样本，不会被自己拉偏
  const histories = new Map(pairs.map((pair) => [pair.id, store.getRecentQuotes(pair.id, sinceIso, 240)]));
  const rows = await quoteAll(pairs, { config, deadline, fetchImpl, now });
  store.insertQuotes(rows);

  const previousStates = store.getPairStates();
  const summary = { ts: nowIso, ok: 0, error: 0, deviant: 0, alertsSent: 0, failedPairs: [] };

  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index];
    const row = rows[index];
    const previous = previousStates.get(pair.id) ?? null;
    const outcome = evaluate({
      quote: { ...row, swapType: pair.swapType },
      history: histories.get(pair.id),
      prevStatus: previous?.status ?? null,
      detect: config.detect,
    });

    const consecutiveFailures = row.ok ? 0 : (previous?.consecutiveFailures ?? 0) + 1;
    const statusSince = previous?.status === outcome.status ? previous.statusSince : nowIso;
    let lastAlertTs = previous?.lastAlertTs ?? null;

    if (outcome.event) {
      const action = decideEventAction({ event: outcome.event, lastAlertTs, nowIso, realertMinutes: config.detect.realertMinutes });
      const alertId = store.insertAlert({
        ts: nowIso,
        pairId: pair.id,
        kind: outcome.event.kind,
        detail: {
          ...outcome.event.detail,
          isNew: outcome.event.isNew,
          metric: outcome.metric,
          baseline: outcome.baseline,
          deviationPct: outcome.deviationPct,
          sampleCount: outcome.sampleCount,
        },
        notified: false,
      });
      if (action === "send") {
        const text = formatEvent(outcome.event, pair, {
          mention: config.slack.mention,
          statusSince: previous?.statusSince ?? null,
          lastOkTs: previous?.lastOkTs ?? null,
          consecutiveFailures,
        });
        const result = await notifier.send(text);
        store.markAlertNotified(alertId, result.ok);
        if (result.ok) {
          lastAlertTs = nowIso;
          summary.alertsSent += 1;
        }
      }
    }

    store.upsertPairState({
      pairId: pair.id,
      status: outcome.status,
      statusSince,
      lastOkTs: row.ok ? nowIso : (previous?.lastOkTs ?? null),
      lastAlertTs,
      consecutiveFailures,
      lastMetric: outcome.metric,
    });

    if (outcome.status === STATUS.OK) summary.ok += 1;
    else if (outcome.status === STATUS.ERROR) {
      summary.error += 1;
      summary.failedPairs.push({ pairId: pair.id, errorCode: row.errorCode, errorMessage: row.errorMessage });
    } else summary.deviant += 1;
  }

  summary.durationMs = Date.now() - startedAt;
  if (metrics) {
    metrics.lastRoundTs = nowIso;
    metrics.lastRoundDurationMs = summary.durationMs;
  }
  logger.info(`本轮完成: ok=${summary.ok} error=${summary.error} deviant=${summary.deviant} 告警=${summary.alertsSent} 用时=${summary.durationMs}ms`);
  if (summary.failedPairs.length > 0) {
    logger.warn(`失败明细: ${summary.failedPairs.map((p) => `${p.pairId}(${p.errorCode})`).join(", ")}`);
  }
  return summary;
}

export async function runMaintenance(ctx) {
  const { config, store, notifier, logger } = ctx;
  const now = ctx.now ?? new Date();
  const nowIso = now.toISOString();
  const currentHourIso = hourFloorIso(now);
  const rolledUpTo = store.getMeta("rolled_up_to_hour", null);

  // 只在跨过整点后做一次，顺带把保留策略一并执行
  if (rolledUpTo !== currentHourIso) {
    const result = store.rollupHours(rolledUpTo ?? currentHourIso, currentHourIso);
    store.setMeta("rolled_up_to_hour", currentHourIso);
    if (result.rows > 0) logger.info(`小时聚合: ${result.hours} 个桶 / ${result.rows} 条币对记录`);

    if (config.retention.rawDays > 0) {
      const cutoff = new Date(now.getTime() - config.retention.rawDays * 86400e3).toISOString();
      const deleted = store.pruneRaw(cutoff);
      if (deleted > 0) logger.info(`清理 ${deleted} 条超过 ${config.retention.rawDays} 天的原始报价`);
    }
    if (config.retention.hourlyDays > 0) {
      const cutoff = new Date(now.getTime() - config.retention.hourlyDays * 86400e3).toISOString();
      const deleted = store.pruneHourly(cutoff);
      if (deleted > 0) logger.info(`清理 ${deleted} 个超过 ${config.retention.hourlyDays} 天的小时桶`);
    }
  }

  await maybeSendDigest(ctx, nowIso);
}

async function maybeSendDigest(ctx, nowIso) {
  const { config, store, notifier } = ctx;
  const lastDigestTs = store.getMeta("last_digest_ts", null);
  const shouldSend = decideDigestAction({
    lastDigestTs,
    nowIso,
    hourLocal: config.slack.digest.hourLocal,
    enabled: config.slack.digest.enabled && config.slack.enabled,
  });
  if (!shouldSend) return;

  const sinceIso = new Date(Date.parse(nowIso) - 24 * 3600e3).toISOString();
  const stats = store.getStats({ sinceIso, resolution: "raw" });
  const labels = new Map(store.getPairs().map((pair) => [pair.id, pair.label]));
  const totalRounds = stats.pairs.reduce((sum, entry) => sum + entry.n, 0);
  const okRounds = stats.pairs.reduce((sum, entry) => sum + entry.okN, 0);
  const worst = stats.pairs
    .map((entry) => ({ pairId: entry.pairId, label: labels.get(entry.pairId) ?? entry.pairId, failures: entry.n - entry.okN }))
    .filter((entry) => entry.failures > 0)
    .sort((a, b) => b.failures - a.failures)
    .slice(0, 3);
  const p95s = stats.pairs.map((entry) => entry.latency?.p95).filter((value) => typeof value === "number");

  const text = formatDigest({
    windowHours: 24,
    pairCount: stats.pairs.length,
    totalRounds,
    okRounds,
    okRate: totalRounds === 0 ? null : okRounds / totalRounds,
    worst,
    latencyP95: p95s.length === 0 ? null : Math.max(...p95s),
  }, { mention: config.slack.mention });

  const result = await notifier.send(text);
  if (result.ok) store.setMeta("last_digest_ts", nowIso);
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const logger = deps.logger ?? createLogger();
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const config = loadConfig({ file: args.configPath, env: process.env });
  if (args.dataPath !== ":memory:") mkdirSync(dirname(args.dataPath), { recursive: true });
  const store = openStore(args.dataPath);

  const pairs = await loadPairs({ config, fetchImpl, logger });
  logger.info(`已解析 ${pairs.length} 个币对，数据文件 ${args.dataPath}`);
  store.upsertPairs(pairs, new Date().toISOString());

  const notifier = createNotifier({
    enabled: config.slack.enabled && args.notify,
    webhookUrl: config.slack.webhookUrl,
    timeoutMs: config.slack.timeoutMs,
    fetchImpl,
    logger,
  });

  const metrics = { startedAt: new Date().toISOString(), lastRoundTs: null, lastRoundDurationMs: null };
  const healthSnapshot = () => ({
    startedAt: metrics.startedAt,
    lastRoundTs: metrics.lastRoundTs,
    lastRoundDurationMs: metrics.lastRoundDurationMs,
    pairs: pairs.length,
    dbBytes: (() => { try { return statSync(args.dataPath).size; } catch { return null; } })(),
  });

  const server = createServer({ store, config, healthSnapshot, logger });
  await new Promise((resolve) => server.listen(config.server.port, config.server.host, resolve));
  // 用实际绑定的端口，而不是配置值：配置为 0 时内核会挑一个，
  // 打配置值会报出一个根本没人监听的地址。
  logger.info(`HTTP API 监听 http://${config.server.host}:${server.address().port}`);

  const wakeup = createWakeup();
  let stopping = false;
  const onSignal = (signal) => {
    if (stopping) return;
    logger.info(`收到 ${signal}，当前轮结束后退出`);
    stopping = true;
    wakeup.interrupt();
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  const ctx = { config, pairs, store, notifier, logger, fetchImpl, metrics };
  let roundErrors = 0;

  try {
    do {
      const startedAt = Date.now();
      try {
        await runRound(ctx);
        roundErrors = 0;
      } catch (error) {
        roundErrors += 1;
        logger.error(`本轮采集失败: ${error?.stack ?? error?.message ?? error}`);
      }
      try {
        await runMaintenance(ctx);
      } catch (error) {
        logger.error(`维护任务失败: ${error?.stack ?? error?.message ?? error}`);
      }
      if (args.once || stopping) break;
      const waitMs = config.intervalSec * 1000 - (Date.now() - startedAt);
      if (waitMs <= 0) logger.warn("上一轮耗时超过 intervalSec，立即开始下一轮");
      await wakeup.wait(waitMs);
    } while (!stopping);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    logger.info("已停止");
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${error?.message ?? error}\n`);
      process.exit(1);
    });
}
