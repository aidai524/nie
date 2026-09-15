import { fetchJson } from "./http.js";

const ICONS = { error: ":red_circle:", deviation: ":large_yellow_circle:", recover: ":large_green_circle:" };
const TITLES = { error: "报价失败", deviation: "报价偏离", recover: "已恢复" };

/** 持续异常时靠 lastAlertTs 克制，避免每分钟刷屏；恢复与状态迁移必发 */
export function decideEventAction({ event, lastAlertTs, nowIso, realertMinutes }) {
  if (!event) return "none";
  if (event.kind === "recover" || event.isNew) return "send";
  if (!lastAlertTs) return "send";
  const elapsedMinutes = (Date.parse(nowIso) - Date.parse(lastAlertTs)) / 60000;
  return elapsedMinutes >= realertMinutes ? "send" : "suppress";
}

/** 配置里的小时是服务器本地时区 */
export function decideDigestAction({ lastDigestTs, nowIso, hourLocal, enabled }) {
  if (!enabled) return false;
  const now = new Date(nowIso);
  if (now.getHours() !== hourLocal) return false;
  if (!lastDigestTs) return true;
  return Date.parse(nowIso) - Date.parse(lastDigestTs) >= 20 * 3600 * 1000;
}

const metricName = (pair) => (pair?.swapType === "EXACT_INPUT" ? "amountOut" : "amountIn");
const fixed = (value, digits = 2) => (typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "?");

function formatDuration(fromIso, toIso) {
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} 分钟`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

export function formatEvent(event, pair, { mention = "", statusSince = null, lastOkTs = null, consecutiveFailures = null } = {}) {
  const prefix = mention ? `${mention} ` : "";
  const icon = ICONS[event.kind] ?? ":grey_question:";
  const title = TITLES[event.kind] ?? event.kind;
  const lines = [`${prefix}${icon} *${pair?.label ?? pair?.id ?? "未知币对"}* ${title}`];
  const nowIso = new Date().toISOString();

  if (event.kind === "error") {
    lines.push(`\`${event.detail.errorCode}\` — ${event.detail.errorMessage}`);
    const tail = [];
    if (consecutiveFailures !== null && consecutiveFailures > 1) tail.push(`连续失败 ${consecutiveFailures} 次`);
    if (lastOkTs) tail.push(`上次成功 ${lastOkTs}`);
    if (tail.length > 0) lines.push(tail.join(" · "));
  } else if (event.kind === "deviation") {
    const sign = event.detail.deviationPct >= 0 ? "+" : "";
    lines.push(`${metricName(pair)} ${fixed(event.detail.metric)} 相对近 1 小时中位数 ${fixed(event.detail.baseline)} 偏离 ${sign}${fixed(event.detail.deviationPct)}%（样本 ${event.detail.sampleCount}）`);
  } else if (event.kind === "recover") {
    const tail = [];
    if (statusSince) {
      const duration = formatDuration(statusSince, nowIso);
      if (duration) tail.push(`异常持续 ${duration}`);
    }
    if (lastOkTs) tail.push(`上次成功 ${lastOkTs}`);
    if (tail.length > 0) lines.push(tail.join(" · "));
  }
  return lines.join("\n");
}

export function formatDigest(summary, { windowHours = 24, mention = "" } = {}) {
  const prefix = mention ? `${mention} ` : "";
  const lines = [`${prefix}:bar_chart: *过去 ${windowHours} 小时汇总*`];
  const rate = summary.okRate === null || summary.okRate === undefined
    ? "?"
    : `${(summary.okRate * 100).toFixed(1)}%`;
  lines.push(`${summary.pairCount} 对 · 共 ${summary.totalRounds} 轮 · 成功 ${summary.okRounds} 轮 · 成功率 ${rate}`);
  if (summary.worst?.length > 0) {
    lines.push(`异常最多：${summary.worst.map((w) => `${w.label}（${w.failures} 次）`).join("、")}`);
  }
if (summary.depth && summary.depth.byTier.length > 0) {
    const profile = summary.depth.byTier
      .map((entry) => `${formatTierLabel(entry.tierUsd)} ${entry.passing}/${summary.depth.pairCount}`)
      .join(" · ");
    lines.push(`深度（最近一次扫描，可通对数/总对数）：${profile}`
      + (summary.depth.deadPairs > 0 ? `（${summary.depth.deadPairs} 对全档不通）` : ""));
  }

  if (typeof summary.latencyP95 === "number") {
    lines.push(`延迟 P95：${Math.round(summary.latencyP95)}ms`);
  }
  return lines.join("\n");
}

export function createNotifier({ enabled, webhookUrl, timeoutMs = 10000, fetchImpl = globalThis.fetch, logger = console }) {
  return {
    async send(text) {
      if (!enabled) {
        logger.info(`[notify] 已禁用，跳过发送:\n${text}`);
        return { ok: true, skipped: true };
      }
      try {
        const response = await fetchJson(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
          timeoutMs,
          fetchImpl,
        });
        return { ok: true, status: response.status };
      } catch (error) {
        logger.error(`[notify] 发送失败: ${error.message}`);
        return { ok: false, error: error.message };
      }
    },
  };
}

function formatTierLabel(tierUsd) {
  const value = Number(tierUsd);
  if (!Number.isFinite(value) || value <= 0) return "?";
  if (value >= 1e6) return `${String(Number((value / 1e6).toFixed(2)))}M`;
  if (value >= 1e3) return `${String(Number((value / 1e3).toFixed(2)))}k`;
  return String(value);
}
