import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { ConfigError, loadConfig } from "./config.js";
import { buildPairs, normalizeTokens } from "./assets.js";
import { fetchJson, mapLimit } from "./http.js";
import { hourFloorIso, openStore } from "./store.js";
import { STATUS, evaluate } from "./detect.js";
import { quoteAll, quotePair } from "./quote.js";
import { depthAmountMinor, summariseDepth } from "./depth.js";
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

/**
 * 金额阶梯扫描：对每对币按每个名义美元档位各报一次价，写进独立的 depth_quotes 表。
 *
 * 与哨兵完全隔离：不碰 quotes、不碰 pair_state、不参与告警判定。
 * 哨兵的轮次先跑、扫描后跑（同一个 runMaintenance 里按顺序），所以价格总是有的；
 * 一小时内没有成功报价的币对整对跳过（没有价格就没法把美元折算成 token 数量）。
 */
export async function runDepthSweep(ctx) {
  const { config, pairs, store, fetchImpl } = ctx;
  const now = ctx.now ?? new Date();
  const nowIso = now.toISOString();
  const deadline = new Date(now.getTime() + config.defaults.deadlineMs).toISOString();
  const sinceIso = new Date(now.getTime() - 3600e3).toISOString();

  const jobs = [];
  const skipped = [];
  for (const pair of pairs) {
    const recent = store.getRecentQuotes(pair.id, sinceIso, 20).find((quote) => quote.ok && quote.amountOutUsd);
    if (!recent) {
      skipped.push(pair.id);
      continue;
    }
    for (const tierUsd of config.depth.tiers) {
      const amountMinor = depthAmountMinor(recent, tierUsd);
      if (amountMinor === null) continue;
      jobs.push({ pair, tierUsd, amountMinor });
    }
  }

  if (skipped.length > 0) {
    logger_warnSkip(ctx, skipped);
  }
  if (jobs.length === 0) {
    // 即使一对都做不了，也要记下这次尝试 —— 否则每个哨兵轮次都会重试一遍
    // （每对一次 getRecentQuotes），而扫描节奏本该由 intervalSec 决定。
    store.setMeta("last_sweep_ts", nowIso);
    return { pairs: 0, rows: 0, skipped };
  }

  const results = await mapLimit(jobs, config.depth.concurrency, ({ pair, tierUsd, amountMinor }) =>
    quotePair({ ...pair, amountMinor }, { config, deadline, fetchImpl, now }));

  const rows = results.map((result, index) => {
    const { pair, tierUsd, amountMinor } = jobs[index];
    const quote = result.ok ? result.value : null;
    if (!quote) {
      return {
        ts: nowIso, pairId: pair.id, tierUsd, ok: false, httpStatus: null, latencyMs: null,
        amountMinor, errorCode: "internal", errorMessage: `内部错误: ${result.error?.message ?? result.error}`,
      };
    }
    return { ...quote, pairId: pair.id, tierUsd, amountMinor };
  });

  store.insertDepthQuotes(rows);
  store.setMeta("last_sweep_ts", nowIso);
  return { pairs: new Set(rows.map((r) => r.pairId)).size, rows: rows.length, skipped };
}

/** 跳过明细只打一次（否则每 15 分钟刷一遍同样的名单） */
function logger_warnSkip(ctx, skipped) {
  ctx.logger.warn(`深度扫描跳过 ${skipped.length} 对（一小时内没有成功报价，无法折算金额）：${skipped.join(", ")}`);
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
    if (config.retention.rawDays > 0) {
      const cutoff = new Date(now.getTime() - config.retention.rawDays * 86400e3).toISOString();
      const prunedDepth = store.pruneDepth(cutoff);
      if (prunedDepth > 0) logger.info(`清理 ${prunedDepth} 条超过 ${config.retention.rawDays} 天的深度数据`);
    }
  }

  // 深度扫描：低频、阻塞。190 次请求 ÷ 并发 3 约 1–2 分钟，所以每 15 轮里有 1 轮哨兵会被推迟
  // ——主循环会打出「上一轮耗时超过 intervalSec，立即开始下一轮」。这是已确认接受的代价。
  if (config.depth.enabled) {
    const lastSweepTs = store.getMeta("last_sweep_ts", null);
    const dueAt = lastSweepTs === null ? 0 : Date.parse(lastSweepTs) + config.depth.intervalSec * 1000;
    if (now.getTime() >= dueAt) {
      const result = await runDepthSweep({ ...ctx, now });
      logger.info(`深度扫描完成: ${result.pairs} 对 × ${config.depth.tiers.length} 档 = ${result.rows} 行`
        + (result.skipped.length > 0 ? `，跳过 ${result.skipped.length} 对` : ""));
    }
  }

  await maybeSendDigest(ctx, nowIso);
}

async function maybeSendDigest(ctx, nowIso) {
  const { config, store, notifier, pairs } = ctx;
  const sweep = store.getLatestSweep();
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
    depth: config.depth.enabled && sweep.ts !== null
      ? summariseDepth({ rows: sweep.rows, pairCount: pairs.length, tiers: config.depth.tiers })
      : null,
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

  const metrics = {
    startedAt: new Date().toISOString(),
    lastRoundTs: null,
    lastRoundDurationMs: null,
    consecutiveRoundErrors: 0,
  };
  // spec §8 规定 /health 返回 { ok, lastRoundTs, lastRoundAgeMs, pairs, consecutiveRoundErrors, dbBytes }。
  // consecutiveRoundErrors 必须把循环里的失败计数接上来：只自增不对外暴露的话，
  // 运维就无法区分「轮次在报错」和「轮次只是慢」，而 spec §13 把 /health 当作最早期的故障信号。
  const healthSnapshot = () => ({
    startedAt: metrics.startedAt,
    lastRoundTs: metrics.lastRoundTs,
    lastRoundAgeMs: metrics.lastRoundTs === null ? null : Date.now() - Date.parse(metrics.lastRoundTs),
    lastRoundDurationMs: metrics.lastRoundDurationMs,
    consecutiveRoundErrors: metrics.consecutiveRoundErrors,
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

  try {
    do {
      const startedAt = Date.now();
      try {
        await runRound(ctx);
        metrics.consecutiveRoundErrors = 0;
      } catch (error) {
        metrics.consecutiveRoundErrors += 1;
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
