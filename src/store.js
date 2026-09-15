import { DatabaseSync } from "node:sqlite";
import { median, percentile } from "./numeric.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pairs (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  from_key TEXT NOT NULL,
  to_key TEXT NOT NULL,
  from_asset TEXT NOT NULL,
  to_asset TEXT NOT NULL,
  swap_type TEXT NOT NULL,
  amount TEXT NOT NULL,
  amount_minor TEXT NOT NULL,
  from_decimals INTEGER NOT NULL,
  to_decimals INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  pair_id TEXT NOT NULL,
  ok INTEGER NOT NULL,
  http_status INTEGER,
  latency_ms INTEGER,
  amount_in TEXT,
  amount_out TEXT,
  amount_in_usd TEXT,
  amount_out_usd TEXT,
  min_amount_in TEXT,
  min_amount_out TEXT,
  time_estimate INTEGER,
  correlation_id TEXT,
  error_code TEXT,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_quotes_pair_ts ON quotes(pair_id, ts);
CREATE INDEX IF NOT EXISTS idx_quotes_ts ON quotes(ts);

CREATE TABLE IF NOT EXISTS pair_state (
  pair_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  status_since TEXT NOT NULL,
  last_ok_ts TEXT,
  last_alert_ts TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_metric REAL
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  pair_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT,
  notified INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(ts);

CREATE TABLE IF NOT EXISTS quotes_hourly (
  pair_id TEXT NOT NULL,
  hour TEXT NOT NULL,
  n INTEGER NOT NULL,
  ok_n INTEGER NOT NULL,
  amount_in_avg REAL, amount_in_min REAL, amount_in_max REAL,
  amount_out_avg REAL, amount_out_min REAL, amount_out_max REAL,
  latency_avg_ms REAL,
  PRIMARY KEY (pair_id, hour)
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS depth_quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  pair_id TEXT NOT NULL,
  tier_usd INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  http_status INTEGER,
  latency_ms INTEGER,
  amount_minor TEXT,
  amount_in TEXT,
  amount_out TEXT,
  amount_in_usd TEXT,
  amount_out_usd TEXT,
  min_amount_out TEXT,
  time_estimate INTEGER,
  correlation_id TEXT,
  error_code TEXT,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_depth_pair_ts ON depth_quotes(pair_id, ts);
CREATE INDEX IF NOT EXISTS idx_depth_ts ON depth_quotes(ts);
`;

const toBool = (value) => value === 1;

function toQuote(row) {
  return {
    id: row.id,
    ts: row.ts,
    pairId: row.pair_id,
    ok: toBool(row.ok),
    httpStatus: row.http_status,
    latencyMs: row.latency_ms,
    amountIn: row.amount_in,
    amountOut: row.amount_out,
    amountInUsd: row.amount_in_usd,
    amountOutUsd: row.amount_out_usd,
    minAmountIn: row.min_amount_in,
    minAmountOut: row.min_amount_out,
    timeEstimate: row.time_estimate,
    correlationId: row.correlation_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

function toDepthQuote(row) {
  return {
    id: row.id,
    ts: row.ts,
    pairId: row.pair_id,
    tierUsd: row.tier_usd,
    ok: toBool(row.ok),
    httpStatus: row.http_status,
    latencyMs: row.latency_ms,
    amountMinor: row.amount_minor,
    amountIn: row.amount_in,
    amountOut: row.amount_out,
    amountInUsd: row.amount_in_usd,
    amountOutUsd: row.amount_out_usd,
    minAmountOut: row.min_amount_out,
    timeEstimate: row.time_estimate,
    correlationId: row.correlation_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

function toPairState(row) {
  return {
    pairId: row.pair_id,
    status: row.status,
    statusSince: row.status_since,
    lastOkTs: row.last_ok_ts,
    lastAlertTs: row.last_alert_ts,
    consecutiveFailures: row.consecutive_failures,
    lastMetric: row.last_metric,
  };
}

function toPair(row) {
  return {
    id: row.id,
    label: row.label,
    fromKey: row.from_key,
    toKey: row.to_key,
    fromAsset: row.from_asset,
    toAsset: row.to_asset,
    swapType: row.swap_type,
    amount: row.amount,
    amountMinor: row.amount_minor,
    fromDecimals: row.from_decimals,
    toDecimals: row.to_decimals,
    enabled: toBool(row.enabled),
    updatedAt: row.updated_at,
  };
}

const toHourly = (row) => ({
  pairId: row.pair_id,
  hour: row.hour,
  n: row.n,
  okN: row.ok_n,
  amountInAvg: row.amount_in_avg,
  amountInMin: row.amount_in_min,
  amountInMax: row.amount_in_max,
  amountOutAvg: row.amount_out_avg,
  amountOutMin: row.amount_out_min,
  amountOutMax: row.amount_out_max,
  latencyAvgMs: row.latency_avg_ms,
});

export function openStore(file, { DatabaseImpl = DatabaseSync } = {}) {
  const db = new DatabaseImpl(file);
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec(SCHEMA);
  return new Store(db);
}

export class Store {
  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  upsertPairs(pairs, nowIso) {
    const statement = this.db.prepare(`
      INSERT INTO pairs (id, label, from_key, to_key, from_asset, to_asset, swap_type,
                         amount, amount_minor, from_decimals, to_decimals, enabled, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label, from_asset = excluded.from_asset, to_asset = excluded.to_asset,
        swap_type = excluded.swap_type, amount = excluded.amount, amount_minor = excluded.amount_minor,
        from_decimals = excluded.from_decimals, to_decimals = excluded.to_decimals,
        enabled = 1, updated_at = excluded.updated_at`);
    this.db.exec("BEGIN");
    try {
      for (const pair of pairs) {
        statement.run(pair.id, pair.label, pair.fromKey, pair.toKey, pair.fromAsset, pair.toAsset,
          pair.swapType, pair.amount, pair.amountMinor, pair.fromDecimals, pair.toDecimals, nowIso);
      }
      if (pairs.length > 0) {
        const placeholders = pairs.map(() => "?").join(", ");
        this.db.prepare(`UPDATE pairs SET enabled = 0 WHERE id NOT IN (${placeholders})`)
          .run(...pairs.map((pair) => pair.id));
      } else {
        this.db.prepare("UPDATE pairs SET enabled = 0").run();
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getPairs() {
    return this.db.prepare("SELECT * FROM pairs ORDER BY id").all().map(toPair);
  }

  getPairsWithState() {
    return this.db.prepare(`
      SELECT p.*, s.status AS state_status, s.status_since AS state_status_since,
             s.last_ok_ts AS state_last_ok_ts, s.consecutive_failures AS state_failures
      FROM pairs p LEFT JOIN pair_state s ON s.pair_id = p.id
      ORDER BY p.id`).all().map((row) => ({
      ...toPair(row),
      state: row.state_status === null && row.state_failures === null ? null : {
        status: row.state_status,
        statusSince: row.state_status_since,
        lastOkTs: row.state_last_ok_ts,
        consecutiveFailures: row.state_failures,
      },
    }));
  }

  insertQuotes(rows) {
    if (rows.length === 0) return 0;
    const statement = this.db.prepare(`
      INSERT INTO quotes (ts, pair_id, ok, http_status, latency_ms, amount_in, amount_out,
                          amount_in_usd, amount_out_usd, min_amount_in, min_amount_out,
                          time_estimate, correlation_id, error_code, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.db.exec("BEGIN");
    try {
      for (const item of rows) {
        statement.run(
          item.ts, item.pairId, item.ok ? 1 : 0,
          item.httpStatus ?? null, item.latencyMs ?? null,
          item.amountIn ?? null, item.amountOut ?? null,
          item.amountInUsd ?? null, item.amountOutUsd ?? null,
          item.minAmountIn ?? null, item.minAmountOut ?? null,
          item.timeEstimate ?? null, item.correlationId ?? null,
          item.errorCode ?? null, item.errorMessage == null ? null : String(item.errorMessage).slice(0, 500),
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return rows.length;
  }

  getRecentQuotes(pairId, sinceIso, limit) {
    return this.db.prepare("SELECT * FROM quotes WHERE pair_id = ? AND ts >= ? ORDER BY id DESC LIMIT ?")
      .all(pairId, sinceIso, limit).map(toQuote);
  }

  getPairStates() {
    const states = new Map();
    for (const row of this.db.prepare("SELECT * FROM pair_state").all()) {
      states.set(row.pair_id, toPairState(row));
    }
    return states;
  }

  upsertPairState(state) {
    this.db.prepare(`
      INSERT INTO pair_state (pair_id, status, status_since, last_ok_ts, last_alert_ts, consecutive_failures, last_metric)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pair_id) DO UPDATE SET
        status = excluded.status, status_since = excluded.status_since,
        last_ok_ts = excluded.last_ok_ts, last_alert_ts = excluded.last_alert_ts,
        consecutive_failures = excluded.consecutive_failures, last_metric = excluded.last_metric`)
      .run(state.pairId, state.status, state.statusSince, state.lastOkTs ?? null,
        state.lastAlertTs ?? null, state.consecutiveFailures ?? 0, state.lastMetric ?? null);
  }

  insertAlert({ ts, pairId, kind, detail, notified = false }) {
    const result = this.db.prepare("INSERT INTO alerts (ts, pair_id, kind, detail, notified) VALUES (?, ?, ?, ?, ?)")
      .run(ts, pairId, kind, detail === undefined ? null : JSON.stringify(detail), notified ? 1 : 0);
    return Number(result.lastInsertRowid);
  }

  getAlerts({ limit = 100, since } = {}) {
    const rows = since
      ? this.db.prepare("SELECT * FROM alerts WHERE ts >= ? ORDER BY id DESC LIMIT ?").all(since, limit)
      : this.db.prepare("SELECT * FROM alerts ORDER BY id DESC LIMIT ?").all(limit);
    return rows.map((row) => ({
      id: row.id, ts: row.ts, pairId: row.pair_id, kind: row.kind,
      detail: row.detail === null ? null : JSON.parse(row.detail),
      notified: toBool(row.notified),
    }));
  }

  markAlertNotified(id, notified = true) {
    this.db.prepare("UPDATE alerts SET notified = ? WHERE id = ?").run(notified ? 1 : 0, id);
  }

  getLatestPerPair() {
    return this.db.prepare(`
      SELECT q.*, s.status AS state_status, s.status_since AS state_status_since,
             s.consecutive_failures AS state_failures
      FROM quotes q
      JOIN (SELECT pair_id, MAX(id) AS max_id FROM quotes GROUP BY pair_id) newest ON q.id = newest.max_id
      LEFT JOIN pair_state s ON s.pair_id = q.pair_id
      ORDER BY q.pair_id`).all().map((row) => ({
      ...toQuote(row),
      stateStatus: row.state_status,
      stateSince: row.state_status_since,
      stateFailures: row.state_failures,
    }));
  }

  getHistory({ pairId, from, to, limit = 1000, resolution = "raw" } = {}) {
    const conditions = [];
    const params = [];
    if (resolution === "hourly") {
      if (pairId) { conditions.push("pair_id = ?"); params.push(pairId); }
      if (from) { conditions.push("hour >= ?"); params.push(from); }
      if (to) { conditions.push("hour <= ?"); params.push(to); }
      const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
      return this.db.prepare(`SELECT * FROM quotes_hourly${where} ORDER BY hour DESC LIMIT ?`)
        .all(...params, limit).map(toHourly);
    }
    if (pairId) { conditions.push("pair_id = ?"); params.push(pairId); }
    if (from) { conditions.push("ts >= ?"); params.push(from); }
    if (to) { conditions.push("ts <= ?"); params.push(to); }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM quotes${where} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit).map(toQuote);
  }

  getStats({ sinceIso, resolution = "raw" }) {
    const swapTypes = new Map(this.db.prepare("SELECT id, swap_type FROM pairs").all().map((row) => [row.id, row.swap_type]));

    if (resolution === "hourly") {
      const grouped = new Map();
      for (const row of this.db.prepare(`
        SELECT pair_id, hour, n, ok_n, amount_in_avg, amount_in_min, amount_in_max,
               amount_out_avg, amount_out_min, amount_out_max, latency_avg_ms
        FROM quotes_hourly WHERE hour >= ?`).all(sinceIso)) {
        const bucket = grouped.get(row.pair_id) ?? [];
        bucket.push(row);
        grouped.set(row.pair_id, bucket);
      }
      const pairs = [];
      for (const [pairId, rows] of grouped) {
        const swapType = swapTypes.get(pairId) ?? "EXACT_OUTPUT";
        const useOut = swapType === "EXACT_INPUT";
        const pick = (suffix) => rows.map((row) => row[`amount_${useOut ? "out" : "in"}_${suffix}`]).filter((v) => v !== null);
        // 计数必须来自小时桶本身。若从原始 quotes 表取，一旦 pruneRaw 清掉保留期外的原始数据，
        // 长窗口查询的 n / okN / okRate 就会偏低，而同一响应里的 metric / latency 却来自小时桶
        // —— 一个响应两个数据源。小时桶永久保留的意义正是让长窗口不掉数。
        const n = rows.reduce((sum, row) => sum + row.n, 0);
        const okN = rows.reduce((sum, row) => sum + row.ok_n, 0);
        pairs.push({
          pairId,
          n,
          okN,
          okRate: n === 0 ? null : okN / n,
          metric: {
            mean: average(rows.map((row) => row[`amount_${useOut ? "out" : "in"}_avg`])),
            min: min(pick("min")),
            max: max(pick("max")),
          },
          latency: { mean: average(rows.map((row) => row.latency_avg_ms)) },
        });
      }
      return { resolution, pairs };
    }

    // counts 只在 raw 分支用得到，放到这里避免 hourly 请求白跑一次全表聚合
    const counts = new Map(
      this.db.prepare("SELECT pair_id, COUNT(*) AS n, SUM(ok) AS ok_n FROM quotes WHERE ts >= ? GROUP BY pair_id")
        .all(sinceIso)
        .map((row) => [row.pair_id, { n: row.n, okN: row.ok_n }]),
    );
    const grouped = new Map();
    for (const row of this.db.prepare(`
      SELECT q.pair_id, CAST(q.amount_in AS REAL) AS amount_in, CAST(q.amount_out AS REAL) AS amount_out, q.latency_ms
      FROM quotes q WHERE q.ts >= ? AND q.ok = 1`).all(sinceIso)) {
      const bucket = grouped.get(row.pair_id) ?? { amountIn: [], amountOut: [], latency: [] };
      if (row.amount_in !== null) bucket.amountIn.push(row.amount_in);
      if (row.amount_out !== null) bucket.amountOut.push(row.amount_out);
      if (row.latency_ms !== null) bucket.latency.push(row.latency_ms);
      grouped.set(row.pair_id, bucket);
    }
    const pairs = [];
    for (const pairId of new Set([...counts.keys(), ...grouped.keys()])) {
      const bucket = grouped.get(pairId) ?? { amountIn: [], amountOut: [], latency: [] };
      const count = counts.get(pairId) ?? { n: 0, okN: 0 };
      const values = swapTypes.get(pairId) === "EXACT_INPUT" ? bucket.amountOut : bucket.amountIn;
      pairs.push({
        pairId,
        n: count.n,
        okN: count.okN,
        okRate: count.n === 0 ? null : count.okN / count.n,
        metric: values.length === 0 ? null : {
          median: median(values),
          p95: percentile(values, 0.95),
          min: Math.min(...values),
          max: Math.max(...values),
        },
        latency: bucket.latency.length === 0 ? null : {
          median: median(bucket.latency),
          p95: percentile(bucket.latency, 0.95),
        },
      });
    }
    return { resolution, pairs };
  }

/** 深度扫描的一批行。与 insertQuotes 同语义：整批单事务，任一行失败全部回滚。 */
  insertDepthQuotes(rows) {
    if (rows.length === 0) return 0;
    const statement = this.db.prepare(`
      INSERT INTO depth_quotes (ts, pair_id, tier_usd, ok, http_status, latency_ms, amount_minor,
                                amount_in, amount_out, amount_in_usd, amount_out_usd, min_amount_out,
                                time_estimate, correlation_id, error_code, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.db.exec("BEGIN");
    try {
      for (const item of rows) {
        statement.run(
          item.ts, item.pairId, item.tierUsd, item.ok ? 1 : 0,
          item.httpStatus ?? null, item.latencyMs ?? null, item.amountMinor ?? null,
          item.amountIn ?? null, item.amountOut ?? null,
          item.amountInUsd ?? null, item.amountOutUsd ?? null, item.minAmountOut ?? null,
          item.timeEstimate ?? null, item.correlationId ?? null,
          item.errorCode ?? null, item.errorMessage == null ? null : String(item.errorMessage).slice(0, 500),
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return rows.length;
  }

  /** 最近一次扫描的全部行。空表返回 { ts: null, rows: [] } —— 用 ts 精确圈定，不混入更早的扫描。 */
  getLatestSweep() {
    const latest = this.db.prepare("SELECT MAX(ts) AS ts FROM depth_quotes").get();
    if (latest === undefined || latest.ts === null || latest.ts === undefined) return { ts: null, rows: [] };
    const rows = this.db.prepare("SELECT * FROM depth_quotes WHERE ts = ? ORDER BY pair_id, tier_usd")
      .all(latest.ts).map(toDepthQuote);
    return { ts: latest.ts, rows };
  }

  pruneDepth(beforeIso) {
    return Number(this.db.prepare("DELETE FROM depth_quotes WHERE ts < ?").run(beforeIso).changes);
  }

  getMeta(key, fallback) {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row === undefined ? fallback : JSON.parse(row.value);
  }

  setMeta(key, value) {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  }

  /** 幂等：同一个小时重复跑会用新值覆盖，因为原始数据在保留期内不会变 */
  rollupHour(hourIso) {
    const nextHourIso = new Date(new Date(hourIso).getTime() + 3600 * 1000).toISOString();
    const aggregates = this.db.prepare(`
      SELECT pair_id,
        COUNT(*) AS n,
        SUM(ok) AS ok_n,
        AVG(CAST(amount_in AS REAL)) AS amount_in_avg,
        MIN(CAST(amount_in AS REAL)) AS amount_in_min,
        MAX(CAST(amount_in AS REAL)) AS amount_in_max,
        AVG(CAST(amount_out AS REAL)) AS amount_out_avg,
        MIN(CAST(amount_out AS REAL)) AS amount_out_min,
        MAX(CAST(amount_out AS REAL)) AS amount_out_max,
        AVG(latency_ms) AS latency_avg_ms
      FROM quotes WHERE ts >= ? AND ts < ? GROUP BY pair_id`).all(hourIso, nextHourIso);

    const statement = this.db.prepare(`
      INSERT INTO quotes_hourly (pair_id, hour, n, ok_n, amount_in_avg, amount_in_min, amount_in_max,
                                 amount_out_avg, amount_out_min, amount_out_max, latency_avg_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pair_id, hour) DO UPDATE SET
        n = excluded.n, ok_n = excluded.ok_n,
        amount_in_avg = excluded.amount_in_avg, amount_in_min = excluded.amount_in_min, amount_in_max = excluded.amount_in_max,
        amount_out_avg = excluded.amount_out_avg, amount_out_min = excluded.amount_out_min, amount_out_max = excluded.amount_out_max,
        latency_avg_ms = excluded.latency_avg_ms`);

    for (const row of aggregates) {
      statement.run(row.pair_id, hourIso, row.n, row.ok_n,
        row.amount_in_avg, row.amount_in_min, row.amount_in_max,
        row.amount_out_avg, row.amount_out_min, row.amount_out_max,
        row.latency_avg_ms);
    }
    return { pairs: aggregates.length, rows: aggregates.length };
  }

  rollupHours(fromHourIso, toHourIsoExclusive) {
    let hours = 0;
    let rows = 0;
    for (const hourIso of hourBucketsBetween(fromHourIso, toHourIsoExclusive)) {
      const result = this.rollupHour(hourIso);
      if (result.rows > 0) hours += 1;
      rows += result.rows;
    }
    return { hours, rows };
  }

  pruneRaw(beforeIso) {
    return Number(this.db.prepare("DELETE FROM quotes WHERE ts < ?").run(beforeIso).changes);
  }

  pruneHourly(beforeIso) {
    return Number(this.db.prepare("DELETE FROM quotes_hourly WHERE hour < ?").run(beforeIso).changes);
  }
}

function average(values) {
  const usable = values.filter((value) => value !== null && value !== undefined);
  if (usable.length === 0) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

function min(values) {
  return values.length === 0 ? null : Math.min(...values);
}

function max(values) {
  return values.length === 0 ? null : Math.max(...values);
}

/** 向下取整到整点。小时桶的 key 就是整点时刻的 ISO 字符串。 */
export function hourFloorIso(date) {
  const floored = new Date(date);
  floored.setUTCMinutes(0, 0, 0);
  return floored.toISOString();
}

const HOUR_MS = 3600 * 1000;
const MAX_BUCKETS = 2000;

/** 左闭右开。max 限位是为了防止有人传进一个荒谬的区间。 */
export function hourBucketsBetween(fromIso, toIsoExclusive) {
  const buckets = [];
  const start = new Date(fromIso).getTime();
  const end = new Date(toIsoExclusive).getTime();
  for (let time = start; time < end && buckets.length < MAX_BUCKETS; time += HOUR_MS) {
    buckets.push(new Date(time).toISOString());
  }
  return buckets;
}
