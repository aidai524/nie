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

/** 四舍五入到零的数不该带负号：-0.0000012 会得到 "-0.00"，看起来像坏了 */
function withoutNegativeZero(text) {
  return text === "-0.00" ? "0.00" : text;
}

export function formatDeviation(pct) {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return "—";
  const rounded = withoutNegativeZero(pct.toFixed(2));
  // 符号也按**舍入后**的字串决定，否则 0.0000012 会显示成 "+0.00%"
  const sign = rounded.startsWith("-") || rounded === "0.00" ? "" : "+";
  return `${sign}${rounded}%`;
}

/**
 * 这次报价的总损耗（%）：按美元计价，(付出 − 收到) / 付出。
 *
 * 必须用美元金额，不能拿 amountIn/amountOut 的最小单位相除 —— 后者在两个 token
 * 小数位不同时会算出天文数字：实测 bsc:USDC（18 位）→ near:USDC（6 位）得到
 * 100110509950192%。美元口径与小数位、与币价都无关，所以对所有币对都成立。
 */
export function computeCostPct(amountInUsd, amountOutUsd) {
  if (amountInUsd === null || amountInUsd === undefined) return null;
  if (amountOutUsd === null || amountOutUsd === undefined) return null;
  const paid = Number(amountInUsd);
  const received = Number(amountOutUsd);
  if (!Number.isFinite(paid) || !Number.isFinite(received) || paid === 0) return null;
  return ((paid - received) / paid) * 100;
}

/** 成本不加正号（它本来就是个损耗），但负号要保留（收到的比付出的更值钱）*/
export function formatCostPct(pct) {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return "—";
  return `${withoutNegativeZero(pct.toFixed(2))}%`;
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
  const costPct = quote?.ok ? computeCostPct(quote?.amountInUsd, quote?.amountOutUsd) : null;
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
    costText: formatCostPct(costPct),
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

/** 档位的人读形式。>= 1e6 用 M，>= 1e3 用 k，否则原数字；小数部分自然剥离。 */
export function formatTier(tierUsd) {
  const value = Number(tierUsd);
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1e6) return `${dropTrailingZero(value / 1e6)}M`;
  if (value >= 1e3) return `${dropTrailingZero(value / 1e3)}k`;
  return String(value);
}

function dropTrailingZero(value) {
  return String(Number(value.toFixed(2)));
}

/** 某一对的档位行里，能通过的最大档位。全不通给 null。 */
export function largestPassingTier(rows) {
  let largest = null;
  for (const row of rows) {
    if (!row || row.ok !== true) continue;
    if (!Number.isFinite(row.tierUsd)) continue;
    if (largest === null || row.tierUsd > largest) largest = row.tierUsd;
  }
  return largest;
}

/** 按 pairId 归并最近一次扫描的行。 */
export function buildDepthIndex(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!row || typeof row.pairId !== "string") continue;
    if (!grouped.has(row.pairId)) grouped.set(row.pairId, []);
    grouped.get(row.pairId).push(row);
  }
  const index = new Map();
  for (const [pairId, entries] of grouped) {
    index.set(pairId, {
      maxTierUsd: largestPassingTier(entries),
      byTier: new Map(entries.map((entry) => [entry.tierUsd, entry])),
    });
  }
  return index;
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


// ============================================================================
// 装配区
//
// 以下代码碰 DOM 与网络，因此没有单测 —— 它只做三件事：取数、调纯函数、
// 把结果赋给 DOM。所有判断与算术都在上面的纯函数区里。
// 唯一防回归的自动化检查是 test/dashboard-dom.test.js：它静态比对 init() 要的
// 每个 id 都真的存在于 index.html 里 —— 因为「id 写错拿到 null」是这里最可能的错。
// ============================================================================

const REFRESH_MS = 30000;
const MAX_BACKOFF_MS = 120000;
const TOKEN_STORAGE_KEY = "nearintents.token";

