// ============================================================================
// 纯函数区
//
// 这一层不访问 document / window / fetch / localStorage —— 它会被 node:test
// 直接 import，顶层碰任何 DOM 或网络全局都会让测试在加载期就炸。
// 会出错的是算术、格式化与排序，那些全在这里，因此全都有测试。
// 新增逻辑时先问它属于哪一层：能写成纯函数的绝不写进下面的 init()。
// ============================================================================

export const STATUS_LABELS = { ok: "正常", deviant: "偏离", error: "失败", unknown: "未知" };

// 仅用于「样本不足，仅供参考」的提示标注。这是服务端 detect.minSamples 的默认值，
// API 不暴露它，所以这里硬编码一份 —— 但它绝不参与状态判定（状态一律取 stateStatus）。
const LOW_SAMPLE_THRESHOLD = 5;

// 延迟超过这个值标黄。纯展示阈值。
const LATENCY_WARN_MS = 5000;

/** 链上最小单位整数字符串 → 人类可读数值。展示层，允许转 Number（只显示 6 位有效数字）。 */
export function toHumanAmount(raw, decimals) {
  if (raw === null || raw === undefined) return null;
  if (!Number.isInteger(decimals) || decimals < 0) return null;
  const text = String(raw).trim();
  if (!/^-?\d+$/.test(text)) return null;
  const negative = text.startsWith("-");
  const digits = (negative ? text.slice(1) : text).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals > 0 ? digits.slice(digits.length - decimals) : "";
  const value = Number(fraction ? `${whole}.${fraction}` : whole);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/** 手写千分位。不用 toLocaleString —— 它的输出随运行环境 locale 变化。 */
function groupThousands(text) {
  const [whole, fraction] = String(text).split(".");
  const sign = whole.startsWith("-") ? "-" : "";
  const digits = sign ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return sign + grouped + (fraction === undefined ? "" : `.${fraction}`);
}

/** 6 位有效数字 + 去尾零。用于 |v| < 1，避免 0.000001 被显示成 0.0000。 */
function toSignificant(value) {
  const abs = Math.abs(value);
  const firstSignificant = -Math.floor(Math.log10(abs)) - 1;
  const decimals = Math.min(Math.max(firstSignificant + 6, 1), 18);
  const fixed = abs.toFixed(decimals).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return value < 0 ? `-${fixed}` : fixed;
}

export function formatAmount(value) {
  if (value === null || value === undefined) return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  if (number === 0) return "0";
  const abs = Math.abs(number);
  if (abs >= 1000) return groupThousands(number.toFixed(2));
  if (abs >= 1) return number.toFixed(4);
  return toSignificant(number);
}

export function computeDeviationPct(amountIn, median) {
  const value = Number(amountIn);
  const base = Number(median);
  if (amountIn === null || amountIn === undefined) return null;
  if (median === null || median === undefined) return null;
  if (!Number.isFinite(value) || !Number.isFinite(base) || base === 0) return null;
  return ((value - base) / base) * 100;
}

export function formatDeviation(pct) {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return "—";
  return `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

/** nowIso 必须由调用方传入，否则这个函数无法测试。 */
export function formatRelativeTime(tsIso, nowIso) {
  if (!tsIso) return "—";
  const then = Date.parse(tsIso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return "—";
  const seconds = Math.floor((now - then) / 1000);
  if (seconds < 0) return "刚刚"; // 时钟偏移导致的「未来」时间，不要显示负数
  if (seconds < 60) return seconds <= 0 ? "刚刚" : `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export function summarise(rows) {
  const counts = { ok: 0, deviant: 0, error: 0, unknown: 0 };
  for (const row of rows) {
    const key = row?.status;
    if (key === "ok" || key === "deviant" || key === "error") counts[key] += 1;
    else counts.unknown += 1;
  }
  return counts;
}

const STATUS_RANK = { error: 0, deviant: 1, ok: 2 };

export function sortRows(rows) {
  return [...rows].sort((left, right) => {
    const rankLeft = STATUS_RANK[left.status] ?? 3;
    const rankRight = STATUS_RANK[right.status] ?? 3;
    if (rankLeft !== rankRight) return rankLeft - rankRight;
    // 手写比较，不用 localeCompare（其顺序随 locale 变化，测试会不稳）
    const a = String(left.pairId);
    const b = String(right.pairId);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export function applyFilters(rows, { onlyProblems = false, chain = "", query = "" } = {}) {
  const needle = query.trim().toLowerCase();
  return rows.filter((row) => {
    // 「仅异常」= 状态不是 ok 的。deviant 与「尚未报价」（null）都算需要关注。
    if (onlyProblems && row.status === "ok") return false;
    if (chain) {
      const prefix = `${chain}:`;
      if (!String(row.fromKey).startsWith(prefix) && !String(row.toKey).startsWith(prefix)) return false;
    }
    if (needle) {
      const haystack = `${row.fromKey} → ${row.toKey}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

export function collectChains(pairs) {
  const chains = new Set();
  for (const pair of pairs) {
    for (const key of [pair.fromKey, pair.toKey]) {
      const network = String(key ?? "").split(":")[0];
      if (network) chains.add(network);
    }
  }
  return [...chains].sort();
}

function buildRow({ pair, quote, stat, nowIso }) {
  const pairId = pair?.id ?? quote?.pairId ?? "?";
  // 状态一律取服务端的判定结果（/latest 的 stateStatus）。
  // 不用 /pairs 里的 state —— 那是启动那一刻的快照；也不自己算 ——
  // priceDeviationPct 与 minSamples 都不在 API 里，自己算迟早会和告警说法不一致。
  const status = quote?.stateStatus ?? null;
  const fromKey = pair?.fromKey ?? pairId.split(">")[0] ?? "";
  const toKey = pair?.toKey ?? pairId.split(">")[1] ?? "";
  const convert = (raw, decimals) => (pair ? toHumanAmount(raw, decimals) : null);

  const amountIn = convert(quote?.amountIn, pair?.fromDecimals);
  const amountOut = convert(quote?.amountOut, pair?.toDecimals);
  const deviationPct = quote?.ok ? computeDeviationPct(quote?.amountIn, stat?.metric?.median ?? null) : null;
  const lowSample = !(stat && Number.isFinite(stat.okN) && stat.okN >= LOW_SAMPLE_THRESHOLD);

  let note = "";
  let noteClass = "";
  if (quote && quote.ok === false) {
    note = [quote.errorCode, quote.errorMessage].filter(Boolean).join(" — ");
    noteClass = "err";
  } else if (!pair && quote) {
    note = "未知币对（接口返回了不在白名单里的 pairId）";
    noteClass = "warn";
  } else if (!quote) {
    note = "尚未采集到这一对";
    noteClass = "muted";
  }

  return {
    pairId,
    label: pair?.label ?? pairId,
    fromKey,
    toKey,
    status,
    statusLabel: STATUS_LABELS[status] ?? STATUS_LABELS.unknown,
    payText: quote?.ok ? formatAmount(amountIn) : "—",
    receiveText: quote?.ok ? formatAmount(amountOut) : "—",
    usdText: quote?.amountInUsd == null ? "—" : `$${formatAmount(Number(quote.amountInUsd))}`,
    deviationText: quote?.ok ? formatDeviation(deviationPct) : "—",
    deviationMuted: quote?.ok ? lowSample : false,
    latencyMs: quote?.latencyMs ?? null,
    latencyWarn: Number.isFinite(quote?.latencyMs) && quote.latencyMs > LATENCY_WARN_MS,
    lastQuoteText: quote ? formatRelativeTime(quote.ts, nowIso) : "—",
    lastQuoteTitle: quote?.ts ?? "",
    note,
    noteClass,
    detail: quote
      ? {
        correlationId: quote.correlationId ?? "—",
        httpStatus: quote.httpStatus ?? "—",
        minAmountIn: quote.minAmountIn ?? "—",
        minAmountOut: quote.minAmountOut ?? "—",
        timeEstimate: quote.timeEstimate ?? "—",
        swapType: pair?.swapType ?? "—",
        configuredAmount: pair?.amount ?? "—",
        consecutiveFailures: quote.stateFailures ?? 0,
        statusSince: quote.stateSince ?? "—",
      }
      : null,
  };
}

export function buildRows({ pairs = [], latest = [], stats = [], nowIso }) {
  const latestByPair = new Map(latest.map((entry) => [entry.pairId, entry]));
  const statsByPair = new Map(stats.map((entry) => [entry.pairId, entry]));
  const rows = [];
  const seen = new Set();

  for (const pair of pairs) {
    seen.add(pair.id);
    rows.push(buildRow({ pair, quote: latestByPair.get(pair.id) ?? null, stat: statsByPair.get(pair.id) ?? null, nowIso }));
  }
  // /latest 里出现而 /pairs 里没有的行 —— 说明契约漂移了，要显示出来而不是静默丢掉
  for (const entry of latest) {
    if (seen.has(entry.pairId)) continue;
    rows.push(buildRow({ pair: null, quote: entry, stat: statsByPair.get(entry.pairId) ?? null, nowIso }));
  }
  return rows;
}
