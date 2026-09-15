// ============================================================================
// 纯函数区
//
// 这一层不访问 document / window / fetch / localStorage —— 它会被 node:test
// 直接 import，顶层碰任何 DOM 或网络全局都会让测试在加载期就炸。
// 会出错的是算术、格式化与排序，那些全在这里，因此全都有测试。
// 新增逻辑时先问它属于哪一层：能写成纯函数的绝不写进下面的 init()。
// ============================================================================

export const STATUS_LABELS = { ok: "正常", deviant: "偏离", error: "失败", unknown: "未报价" };

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

function buildRow({ pair, quote, stat, depth, depthIndex, nowIso }) {
  const pairId = pair?.id ?? quote?.pairId ?? "?";
  // 状态一律取服务端的判定结果（/latest 的 stateStatus）。
  // 不用 /pairs 里的 state —— 那是启动那一刻的快照；也不自己算 ——
  // priceDeviationPct 与 minSamples 都不在 API 里，自己算迟早会和告警说法不一致。
  const status = quote?.stateStatus ?? null;
  const fromKey = pair?.fromKey ?? pairId.split(">")[0] ?? "";
  const toKey = pair?.toKey ?? pairId.split(">")[1] ?? "";
  // 参考 UI 在币对下方用 <small> 显示链。我们的币对跨两个网络，所以第二行放**源链与目标链**
  // （白名单是枢纽辐射形状，两个链是区分维度）。
  const fromChain = String(fromKey).split(":")[0] || "未知";
  const toChain = String(toKey).split(":")[0] || "未知";
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
    fromChain,
    toChain,
    status,
    statusLabel: STATUS_LABELS[status] ?? STATUS_LABELS.unknown,
    payText: quote?.ok ? formatAmount(amountIn) : "—",
    receiveText: quote?.ok ? formatAmount(amountOut) : "—",
    usdText: quote?.amountInUsd == null ? "—" : `$${formatAmount(Number(quote.amountInUsd))}`,
    costText: formatCostPct(costPct),
depthText: depthCell({ pairId, depth: depth ?? null, index: depthIndex }).text,
    depthTitle: depthCell({ pairId, depth: depth ?? null, index: depthIndex }).title,
    depthCurve: depthCurveFor({ pairId, depth: depth ?? null, index: depthIndex }),
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

/**
 * 顶栏那行状态文案。放在纯函数区是因为渲染层没有自动化测试，
 * 而这里的判断会直接决定「用户看到的是不是事实」。
 */
export function freshnessText({ health, loadedAtIso = null, nowIso, nextRefreshAt = null }) {
  const nextRefreshText = nextRefreshAt === null
    ? ""
    : `下次自动刷新 ${Math.max(0, Math.ceil((nextRefreshAt - Date.parse(nowIso)) / 1000))} 秒`;
  if (loadedAtIso === null) return { text: "正在加载…", nextRefreshText, warn: false };
  const parts = [`最后更新 ${formatRelativeTime(loadedAtIso, nowIso)}`];
  if (health && health.lastRoundTs === null) {
    // 刚启动：lastRoundTs 是内存态、第一轮还没跑完，/health 因此回 503。
    // 这个 503 的意思是「还没开始」，不是「陈旧」—— 说成陈旧会让人以为采集挂了。
    parts.push("正在采集第一轮（约 15 秒）");
    return { text: parts.join(" · "), nextRefreshText, warn: false };
  }
  if (health?.ok === false) parts.push("采集已陈旧");
  if (health?.consecutiveRoundErrors > 0) parts.push(`采集轮次连续失败 ${health.consecutiveRoundErrors} 次`);
  return { text: parts.join(" · "), nextRefreshText, warn: health?.ok === false };
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

/** 「可按」单元格：这一对能通过的最大档位。 */
export function depthCell({ pairId, depth, index }) {
  // 「没取到」与「已关闭」必须分开：前者是 ?（还没扫过/本次拉取失败），后者才是 —
  if (!depth) return { text: "?", title: "还没有取到深度数据" };
  if (depth.enabled !== true) return { text: "—", title: "深度扫描已在 config.json 里关闭" };
  if (depth.ts === null || depth.ts === undefined) {
    return { text: "?", title: "还没有扫描过（最长等一个扫描间隔）" };
  }
  const entry = index?.get(pairId);
  // 「本次没测它」与「测了但都做不了」必须分开：前者是 ?（未知），后者才是 —（确定都做不了）。
  // 前者正是那些哨兵坏掉、拿不到价格因而无法折算金额的币对 —— 显示「—」会把它们谎报成做不了。
  if (!entry) {
    return { text: "?", title: "这一对本次没有被扫描（一小时内没有成功报价，无法折算金额）" };
  }
  if (entry.maxTierUsd === null) {
    return { text: "—", title: "所有档位都没有报价" };
  }
  // 参考 UI 的「可按」显示美元额（如 $25,000）。我们的档位本来就是名义美元，
  // 所以直接渲染成 $1M / $100k —— 照它的形式，同时是真实值，不伪造。
  return { text: `$${formatTier(entry.maxTierUsd)}`, title: "已验证可通过的最大金额档位（名义美元）" };
}

/** 展开行里的档位曲线，按档位升序。 */
export function depthCurveFor({ pairId, depth, index }) {
  if (!depth || depth.enabled !== true || depth.ts === null || depth.ts === undefined) return [];
  const entry = index?.get(pairId);
  if (!entry) return [];
  return [...entry.byTier.values()]
    .sort((left, right) => left.tierUsd - right.tierUsd)
    .map((row) => {
      const ok = row.ok === true;
      const costText = ok ? formatCostPct(computeCostPct(row.amountInUsd, row.amountOutUsd)) : "—";
      const note = ok ? "" : String(row.errorMessage ?? row.errorCode ?? "未知错误");
      return {
        tierText: `$${formatTier(row.tierUsd)}`,
        ok,
        costText,
        note,
        // 整段拼好在纯函数区完成，渲染层只负责 join —— 这样这段文案有测试
        text: `$${formatTier(row.tierUsd)} · ${ok ? "可通" : "不通"} · ${ok ? costText : note}`,
      };
    });
}

export function buildRows({ pairs = [], latest = [], stats = [], depth = null, nowIso }) {
  const latestByPair = new Map(latest.map((entry) => [entry.pairId, entry]));
  const statsByPair = new Map(stats.map((entry) => [entry.pairId, entry]));
  // 索引只建一次：按行建会是 O(n²)
  const depthIndex = depth?.enabled === true && depth.ts !== null && depth.ts !== undefined
    ? buildDepthIndex(depth.rows ?? [])
    : new Map();
  const rows = [];
  const seen = new Set();

  for (const pair of pairs) {
    seen.add(pair.id);
    rows.push(buildRow({
      pair, quote: latestByPair.get(pair.id) ?? null, stat: statsByPair.get(pair.id) ?? null,
      depth, depthIndex, nowIso,
    }));
  }
  for (const entry of latest) {
    if (seen.has(entry.pairId)) continue;
    rows.push(buildRow({ pair: null, quote: entry, stat: statsByPair.get(entry.pairId) ?? null, depth, depthIndex, nowIso }));
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
    countOk: document.getElementById("count-ok"),
    countDeviant: document.getElementById("count-deviant"),
    countError: document.getElementById("count-error"),
    countUnknown: document.getElementById("count-unknown"),
    statNone: document.getElementById("stat-none"),
    liveDot: document.getElementById("live-dot"),
    apiState: document.getElementById("api-state"),
    freshDot: document.getElementById("fresh-dot"),
    freshness: document.getElementById("freshness"),
    nextRefresh: document.getElementById("next-refresh"),
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
    depth: null,
    lastLoadedAt: null,
    failures: 0,
    chainsBuilt: false,
    timer: null,
    inFlight: false,
    nextRefreshAt: null,
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
    // 判断逻辑在纯函数区（freshnessText），这里只负责赋值
    const { text, nextRefreshText, warn } = freshnessText({
      health: state.health,
      loadedAtIso: state.lastLoadedAt,
      nowIso: new Date().toISOString(),
      nextRefreshAt: state.nextRefreshAt,
    });
    el.freshness.textContent = text;
    el.nextRefresh.textContent = nextRefreshText;
    el.freshDot.classList.toggle("is-stale", warn);
  }

  function renderApiState() {
    const down = state.failures > 0;
    el.liveDot.classList.toggle("is-down", down);
    el.apiState.textContent = down ? "API OFFLINE" : "API ONLINE";
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

  /** 需要多个节点（strong / span / small）的单元格 */
  function cellWith(className, ...nodes) {
    const td = document.createElement("td");
    if (className) td.className = className;
    td.append(...nodes);
    return td;
  }

  const textOf = (tag, text, className) => {
    const node = document.createElement(tag);
    node.textContent = text ?? "";
    if (className) node.className = className;
    return node;
  };

  function toggleDetail(row, anchor) {
    const selector = `tr[data-detail="${row.pairId}"]`;
    const existing = el.tbody.querySelector(selector);
    if (existing) {
      existing.remove();
      anchor.setAttribute("aria-expanded", "false");
      anchor.classList.remove("is-expanded");
      return;
    }
    const tr = document.createElement("tr");
    tr.className = "detail-row";
    tr.dataset.detail = row.pairId;
    const td = document.createElement("td");
    td.colSpan = 9;

    const grid = document.createElement("div");
    grid.className = "detail-grid";
    const items = [
      ["correlationId", row.detail.correlationId],
      ["最小接受", row.detail.minAmountOut],
      ["最小付出", row.detail.minAmountIn],
      ["HTTP", row.detail.httpStatus],
      ["swapType", row.detail.swapType],
      ["配置金额", row.detail.configuredAmount],
      ["连续失败", `${row.detail.consecutiveFailures} 次`],
      ["状态起始", row.detail.statusSince],
    ];

    for (const [label, value] of items) {
      const box = document.createElement("div");
      box.append(textOf("span", label), textOf("b", value));
      grid.append(box);
    }
    if (row.note) {
      // 失败原文单独占满一行（可能很长），并且是可见文字 —— 只靠 title 的话触屏与键盘读不到
      const box = document.createElement("div");
      box.className = "failure-detail";
      box.append(textOf("span", "失败原文"), textOf("b", row.note));
      grid.append(box);
    }
    if (row.depthCurve.length > 0) {
      const depthBox = document.createElement("div");
      depthBox.className = "depth-detail";
      depthBox.append(textOf("span", `深度扫描 / ${row.depthCurve.length} 档`));
      const tierList = document.createElement("div");
      tierList.className = "tier-list";
      for (const point of row.depthCurve) {
        // 每个档位独立一块，而不是拼成一行文本
        const tier = document.createElement("div");
        tier.className = `tier ${point.ok ? "is-ok" : "is-bad"}`;
        tier.append(
          textOf("b", point.tierText),
          textOf("small", point.ok ? `可通 · ${point.costText}` : `不通 · ${point.note}`),
        );
        if (!point.ok) tier.title = point.note;
        tierList.append(tier);
      }
      depthBox.append(tierList);
      grid.append(depthBox);
    }
    td.append(grid);
    tr.append(td);
    tr.addEventListener("click", () => tr.remove());
    anchor.setAttribute("aria-expanded", "true");
    anchor.classList.add("is-expanded");
    anchor.after(tr);
  }

  function buildRowElement(row) {
    const tr = document.createElement("tr");
    // 可展开的行按参考 UI 做成可交互元素：role=button + tabindex + aria-expanded + Enter/Space，
    // 否则只能用鼠标下钻（这是本项目此前明确未满足的无障碍需求）。
    const interactive = Boolean(row.detail);
    if (interactive) {
      tr.setAttribute("role", "button");
      tr.setAttribute("tabindex", "0");
      tr.setAttribute("aria-expanded", "false");
      tr.addEventListener("click", () => toggleDetail(row, tr));
      tr.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleDetail(row, tr);
        }
      });
    }
    const cells = {
      pair: cellWith("", 
        textOf("strong", row.fromKey),
        textOf("span", "→", "arrow"),
        textOf("strong", row.toKey),
        textOf("small", `源链 ${row.fromChain} · 目标链 ${row.toChain}`)),
      status: cellWith("", textOf("span", row.statusLabel, `status status-${row.statusLabel}`)),
      amount: cellWith("mono",
        textOf("span", `${row.payText} `),
        textOf("span", "→", "arrow"),
        textOf("span", ` ${row.receiveText}`)),
      usd: cell(row.usdText, "mono hide-medium"),
      cost: cell(row.costText, "mono"),
      deviation: cell(row.deviationMuted ? `${row.deviationText}*` : row.deviationText,
        row.deviationText === "—" ? "mono" : (row.status === "deviant" ? "mono deviation" : "mono")),
      depth: cell(row.depthText, "mono depth-value depth-col"),
      latency: cell(row.latencyMs === null ? "—" : `${Math.round(row.latencyMs)}ms`, "mono hide-medium"),
      time: cell(row.lastQuoteText, "muted"),
    };
    if (row.lastQuoteTitle) cells.time.title = row.lastQuoteTitle;
    // 备注列去掉了：失败原因挂到状态徽章的 hover 上（要求如此）。
    // 完整原文同时进展开详情 —— 只靠 title 的话触屏与键盘读不到。
    if (row.note) cells.status.title = row.note;
    if (row.deviationMuted) cells.deviation.title = "样本不足，服务端此时不会判定偏离；仅供参考";
    if (row.depthTitle) cells.depth.title = row.depthTitle;
    tr.append(cells.pair, cells.status, cells.amount, cells.usd, cells.cost,
      cells.deviation, cells.depth, cells.latency, cells.time);
    return tr;
  }

  function renderRows() {
    const filtered = applyFilters(sortRows(state.rows), currentFilters());
    el.shownCount.textContent = `${filtered.length} / ${state.rows.length} 对`;
    el.tbody.replaceChildren();
    for (const row of filtered) el.tbody.append(buildRowElement(row));
    const noData = state.rows.length === 0;
    el.empty.hidden = !noData;
    if (noData) el.empty.textContent = "服务在跑，但还没有采集到任何报价 —— 等一轮（约 1 分钟）后刷新。";
  }

  async function load() {
    if (state.inFlight) return;
    state.inFlight = true;
    el.refresh.textContent = "刷新中…";
    try {
      const [latest, stats, health, depth] = await Promise.all([
        apiGet("/latest"),
        apiGet("/stats?window=1h"),
        // /health 在陈旧时回 503，但「陈旧」这件事本身正是我们要读的，所以允许 503
        apiGet("/health", { allowStatus: [503] }),
        // /depth 拿不到不该让整页失败 —— 只是「可按」列显示问号
        apiGet("/depth").catch(() => null),
      ]);
      state.health = health;
      state.depth = depth;
      state.rows = buildRows({
        pairs: state.pairs,
        latest: latest.latest ?? [],
        stats: stats.pairs ?? [],
        depth: state.depth,
        nowIso: new Date().toISOString(),
      });
      // 扫描关闭时整列隐藏 —— 否则会与「全档不通」的破折号长得一样，而手机上悬停不了
      document.getElementById("table").classList.toggle("no-depth", state.depth?.enabled === false);
      state.lastLoadedAt = new Date().toISOString();
      state.failures = 0;
      el.tokenBox.hidden = true;
      setBanner("", null);
      const counts = summarise(state.rows);
      el.countOk.textContent = counts.ok;
      el.countDeviant.textContent = counts.deviant;
      el.countError.textContent = counts.error;
      // 未报价只在非零时占用一格：否则 0/0/0 会被读成「一切正常」
      el.countUnknown.textContent = counts.unknown;
      el.statNone.hidden = counts.unknown === 0;
      renderApiState();
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
      el.refresh.textContent = "刷新数据";
      renderApiState();
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
      renderApiState();
      renderFreshness();
    }
  }

  function schedule() {
    if (state.timer !== null) clearTimeout(state.timer);
    // 后台标签页不轮询；重新可见时会立刻刷一次
    if (document.visibilityState === "hidden") return;
    const wait = Math.min(REFRESH_MS * Math.max(1, state.failures), MAX_BACKOFF_MS);
    state.nextRefreshAt = Date.now() + wait;
    renderFreshness();
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
      state.nextRefreshAt = null;   // 暂停轮询时清掉，别显示一个不会到点的倒计时
      renderFreshness();
    }
  });

  // 「最后更新 N 秒前」要自己跳秒，否则一个每分钟才变的面板看起来是死的
  setInterval(renderFreshness, 1000);
  bootstrap().then(schedule);
}