export function init() {
  const el = {
    counts: document.getElementById("counts"),
    freshness: document.getElementById("freshness"),
    banner: document.getElementById("banner"),
    tbody: document.getElementById("tbody"),
    empty: document.getElementById("empty"),
    shownCount: document.getElementById("shown-count"),
    onlyProblems: document.getElementById("only-problems"),
    chainSelect: document.getElementById("chain-select"),
    search: document.getElementById("search"),
    refresh: document.getElementById("refresh"),
    tokenBox: document.getElementById("token-box"),
    tokenInput: document.getElementById("token-input"),
    tokenSave: document.getElementById("token-save"),
  };

  const state = {
    pairs: [],
    rows: [],
    health: null,
    lastLoadedAt: null,
    failures: 0,
    chainsBuilt: false,
    timer: null,
    inFlight: false,
  };

  const readToken = () => {
    try { return localStorage.getItem(TOKEN_STORAGE_KEY) ?? ""; } catch { return ""; }
  };

  async function apiGet(path, { allowStatus = [] } = {}) {
    const headers = { Accept: "application/json" };
    const token = readToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(path, { headers });
    if (response.status === 401) {
      const error = new Error("需要访问令牌");
      error.needsToken = true;
      throw error;
    }
    if (!response.ok && !allowStatus.includes(response.status)) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
  }

  function setBanner(message, kind) {
    if (!message) {
      el.banner.hidden = true;
      el.banner.textContent = "";
      el.banner.className = "banner";
      return;
    }
    el.banner.hidden = false;
    el.banner.textContent = message;
    el.banner.className = `banner ${kind ?? ""}`.trim();
  }

  const currentFilters = () => ({
    onlyProblems: el.onlyProblems.checked,
    chain: el.chainSelect.value,
    query: el.search.value,
  });

  function renderFreshness() {
    if (state.lastLoadedAt === null) {
      el.freshness.textContent = "正在加载…";
      el.freshness.className = "";
      return;
    }
    const parts = [`最后更新 ${formatRelativeTime(state.lastLoadedAt, new Date().toISOString())}`];
    // 陈旧与否直接采信服务端的判定（/health 的 ok），不自己拿 intervalSec 重算 ——
    // 那个值不在 API 里，重算就会和服务端说法不一致。
    if (state.health?.ok === false) parts.push("采集已陈旧");
    if (state.health?.consecutiveRoundErrors > 0) parts.push(`采集轮次连续失败 ${state.health.consecutiveRoundErrors} 次`);
    el.freshness.textContent = parts.join(" · ");
    el.freshness.className = state.health?.ok === false ? "warn" : "";
  }

  function renderChains() {
    if (state.chainsBuilt) return;
    for (const chain of collectChains(state.pairs)) {
      const option = document.createElement("option");
      option.value = chain;
      option.textContent = chain;
      el.chainSelect.append(option);
    }
    state.chainsBuilt = true;
  }

  function cell(text, className) {
    const td = document.createElement("td");
    // 一律 textContent：errorMessage 是对方返回的任意字符串，走 innerHTML 就是注入面
    td.textContent = text ?? "";
    if (className) td.className = className;
    return td;
  }

  function toggleDetail(row, anchor) {
    const selector = `tr[data-detail="${row.pairId}"]`;
    const existing = el.tbody.querySelector(selector);
    if (existing) {
      existing.remove();
      return;
    }
    const tr = document.createElement("tr");
    tr.className = "detail";
    tr.dataset.detail = row.pairId;
    const td = document.createElement("td");
    td.colSpan = 9;
    const items = [
      ["correlationId", row.detail.correlationId],
      ["HTTP", row.detail.httpStatus],
      ["最小收得", row.detail.minAmountOut],
      ["最小付出", row.detail.minAmountIn],
      ["预估耗时", `${row.detail.timeEstimate}s`],
      ["swapType", row.detail.swapType],
      ["配置金额", row.detail.configuredAmount],
      ["连续失败", row.detail.consecutiveFailures],
      ["状态自", row.detail.statusSince],
    ];
    for (const [key, value] of items) {
      const span = document.createElement("span");
      span.className = "kv";
      const label = document.createElement("b");
      label.textContent = key;
      span.append(label, document.createTextNode(` ${value}`));
      td.append(span);
    }
    tr.append(td);
    tr.addEventListener("click", () => tr.remove());
    anchor.after(tr);
  }

  function buildRowElement(row) {
    const tr = document.createElement("tr");
    tr.className = `row ${row.status ?? "unknown"}`;
    // 用命名变量而不是 tr.children[N]：列的位置会变，下标不会自己跟着变
    const cells = {
      pair: cell(row.label, "pair"),
      status: cell(row.statusLabel, `status ${row.status ?? "unknown"}`),
      amount: cell(`${row.payText} → ${row.receiveText}`, "amount"),
      cost: cell(row.costText, "cost"),
      usd: cell(row.usdText, "usd hide-narrow"),
      deviation: cell(row.deviationMuted ? `${row.deviationText}*` : row.deviationText, row.deviationMuted ? "dev muted" : "dev"),
      latency: cell(row.latencyMs === null ? "—" : `${Math.round(row.latencyMs)}ms`, row.latencyWarn ? "latency warn" : "latency hide-narrow"),
      time: cell(row.lastQuoteText, "time"),
      note: cell(row.note, `note ${row.noteClass}`.trim()),
    };
    if (row.lastQuoteTitle) cells.time.title = row.lastQuoteTitle;
    if (row.deviationMuted) cells.deviation.title = "样本不足，服务端此时不会判定偏离；仅供参考";
    tr.append(cells.pair, cells.status, cells.amount, cells.cost, cells.usd, cells.deviation, cells.latency, cells.time, cells.note);
    if (row.detail) {
      tr.classList.add("clickable");
      tr.addEventListener("click", () => toggleDetail(row, tr));
    }
    return tr;
  }

  function renderRows() {
    const filtered = applyFilters(sortRows(state.rows), currentFilters());
    el.shownCount.textContent = filtered.length === state.rows.length
      ? `共 ${state.rows.length} 对`
      : `显示 ${filtered.length} / ${state.rows.length} 对`;
    el.tbody.replaceChildren();
    for (const row of filtered) el.tbody.append(buildRowElement(row));
    const noData = state.rows.length === 0;
    el.empty.hidden = !noData;
    if (noData) el.empty.textContent = "服务在跑，但还没有采集到任何报价 —— 等一轮（约 1 分钟）后刷新。";
  }

  async function load() {
    if (state.inFlight) return;
    state.inFlight = true;
    try {
      const [latest, stats, health] = await Promise.all([
        apiGet("/latest"),
        apiGet("/stats?window=1h"),
        // /health 在陈旧时回 503，但「陈旧」这件事本身正是我们要读的，所以允许 503
        apiGet("/health", { allowStatus: [503] }),
      ]);
      state.health = health;
      state.rows = buildRows({
        pairs: state.pairs,
        latest: latest.latest ?? [],
        stats: stats.pairs ?? [],
        nowIso: new Date().toISOString(),
      });
      state.lastLoadedAt = new Date().toISOString();
      state.failures = 0;
      el.tokenBox.hidden = true;
      setBanner("", null);
      const counts = summarise(state.rows);
      el.counts.textContent = `${counts.ok} 正常 · ${counts.deviant} 偏离 · ${counts.error} 失败`;
      renderRows();
    } catch (error) {
      state.failures += 1;
      if (error.needsToken) {
        el.tokenBox.hidden = false;
        setBanner("接口返回 401：服务配了访问令牌，请在下方填入。", "warn");
      } else {
        // 保留上一次的数据继续显示 —— 陈旧但真实的数据比空白有用，但必须标注陈旧
        setBanner(`服务不可达（已重试 ${state.failures} 次）：${error.message}`, "err");
      }
    } finally {
      state.inFlight = false;
      renderFreshness();
    }
  }

  async function bootstrap() {
    try {
      const pairs = await apiGet("/pairs");
      state.pairs = pairs.pairs ?? [];
      renderChains();
      await load();
    } catch (error) {
      if (error.needsToken) {
        el.tokenBox.hidden = false;
        setBanner("接口返回 401：服务配了访问令牌，请在下方填入。", "warn");
      } else {
        setBanner(`服务不可达：${error.message}`, "err");
      }
      renderFreshness();
    }
  }

  function schedule() {
    if (state.timer !== null) clearTimeout(state.timer);
    // 后台标签页不轮询；重新可见时会立刻刷一次
    if (document.visibilityState === "hidden") return;
    const wait = Math.min(REFRESH_MS * Math.max(1, state.failures), MAX_BACKOFF_MS);
    state.timer = setTimeout(async () => {
      await load();
      schedule();
    }, wait);
  }

  el.refresh.addEventListener("click", async () => {
    await load();
    schedule();
  });
  el.onlyProblems.addEventListener("change", renderRows);
  el.chainSelect.addEventListener("change", renderRows);
  el.search.addEventListener("input", renderRows);
  el.tokenSave.addEventListener("click", async () => {
    try { localStorage.setItem(TOKEN_STORAGE_KEY, el.tokenInput.value.trim()); } catch { /* 隐私模式下存不了，忽略 */ }
    state.failures = 0;
    await bootstrap();
    schedule();
  });
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible") {
      await load();
      schedule();
    } else if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  });

  // 「最后更新 N 秒前」要自己跳秒，否则一个每分钟才变的面板看起来是死的
  setInterval(renderFreshness, 1000);
  bootstrap().then(schedule);
}

