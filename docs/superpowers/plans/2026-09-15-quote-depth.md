# 报价深度（按金额档位）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每 15 分钟按 5 个名义美元档位（100 / 1k / 10k / 100k / 1M）对 38 对币对各报一次价，落成独立的深度数据，在面板上以「可按的最大档位」+ 展开后的成本曲线呈现，并在日汇总里给一行深度快照。

**Architecture:** 哨兵链路（`quotes`/`pair_state`/`detect`/小时聚合）**一行不改**。深度是**第二类事实**，独立建表、独立查询、独立端点，只在 `runMaintenance` 里挂一个低频扫描任务。档位按名义美元定义，用哨兵报价的 `amountOutUsd / amountOut` 折算成目标币最小单位。

**Tech Stack:** Node.js 24、`node:sqlite`、原生 ES 模块、原生 CSS、`node:test`。零依赖不变。

**Spec:** `docs/superpowers/specs/2026-09-15-quote-depth-design.md`

## Global Constraints

- **零运行时依赖。** `package.json` 不得出现 `dependencies`/`devDependencies`。只用内置模块与全局。
- **哨兵链路一行不改。** 不修改 `quotes` 表、`pair_state` 表、`insertQuotes`、`getRecentQuotes`、`getLatestPerPair`、`getHistory`、`getStats`、`getPairsWithState`、`rollupHour(s)`、`pruneRaw`、`pruneHourly` 的**任何既有行为**，也不改 `src/detect.js`、`src/quote.js`、`src/notify.js` 的既有逻辑。既有 230 个测试必须逐字通过。
- `src/store.js` 仍只 import `node:sqlite` 与 `./numeric.js`。`public/dashboard.js` 的**模块顶层**仍不得访问 `document`/`window`/`fetch`/`localStorage`。
- **金额一律字符串**，除聚合统计外不经过浮点。
- **UI 文案中文，标识符英文；不要 emoji。** 所有来自 API 的文本用 `textContent` 写入，绝不用 `innerHTML`。
- `npm test` 必须全绿且输出干净（除 npm 自己的 `notice` 行外无警告）。
- 每个 Task 结束提交一次，前缀 `feat:` / `test:` / `docs:`。

## File Structure

```
src/store.js          # 追加 depth_quotes 表 + insertDepthQuotes/getLatestSweep/pruneDepth
src/config.js         # 追加 DEFAULT_CONFIG.depth + validate 规则
src/index.js          # 追加 runDepthSweep；runMaintenance 里挂调度；runMaintenance 里加 pruneDepth；日汇总加快照行
src/server.js         # 追加 GET /depth
public/dashboard.js   # 纯函数区追加 depthAmountMinor/formatTier/largestPassingTier/buildDepthIndex；init() 追加取数与渲染
public/index.html     # 追加「可按」表头 + 隐藏列的类名 + 曲线容器样式
test/store-depth.test.js      # 新文件：depth 表的读写与保留
test/dashboard-depth.test.js  # 新文件：深度相关的纯函数
test/config.test.js   # 追加 depth 校验用例
test/index.test.js    # 追加 runDepthSweep 用例
test/server.test.js   # 追加 /depth 用例
test/dashboard-dom.test.js    # 更新表头为 10 列
README.md             # 追加深度扫描一节
```

---

### Task 1: store —— `depth_quotes` 表与读写

**Files:**
- Modify: `src/store.js`（追加 SCHEMA 一段、一个 mapper、四个方法）
- Test: `test/store-depth.test.js`（新文件）

**Interfaces:**
- Consumes: 既有 `Store` 的构造方式与 `toBool` 帮助函数
- Produces:
  - `Store.prototype.insertDepthQuotes(rows): number` —— 单事务，任何一行失败整体回滚
  - `Store.prototype.getLatestSweep(): { ts: string|null, rows: DepthQuote[] }` —— 最近一次 `ts` 的**全部**行，按 `pair_id, tier_usd` 排序；空表返回 `{ ts: null, rows: [] }`
  - `Store.prototype.pruneDepth(beforeIso): number`
  - `DepthQuote = { id, ts, pairId, tierUsd, ok, httpStatus, latencyMs, amountMinor, amountIn, amountOut, amountInUsd, amountOutUsd, minAmountOut, timeEstimate, correlationId, errorCode, errorMessage }`

- [ ] **Step 1: 写失败测试 `test/store-depth.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/store.js";

const PAIR = {
  id: "near:USDC>eth:USDC", label: "near:USDC → eth:USDC", fromKey: "near:USDC", toKey: "eth:USDC",
  fromAsset: "a", toAsset: "b", swapType: "EXACT_OUTPUT", amount: "1500", amountMinor: "1500000000",
  fromDecimals: 6, toDecimals: 6,
};
const TIERS = [100, 1000, 10000, 100000, 1000000];

const row = (ts, tierUsd, overrides = {}) => ({
  ts, pairId: PAIR.id, tierUsd, ok: true, httpStatus: 201, latencyMs: 1300,
  amountMinor: String(tierUsd) + "000000", amountIn: "100410645", amountOut: "100000000",
  amountInUsd: "100.41", amountOutUsd: "100.00", minAmountOut: "100000000",
  timeEstimate: 27, correlationId: "cid",
  ...overrides,
});

function fresh() {
  const store = openStore(":memory:");
  store.upsertPairs([PAIR], "2026-09-15T00:00:00Z");
  return store;
}

test("depth_quotes 表存在，写入后能按 (pair, tier) 读回", () => {
  const store = fresh();
  store.insertDepthQuotes([row("2026-09-15T00:00:00.000Z", 100), row("2026-09-15T00:00:00.000Z", 1000)]);
  const sweep = store.getLatestSweep();
  assert.equal(sweep.ts, "2026-09-15T00:00:00.000Z");
  assert.deepEqual(sweep.rows.map((r) => r.tierUsd), [100, 1000], "tierUsd 是数字且按档位升序");
  assert.equal(sweep.rows[0].pairId, PAIR.id);
  assert.equal(sweep.rows[0].ok, true, "ok 读回来是布尔");
  assert.equal(sweep.rows[0].amountInUsd, "100.41", "金额保持字符串");
  store.close();
});

test("getLatestSweep 只返回最近一次扫描的行，不混入更早的", () => {
  const store = fresh();
  store.insertDepthQuotes([row("2026-09-15T00:00:00.000Z", 100), row("2026-09-15T00:00:00.000Z", 1000)]);
  store.insertDepthQuotes([row("2026-09-15T00:15:00.000Z", 100)]);
  const sweep = store.getLatestSweep();
  assert.equal(sweep.ts, "2026-09-15T00:15:00.000Z");
  assert.equal(sweep.rows.length, 1, "不能把上一轮的 1000 档也算进来");
  store.close();
});

test("getLatestSweep 在空表上返回 ts: null 而不是抛错或 undefined", () => {
  const store = fresh();
  assert.deepEqual(store.getLatestSweep(), { ts: null, rows: [] });
  store.close();
});

test("insertDepthQuotes 整批单事务：一行失败则全部回滚", () => {
  const store = fresh();
  assert.equal(store.insertDepthQuotes([row("2026-09-15T00:00:00.000Z", 100)]), 1);
  assert.equal(store.insertDepthQuotes([]), 0);
  assert.throws(
    () => store.insertDepthQuotes([row("2026-09-15T00:15:00.000Z", 100), { ts: "x", pairId: null, tierUsd: 1, ok: false }]),
    /NOT NULL|constraint/i,
  );
  assert.equal(store.getLatestSweep().rows.length, 1, "失败那批的第一行也应回滚");
  store.close();
});

test("insertDepthQuotes 把 errorMessage 截断到 500", () => {
  const store = fresh();
  store.insertDepthQuotes([row("2026-09-15T00:00:00.000Z", 1000000, {
    ok: false, errorCode: "http_4xx", errorMessage: "x".repeat(900),
  })]);
  const [entry] = store.getLatestSweep().rows;
  assert.equal(entry.errorMessage.length, 500);
  assert.equal(entry.ok, false);
  assert.equal(entry.errorCode, "http_4xx");
  store.close();
});

test("pruneDepth 只删 cutoff 之前的行", () => {
  const store = fresh();
  store.insertDepthQuotes([
    row("2026-09-01T00:00:00.000Z", 100),
    row("2026-09-14T00:00:00.000Z", 100),
    row("2026-09-15T00:00:00.000Z", 100),
  ]);
  // cutoff 落在两行之间：09-01 与 09-14T00:00 都早于它，所以删 2 行
  assert.equal(store.pruneDepth("2026-09-14T12:00:00.000Z"), 2);
  const sweep = store.getLatestSweep();
  assert.equal(sweep.ts, "2026-09-15T00:00:00.000Z", "最近的还在");
  assert.equal(sweep.rows.length, 1, "只剩 09-15 这一行");
  store.close();
});

test("深度数据与哨兵报价互不干扰", () => {
  const store = fresh();
  store.insertQuotes([{
    ts: "2026-09-15T00:00:00.000Z", pairId: PAIR.id, ok: true, httpStatus: 201, latencyMs: 1000,
    amountIn: "1501660000", amountOut: "1500000000", amountInUsd: "1501", amountOutUsd: "1500",
  }]);
  store.insertDepthQuotes([row("2026-09-15T00:00:05.000Z", 1000000, {
    ok: false, errorCode: "http_4xx", errorMessage: "No liquidity available",
  })]);
  assert.equal(store.getHistory({}).length, 1, "哨兵的 quotes 只有 1 条");
  assert.equal(store.getLatestPerPair()[0].ok, true, "/latest 用到的仍是最好的那条哨兵行，没被深度行污染");
  assert.equal(store.getLatestSweep().rows.length, 1, "深度表独立");
  store.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— `store.insertDepthQuotes is not a function`

- [ ] **Step 3: 改 `src/store.js`（三处追加，不动既有代码）**

(a) 在 `SCHEMA` 常量的 `meta` 表之后、结尾反引号之前追加：

```sql
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
```

(b) 在 `toQuote` 之后追加一个 mapper：

```js
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
```

(c) 在 `Store` 类里、`setMeta` 之后追加三个方法：

```js
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS —— 新增 7 个用例，总数 **237**，输出干净

- [ ] **Step 5: 提交**

```bash
git add src/store.js test/store-depth.test.js
git commit -m "feat: depth_quotes 表与读写，与哨兵链路完全隔离"
```

---

### Task 2: `src/depth.js` —— 名义美元档位折算（后端）

**为什么是独立模块、而不是放进页面脚本。** 折算出的金额是**后端发请求**用的；前端只需要显示「最大可通档位」，根本不需要做这个换算。放进 `public/dashboard.js` 会让后端去 import 一个静态资源文件 —— 分层颠倒。所以它是一个独立的后端模块，页面脚本只保留展示函数（Task 3）。

**Files:**
- Create: `src/depth.js`
- Test: `test/depth.test.js`

**Interfaces:**
- Consumes: 无（这是叶子模块，不 import 任何东西 —— 与 `amount.js`/`numeric.js` 同级）
- Produces: `depthAmountMinor(quote, tierUsd): string | null`

- [ ] **Step 1: 写失败测试 `test/depth.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { depthAmountMinor } from "../src/depth.js";

// 哨兵报价行：付出 100.41 美元换到 100 个目标币 → 目标币单价 1.0041 美元
const SENTINEL = { ok: true, amountOut: "100000000", amountOutUsd: "100.41" };
// 18 位小数的目标币：0.5 个币值 575.23 美元
const SENTINEL_18 = { ok: true, amountOut: "500000000000000000", amountOutUsd: "575.23" };

test("按 amountOutUsd/amountOut 折算：想收到 100 美元要多少目标币最小单位", () => {
  assert.equal(depthAmountMinor(SENTINEL, 100), "99591674");
  assert.equal(depthAmountMinor(SENTINEL, 1000000), "995916741360");
});

test("18 位小数上必须走精确整数运算（结果超过 2^53）", () => {
  // 100 × 5e17 / 575.23 的精确值是 86921753037915269，超过 Number.MAX_SAFE_INTEGER。
  // 用浮点算会得到 …264 —— 所以要 BigInt。
  assert.equal(depthAmountMinor(SENTINEL_18, 100), "86921753037915269");
  assert.equal(depthAmountMinor(SENTINEL_18, 1000000), "869217530379152686751");
});

test("极大的最小单位下绝不产出科学计数法", () => {
  // 目标币单价 1000 美元、18 位小数：1e6 美元 → 1000 个币 → 1e21 个最小单位。
  // String(1e21) 与 (1e21).toFixed(0) 都是 "1e+21"，会被 API 当成非法 amount。
  const out = depthAmountMinor({ ok: true, amountOut: "1000000000000000000000", amountOutUsd: "1000000" }, 1000000);
  assert.equal(out, "1000000000000000000000");
  assert.match(out, /^\d+$/, "必须是纯十进制整数字符串");
});

test("档位之间只差一个四舍五入：偏差不超过半个最小单位（大档位侧被放大 10^4 倍）", () => {
  const small = BigInt(depthAmountMinor(SENTINEL_18, 100));
  const large = BigInt(depthAmountMinor(SENTINEL_18, 1000000));
  // 两个档位各自独立四舍五入，所以严格等号**不成立** —— 小档位那侧差半个单位会被放大 10^4 倍，
  // 加自身半个单位。这条断言记录了这个上界：将来若有人去掉四舍五入，它会失败。
  const diff = large - small * 10000n;
  assert.ok(diff <= 5001n && diff >= -5001n, `线性偏差 ${diff} 超出 ±5001`);
});

test("对无法可靠折算的输入返回 null（跳过这一对，不猜）", () => {
  assert.equal(depthAmountMinor(null, 100), null);
  assert.equal(depthAmountMinor(undefined, 100), null);
  assert.equal(depthAmountMinor({ ok: false, amountOut: "1", amountOutUsd: "1" }, 100), null, "失败行没有价格");
  assert.equal(depthAmountMinor({ ok: true, amountOutUsd: "1" }, 100), null, "缺 amountOut");
  assert.equal(depthAmountMinor({ ok: true, amountOut: "100" }, 100), null, "缺 amountOutUsd");
  assert.equal(depthAmountMinor(SENTINEL, 0), null, "档位非正");
  assert.equal(depthAmountMinor(SENTINEL, -100), null);
  assert.equal(depthAmountMinor(SENTINEL, 100.5), null, "档位必须是整数");
  assert.equal(depthAmountMinor({ ok: true, amountOut: "100", amountOutUsd: "0" }, 100), null, "美元为 0 会除零");
  assert.equal(depthAmountMinor({ ok: true, amountOut: "0", amountOutUsd: "100" }, 100), null, "算出 0 个币没意义");
  assert.equal(depthAmountMinor({ ok: true, amountOut: "abc", amountOutUsd: "100" }, 100), null);
  assert.equal(depthAmountMinor({ ok: true, amountOut: "100", amountOutUsd: "abc" }, 100), null);
  assert.equal(depthAmountMinor({ ok: true, amountOut: "-100", amountOutUsd: "100" }, 100), null, "负数最小单位");
  assert.equal(depthAmountMinor({ ok: true, amountOut: "100", amountOutUsd: "-1" }, 100), null, "负美元");
  assert.equal(depthAmountMinor({ ok: true, amountOut: "100", amountOutUsd: "1e3" }, 100), null, "不接受科学计数法输入");
});

test("amountOutUsd 带不同位数的小数都能正确放大", () => {
  // 100.41 → "10041" 放大 10^2；1.5 → "15" 放大 10^1
  assert.equal(depthAmountMinor({ ok: true, amountOut: "100000000", amountOutUsd: "100.41" }, 100), "99591674");
  assert.equal(depthAmountMinor({ ok: true, amountOut: "100000000", amountOutUsd: "1.5" }, 150), "10000000000");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— `Cannot find module '../src/depth.js'`

- [ ] **Step 3: 写 `src/depth.js`**

```js
// 深度扫描的档位折算。叶子模块：不 import 任何东西（与 amount.js / numeric.js 同级）。

/**
 * 名义美元档位 → 目标币最小单位整数字符串。
 *
 * amount 是目标币数量（EXACT_OUTPUT），目标币单价 = amountOutUsd / amountOut，于是
 * amountMinor = tierUsd × amountOut / amountOutUsd。
 *
 * 两条硬约束：
 *
 * 1. **不能拿两个最小单位相除来估美元。** 小数位不同时毫无意义（实测
 *    bsc:USDC(18位) → near:USDC(6位) 得到 100110509950192%）。这里用的是
 *    「美元 / 单价」，与小数位无关。
 * 2. **必须用 BigInt 精确整数运算，不能过浮点。** 18 位小数的目标币加上百万级档位，
 *    最小单位会超过 2^53（实测精确值 …269，浮点路径给 …264）；更糟的是超过 1e21 时
 *    String() 与 toFixed() 都会产出科学计数法（"1e+21"），而那会被 API 当成非法 amount。
 *    BigInt.toString() 永远是纯十进制。
 *
 * 任何不能可靠折算的情形都返回 null（调用方跳过这一对），绝不猜。
 */
export function depthAmountMinor(quote, tierUsd) {
  if (!quote || quote.ok !== true) return null;
  if (!Number.isInteger(tierUsd) || tierUsd <= 0) return null;
  if (quote.amountOut === null || quote.amountOut === undefined) return null;
  if (quote.amountOutUsd === null || quote.amountOutUsd === undefined) return null;

  const outMinorText = String(quote.amountOut).trim();
  if (!/^\d+$/.test(outMinorText)) return null;

  // amountOutUsd 是十进制字符串（如 "100.41"），放大成整数以消掉小数点
  const usdText = String(quote.amountOutUsd).trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(usdText);
  if (match === null) return null;
  const usdFraction = match[2] ?? "";
  const usdInteger = BigInt(match[1] + usdFraction);
  if (usdInteger <= 0n) return null;

  const numerator = BigInt(tierUsd) * BigInt(outMinorText) * 10n ** BigInt(usdFraction.length);
  // 四舍五入：加分母的一半再整除
  const minor = (numerator + usdInteger / 2n) / usdInteger;
  if (minor <= 0n) return null;
  return minor.toString();
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS —— 新增 6 个用例（`test/depth.test.js`），总数 **243**，输出干净（所有常数已用 Python 精确十进制独立对拍）

- [ ] **Step 5: 提交**

```bash
git add src/depth.js test/depth.test.js
git commit -m "feat: 档位折算，BigInt 精确整数运算避免科学计数法"
```

---

### Task 3: 面板纯函数 —— 档位的展示

**Files:**
- Modify: `public/dashboard.js`（在纯函数区追加，不动既有函数）
- Test: `test/dashboard-depth.test.js`（新文件）

**Interfaces:**
- Consumes: 无
- Produces:
  - `formatTier(tierUsd): string` —— `1000000` → `"1M"`、`2500000` → `"2.5M"`、`1500` → `"1.5k"`、`100` → `"100"`、坏输入 → `"—"`
  - `largestPassingTier(rows): number | null`
  - `buildDepthIndex(rows): Map<string, { maxTierUsd: number|null, byTier: Map<number, row> }>`

- [ ] **Step 1: 写失败测试 `test/dashboard-depth.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTier, largestPassingTier, buildDepthIndex } from "../public/dashboard.js";

test("formatTier 覆盖 1M / 2.5M / 100k / 1.5k / 100", () => {
  assert.equal(formatTier(1000000), "1M");
  assert.equal(formatTier(2500000), "2.5M");
  assert.equal(formatTier(100000), "100k");
  assert.equal(formatTier(10000), "10k");
  assert.equal(formatTier(1000), "1k");
  assert.equal(formatTier(1500), "1.5k");
  assert.equal(formatTier(100), "100");
});

test("formatTier 对坏输入给破折号而不是 NaN", () => {
  assert.equal(formatTier(null), "—");
  assert.equal(formatTier(undefined), "—");
  assert.equal(formatTier("abc"), "—");
  assert.equal(formatTier(0), "—");
  assert.equal(formatTier(-100), "—");
});

test("formatTier 不把 1M 显示成 1.0M", () => {
  assert.equal(formatTier(1000000), "1M");
  assert.ok(!formatTier(1000000).includes(".0"));
});

const depthRow = (tierUsd, ok, extra = {}) => ({
  pairId: "near:USDC>eth:USDC", tierUsd, ok, amountInUsd: "100.41", amountOutUsd: "100.00",
  errorCode: ok ? null : "http_4xx", errorMessage: ok ? null : "No liquidity available", ...extra,
});

test("largestPassingTier 挑出能通过的最大档位，与输入顺序无关", () => {
  assert.equal(largestPassingTier([depthRow(100, true), depthRow(1000, true), depthRow(10000, false)]), 1000);
  assert.equal(largestPassingTier([depthRow(10000, false), depthRow(100, true), depthRow(1000, true)]), 1000);
  assert.equal(largestPassingTier([depthRow(1000000, true), depthRow(100, true)]), 1000000);
});

test("largestPassingTier 在全不通或空输入时给 null", () => {
  assert.equal(largestPassingTier([depthRow(1000, false), depthRow(100, false)]), null);
  assert.equal(largestPassingTier([]), null);
  assert.equal(largestPassingTier([depthRow(100, true), null, { pairId: "x" }]), 100, "坏行要跳过而不是崩");
});

test("buildDepthIndex 按币对归并，并给出每对的详情", () => {
  const index = buildDepthIndex([
    depthRow(100, true), depthRow(1000, false),
    { ...depthRow(100, true), pairId: "near:USDC>sol:USDC" },
    { ...depthRow(10000, true), pairId: "near:USDC>sol:USDC" },
  ]);
  assert.equal(index.size, 2);
  const eth = index.get("near:USDC>eth:USDC");
  assert.equal(eth.maxTierUsd, 100);
  assert.equal(eth.byTier.get(1000).errorMessage, "No liquidity available");
  assert.equal(index.get("near:USDC>sol:USDC").maxTierUsd, 10000);
});

test("buildDepthIndex 对空输入与坏行不崩", () => {
  assert.equal(buildDepthIndex([]).size, 0);
  assert.equal(buildDepthIndex([null, { noPairId: 1 }]).size, 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— `does not provide an export named 'formatTier'`

- [ ] **Step 3: 在 `public/dashboard.js` 的纯函数区追加**

追加在 `buildRows` **之前**，与其它纯函数同区。不要改动既有函数：

```js
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS —— 新增 7 个用例，总数 **250**，输出干净（已预跑验证）

- [ ] **Step 5: 提交**

```bash
git add public/dashboard.js test/dashboard-depth.test.js
git commit -m "feat: 档位展示纯函数（格式化与按币对归并）"
```

---

### Task 4: 配置 —— `depth` 段与校验

**Files:**
- Modify: `src/config.js`（`DEFAULT_CONFIG` 加一段；`validate` 加几条规则）
- Modify: `test/config.test.js`（追加用例）

**Interfaces:**
- Produces: `DEFAULT_CONFIG.depth = { enabled: true, intervalSec: 900, tiers: [100, 1000, 10000, 100000, 1000000], concurrency: 3 }`

- [ ] **Step 1: 写失败测试（追加到 `test/config.test.js` 末尾）**

```js
test("depth 段的默认值", () => {
  const cfg = load(ONE_PAIR);
  assert.equal(cfg.depth.enabled, true);
  assert.equal(cfg.depth.intervalSec, 900);
  assert.deepEqual(cfg.depth.tiers, [100, 1000, 10000, 100000, 1000000]);
  assert.equal(cfg.depth.concurrency, 3);
});

test("depth 段可以深合并覆盖单个字段", () => {
  const cfg = load({ ...ONE_PAIR, depth: { tiers: [500, 5000] } });
  assert.deepEqual(cfg.depth.tiers, [500, 5000]);
  assert.equal(cfg.depth.intervalSec, 900, "兄弟字段保留默认值");
});

test("depth.tiers 必须是非空、严格递增的正整数数组", () => {
  const bad = (tiers) => () => load({ ...ONE_PAIR, depth: { tiers } });
  assert.throws(bad([]), (e) => e.issues.some((i) => i.includes("depth.tiers")));
  assert.throws(bad([1000, 100]), (e) => e.issues.some((i) => i.includes("递增")));
  assert.throws(bad([100, 100]), (e) => e.issues.some((i) => i.includes("递增")));
  assert.throws(bad([100, -5]), (e) => e.issues.some((i) => i.includes("正整数")));
  assert.throws(bad([100, 0]), (e) => e.issues.some((i) => i.includes("正整数")));
  assert.throws(bad([100, 1000.5]), (e) => e.issues.some((i) => i.includes("正整数")));
  assert.throws(bad([100, "1k"]), (e) => e.issues.some((i) => i.includes("正整数")));
});

test("depth.tiers 最多 10 项（防止把对方 API 打爆）", () => {
  const eleven = Array.from({ length: 11 }, (_, i) => (i + 1) * 100);
  assert.throws(() => load({ ...ONE_PAIR, depth: { tiers: eleven } }), (e) => e.issues.some((i) => i.includes("10")));
  const ten = Array.from({ length: 10 }, (_, i) => (i + 1) * 100);
  assert.equal(load({ ...ONE_PAIR, depth: { tiers: ten } }).depth.tiers.length, 10);
});

test("depth.intervalSec 不能比哨兵还快", () => {
  assert.throws(() => load({ ...ONE_PAIR, depth: { intervalSec: 30 } }), (e) => e.issues.some((i) => i.includes("intervalSec")));
  assert.equal(load({ ...ONE_PAIR, depth: { intervalSec: 60 } }).depth.intervalSec, 60);
});

test("depth.concurrency 与全局 concurrency 同规则", () => {
  assert.throws(() => load({ ...ONE_PAIR, depth: { concurrency: 0 } }), (e) => e.issues.some((i) => i.includes("depth.concurrency")));
  assert.throws(() => load({ ...ONE_PAIR, depth: { concurrency: 51 } }), (e) => e.issues.some((i) => i.includes("depth.concurrency")));
});

test("depth.enabled 关闭时不校验 tiers（可以留空）", () => {
  const cfg = load({ ...ONE_PAIR, depth: { enabled: false, tiers: [] } });
  assert.equal(cfg.depth.enabled, false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— `Cannot read properties of undefined (reading 'enabled')`

- [ ] **Step 3: 改 `src/config.js`**

(a) `DEFAULT_CONFIG` 里、`defaultAmounts` 之后加一段：

```js
  depth: {
    enabled: true,
    intervalSec: 900,
    tiers: [100, 1000, 10000, 100000, 1000000],
    concurrency: 3,
  },
```

(b) `validate` 里、`retention` 那几行之后加：

```js
  requireInt(issues, "depth.intervalSec", cfg.depth?.intervalSec, 60);
  requireInt(issues, "depth.concurrency", cfg.depth?.concurrency, 1, 50);
  if (typeof cfg.depth?.enabled !== "boolean") {
    issues.push(`depth.enabled 必须是布尔值，当前为 ${JSON.stringify(cfg.depth?.enabled)}`);
  }
  // 关闭时允许留空数组，否则必须是非空、严格递增的正整数数组且不超过 10 项
  if (cfg.depth?.enabled !== false) {
    const tiers = cfg.depth?.tiers;
    if (!Array.isArray(tiers) || tiers.length === 0) {
      issues.push("depth.tiers 必须是非空数组");
    } else {
      if (tiers.length > 10) {
        issues.push(`depth.tiers 最多 10 项（当前 ${tiers.length} 项）—— 每多一项都会成倍增加对方 API 的负载`);
      }
      tiers.forEach((tier, index) => {
        if (!Number.isInteger(tier) || tier <= 0) {
          issues.push(`depth.tiers[${index}] 必须是正整数，当前为 ${JSON.stringify(tier)}`);
          return;
        }
        if (index > 0 && Number.isInteger(tiers[index - 1]) && tier <= tiers[index - 1]) {
          issues.push(`depth.tiers 必须严格递增，但 tiers[${index}] (${tier}) 不大于 tiers[${index - 1}] (${tiers[index - 1]})`);
        }
      });
    }
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS —— 新增 7 个用例，总数 **257**，输出干净

- [ ] **Step 5: 提交**

```bash
git add src/config.js test/config.test.js
git commit -m "feat: depth 配置段与校验（档位数量上限、严格递增、不比哨兵快）"
```

---

### Task 5: 扫描任务、调度接线与日汇总快照

**Files:**
- Modify: `src/depth.js`（追加 `summariseDepth`）
- Modify: `src/index.js`（追加 `runDepthSweep`；`runMaintenance` 里挂调度与 `pruneDepth`；`maybeSendDigest` 里算深度快照）
- Modify: `src/notify.js`（`formatDigest` 追加**可选**的一段；`summary.depth` 缺席时行为完全不变）
- Modify: `test/index.test.js`、`test/notify.test.js`（追加用例）

**Interfaces:**
- Consumes: `depthAmountMinor`、`quoteAll`/`quotePair`、`mapLimit`、`hourFloorIso`、`Store` 的 depth 方法、`computeCostPct` 无关
- Produces:
  - `runDepthSweep(ctx): Promise<{ pairs: number, rows: number, skipped: string[] }>` —— 导出的，便于注入 `fetchImpl` 单测
  - `summariseDepth({ rows, pairCount, tiers }): { pairCount, byTier: [{ tierUsd, passing }], deadPairs }`
  - `formatDigest(summary, opts)` 支持 `summary.depth`

- [ ] **Step 1: 写失败测试**

(a) 追加到 `test/notify.test.js` 末尾：

```js
test("日汇总在有深度快照时多出一行", () => {
  const text = formatDigest({
    windowHours: 24, pairCount: 38, totalRounds: 100, okRounds: 95, okRate: 0.95,
    worst: [], latencyP95: 2000,
    depth: {
      pairCount: 38, byTier: [{ tierUsd: 1000000, passing: 12 }, { tierUsd: 100000, passing: 29 }],
      deadPairs: 3, sweptPairs: 33, unsweptPairs: 5,
    },
  });
  assert.ok(text.includes("深度"), "要有深度这一行");
  assert.ok(text.includes("1M"), "档位要用人读形式");
  assert.ok(text.includes("12/33"), "分母必须是实际扫到的 33 对，不是白名单的 38");
  assert.ok(text.includes("100k"));
  assert.ok(text.includes("29/33"));
  assert.ok(text.includes("3 对全档不通"));
  assert.ok(text.includes("5 对无可用价格未扫描"), "没被扫到的对必须说出来，否则会被误读成故障");
});

test("日汇总在没有深度数据时不加那一行（行为与加这个功能之前完全一致）", () => {
  const text = formatDigest({ windowHours: 24, pairCount: 38, totalRounds: 100, okRounds: 95, okRate: 0.95, worst: [], latencyP95: 2000 });
  assert.ok(!text.includes("深度"));
});
```

(b) 追加到 `test/index.test.js` 末尾：

```js
// 深度扫描用的 stub：目标币都是 6 位小数，1 个目标币 = 1 美元，于是档位折算很好核对
const priceOneUsdFetch = async (_url, init) => {
  const body = JSON.parse(init.body);
  const usd = (Number(body.amount) / 1e6).toFixed(6);
  return {
    ok: true, status: 201,
    text: async () => JSON.stringify({
      correlationId: "cid",
      quote: {
        amountIn: body.amount, amountInFormatted: "x", amountInUsd: usd,
        amountOut: body.amount, amountOutFormatted: "y", amountOutUsd: usd,
        minAmountIn: body.amount, minAmountOut: body.amount, timeEstimate: 10,
      },
    }),
  };
};

test("runDepthSweep 对每对每个档位各写一行，并按美元折算金额", async () => {
  const { ctx, store } = makeCtx({ fetchImpl: priceOneUsdFetch, now: T(0) });
  await runRound(ctx); // 先跑哨兵，才有价格可折算
  const result = await runDepthSweep({ ...ctx, now: T(1) });
  assert.equal(result.pairs, 2);
  assert.equal(result.rows, 10, "2 对 × 5 档");
  assert.deepEqual(result.skipped, []);

  const sweep = store.getLatestSweep();
  assert.equal(sweep.ts, T(1).toISOString());
  assert.deepEqual([...new Set(sweep.rows.map((r) => r.tierUsd))], [100, 1000, 10000, 100000, 1000000]);
  const hundred = sweep.rows.find((r) => r.pairId === PAIR_A.id && r.tierUsd === 100);
  assert.equal(hundred.amountMinor, "100000000", "100 美元 ÷ 1 美元/币 = 100 个币 = 1e8 最小单位");
  assert.equal(hundred.ok, true);
  store.close();
});

test("runDepthSweep 跳过一小时内有不出价格的那些币对", async () => {
  const { ctx, store } = makeCtx({ fetchImpl: failFetch, now: T(0) });
  await runRound(ctx); // 哨兵全失败 → 库里没有可用价格
  const result = await runDepthSweep({ ...ctx, now: T(1) });
  assert.deepEqual(result.skipped.sort(), [PAIR_A.id, PAIR_B.id].sort());
  assert.equal(result.rows, 0);
  assert.equal(store.getLatestSweep().ts, null, "没有任何行写入");
  store.close();
});

test("runDepthSweep 把失败档位也写进去（那是信号，不是噪声）", async () => {
  let call = 0;
  const flaky = async (url, init) => {
    call += 1;
    // 前 2 次（哨兵那 2 对）成功，之后的深度请求全失败
    if (call <= 2) return priceOneUsdFetch(url, init);
    return { ok: false, status: 400, text: async () => JSON.stringify({ message: "No liquidity available" }) };
  };
  const { ctx, store } = makeCtx({ fetchImpl: flaky, now: T(0) });
  await runRound(ctx);
  const result = await runDepthSweep({ ...ctx, now: T(1) });
  assert.equal(result.rows, 10);
  const sweep = store.getLatestSweep();
  assert.equal(sweep.rows.every((r) => r.ok === false), true);
  assert.equal(sweep.rows[0].errorCode, "http_4xx");
  assert.equal(sweep.rows[0].errorMessage, "No liquidity available");
  store.close();
});

test("runMaintenance 到点才扫描，并推进 meta.last_sweep_ts", async () => {
  const { ctx, store } = makeCtx({ fetchImpl: priceOneUsdFetch, now: T(0) });
  await runRound(ctx);
  // 第一次：没有 last_sweep_ts → 应该扫
  await runMaintenance({ ...ctx, now: T(1) });
  assert.equal(store.getLatestSweep().ts, T(1).toISOString());
  assert.equal(store.getMeta("last_sweep_ts"), T(1).toISOString());
  // 第二次：不到 intervalSec（900s）→ 不该再扫
  await runMaintenance({ ...ctx, now: new Date(T(1).getTime() + 60000) });
  assert.equal(store.getLatestSweep().ts, T(1).toISOString(), "没到点不应产生新扫描");
  // 第三次：过点 → 应该扫
  const later = new Date(T(1).getTime() + 901000);
  await runMaintenance({ ...ctx, now: later });
  assert.equal(store.getLatestSweep().ts, later.toISOString());
  store.close();
});

test("depth.enabled 为 false 时完全不扫描", async () => {
  const { ctx, store } = makeCtx({ fetchImpl: priceOneUsdFetch, now: T(0) });
  ctx.config = { ...CONFIG, depth: { ...CONFIG.depth, enabled: false } };
  await runRound(ctx);
  await runMaintenance({ ...ctx, now: T(1) });
  assert.equal(store.getLatestSweep().ts, null);
  assert.equal(store.getMeta("last_sweep_ts"), undefined);
  store.close();
});

test("summariseDepth 数出每档可通的对数与全档不通的对数", () => {
  const rows = [
    { pairId: "a", tierUsd: 100, ok: true }, { pairId: "a", tierUsd: 1000, ok: true }, { pairId: "a", tierUsd: 10000, ok: false },
    { pairId: "b", tierUsd: 100, ok: true }, { pairId: "b", tierUsd: 1000, ok: false }, { pairId: "b", tierUsd: 10000, ok: false },
    { pairId: "c", tierUsd: 100, ok: false }, { pairId: "c", tierUsd: 1000, ok: false }, { pairId: "c", tierUsd: 10000, ok: false },
  ];
  const summary = summariseDepth({ rows, pairCount: 4, tiers: [100, 1000, 10000] });
  assert.deepEqual(summary.byTier, [
    { tierUsd: 100, passing: 2 }, { tierUsd: 1000, passing: 1 }, { tierUsd: 10000, passing: 0 },
  ]);
  assert.equal(summary.deadPairs, 1, "只有 c 全档不通");
  assert.equal(summary.pairCount, 4, "pairCount 是白名单总数");
  // 分母必须用「实际扫到的对数」而不是白名单总数 —— 否则没被扫到的对会被误读成「做不了这一档」
  assert.equal(summary.sweptPairs, 3, "rows 里出现过的币对：a/b/c");
  assert.equal(summary.unsweptPairs, 1, "白名单 4 对里 d 没有被扫");
});

test("summariseDepth 对空输入不崩", () => {
  assert.deepEqual(summariseDepth({ rows: [], pairCount: 0, tiers: [] }), { pairCount: 0, byTier: [], deadPairs: 0, sweptPairs: 0, unsweptPairs: 0 });
  assert.deepEqual(summariseDepth({}), { pairCount: 0, byTier: [], deadPairs: 0, sweptPairs: 0, unsweptPairs: 0 });
});
```

(c) 在 `test/index.test.js` 的 import 行里加上 `runDepthSweep`，以及从 `../src/depth.js` 引入 `summariseDepth`：

```js
import { parseArgs, createWakeup, createLogger, loadPairs, runRound, runMaintenance, main, runDepthSweep } from "../src/index.js";
import { summariseDepth } from "../src/depth.js";
```

(d) 在 `test/index.test.js` 的 `CONFIG` 常量里加 `depth` 段（既有用例不读它，加键是安全的）：

```js
  depth: { enabled: true, intervalSec: 900, tiers: [100, 1000, 10000, 100000, 1000000], concurrency: 3 },
```

(g) **修既有的 `maintenanceCtx` 夹具**（否则两个既有用例会报 `TypeError: pairs is not iterable`）：在它的返回对象里加 `pairs: []`，并在它的 config 里加 `depth: { ...CONFIG.depth, enabled: false }`。

理由：那两个既有用例考的是聚合 / 保留 / 日汇总，不该被深度扫描的副作用干扰；而 `runMaintenance` 现在会读 `config.depth.enabled`，夹具必须提供它。

```js
const maintenanceCtx = (store, { now, digest, notifier }) => ({
  store,
  pairs: [],
  notifier: notifier ?? { send: async () => ({ ok: true }) },
  logger: QUIET,
  now,
  config: {
    ...CONFIG,
    depth: { ...CONFIG.depth, enabled: false },
    slack: { enabled: true, mention: "", digest },
    retention: { rawDays: 14, hourlyDays: 0 },
  },
});
```

(e) 在 `test/notify.test.js` 里 `formatDigest` 已在 Task 10 引入，不需改 import。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— `runDepthSweep is not a function`

- [ ] **Step 3: 实现**

(a) `src/depth.js` 末尾追加：

```js
/**
 * 把最近一次扫描归成日汇总要用的形状。纯函数。
 * 只有 ok === true 的行才算「可通」；一个币对只要有一档能通就不算 dead。
 */
export function summariseDepth({ rows = [], pairCount = 0, tiers = [] } = {}) {
  const byTier = tiers.map((tierUsd) => ({ tierUsd, passing: 0 }));
  const counter = new Map(tiers.map((tierUsd, i) => [tierUsd, byTier[i]]));
  const seenPairs = new Set();
  const passingPairs = new Set();
  for (const row of rows) {
    if (!row || typeof row.pairId !== "string") continue;
    seenPairs.add(row.pairId);
    if (row.ok !== true) continue;
    passingPairs.add(row.pairId);
    const entry = counter.get(row.tierUsd);
    if (entry) entry.passing += 1;
  }
  const sweptPairs = seenPairs.size;
  return {
    pairCount,
    byTier,
    deadPairs: [...seenPairs].filter((id) => !passingPairs.has(id)).length,
    sweptPairs,
    unsweptPairs: Math.max(0, pairCount - sweptPairs),
  };
}
```

(b) `src/index.js`：把 `mapLimit` 与 `depth.js` 的两个函数加进 import（**`mapLimit` 原来没引，漏了会直接 ReferenceError**）：

```js
import { fetchJson, mapLimit } from "./http.js";
import { quoteAll, quotePair } from "./quote.js";
import { depthAmountMinor, summariseDepth } from "./depth.js";
```

（即：原有的 `import { fetchJson } from "./http.js";` 改成带 `mapLimit`；原有的 `import { quoteAll } from "./quote.js";` 改成带 `quotePair`；新增 depth 那行。）

(c) `src/index.js` 里追加 `runDepthSweep`（放在 `runMaintenance` 之前）：

```js
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
```

注：`quotePair` 返回的行里已经带了 `ts`/`pairId`/`ok`/`httpStatus`/`latencyMs`/金额字段/`errorCode`，`pairId` 会被后面的展开覆盖成同一个值，无害。

(d) `src/index.js` 的 import 行见 (b)，不再单独一步。

(e) `src/index.js` 的 `runMaintenance` 里，在保留策略那一段之后、`maybeSendDigest` 之前插入：

```js
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
```

(f) `src/index.js` 的保留策略块里、`pruneHourly` 之后加：

```js
    const prunedDepth = store.pruneDepth(cutoff);
    if (prunedDepth > 0) logger.info(`清理 ${prunedDepth} 条超过 ${config.retention.rawDays} 天的深度数据`);
```

（`cutoff` 就是同一个 `now − rawDays`，复用上面已算好的变量。）

(g) `src/index.js` 的 `maybeSendDigest` 里，把深度快照塞进 summary。找到 `const text = formatDigest({` 那一段，在它的参数对象里加一项：

```js
    depth: config.depth.enabled && sweep.ts !== null
      ? summariseDepth({ rows: sweep.rows, pairCount: pairs.length, tiers: config.depth.tiers })
      : null,
```

并在该函数开头取出 scanner 数据与 `pairs`：

```js
  const sweep = store.getLatestSweep();
```

（`maybeSendDigest(ctx, nowIso)` 现在需要 `pairs`，把调用处改成 `maybeSendDigest(ctx, nowIso)` 不变，函数内部从 `ctx.pairs` 取即可：`const { config, store, notifier, pairs } = ctx;`。）

(h) `src/notify.js` 的 `formatDigest` 里，在延迟那一行之后追加（`summary.depth` 缺席时**不加任何行**，既有行为不变）：

```js
  if (summary.depth && summary.depth.byTier.length > 0) {
    // 分母用「实际扫到的对数」：没被扫到的对（一小时内没有成功报价，无法折算金额）不是
    // 「做不了这一档」，把它们算进分母会让这一行谎报。
    const profile = summary.depth.byTier
      .map((entry) => `${formatTierLabel(entry.tierUsd)} ${entry.passing}/${summary.depth.sweptPairs}`)
      .join(" · ");
    const notes = [];
    if (summary.depth.deadPairs > 0) notes.push(`${summary.depth.deadPairs} 对全档不通`);
    if (summary.depth.unsweptPairs > 0) notes.push(`${summary.depth.unsweptPairs} 对无可用价格未扫描`);
    lines.push(`深度（最近一次扫描，可通对数/已扫描对数）：${profile}`
      + (notes.length > 0 ? `（${notes.join("；")}）` : ""));
  }
```

`src/notify.js` 里再加一个本地小函数（不 export，页面那边有自己的 `formatTier`，两边都不该互相 import）：

```js
function formatTierLabel(tierUsd) {
  const value = Number(tierUsd);
  if (!Number.isFinite(value) || value <= 0) return "?";
  if (value >= 1e6) return `${String(Number((value / 1e6).toFixed(2)))}M`;
  if (value >= 1e3) return `${String(Number((value / 1e3).toFixed(2)))}k`;
  return String(value);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS —— 新增 9 个用例，总数 **266**，输出干净

- [ ] **Step 5: 提交**

```bash
git add src/depth.js src/index.js src/notify.js test/index.test.js test/notify.test.js
git commit -m "feat: 深度扫描任务、调度接线与日汇总快照"
```

---

### Task 6: `GET /depth` 端点

**Files:**
- Modify: `src/server.js`（`handle` 里加一个 case）
- Modify: `test/server.test.js`（追加用例）

**Interfaces:**
- Consumes: `store.getLatestSweep()`、`config.depth.enabled`、`config.depth.tiers`
- Produces: `GET /depth?pair=` → `{ enabled, ts, tiers, rows }`

- [ ] **Step 1: 写失败测试（追加到 `test/server.test.js` 末尾）**

```js
test("GET /depth 返回最近一次扫描的全部行与档位表", async () => {
  const ctx = await withServer({ depth: { enabled: true, tiers: [100, 1000, 10000] } }, (store) => {
    store.insertDepthQuotes([
      { ts: "2026-09-15T00:00:00.000Z", pairId: PAIR.id, tierUsd: 100, ok: true, httpStatus: 201, latencyMs: 1300, amountInUsd: "100.41", amountOutUsd: "100.00" },
      { ts: "2026-09-15T00:00:00.000Z", pairId: PAIR.id, tierUsd: 1000, ok: false, httpStatus: 400, errorCode: "http_4xx", errorMessage: "No liquidity available" },
    ]);
  });
  const body = await (await ctx.get("/depth")).json();
  assert.equal(body.enabled, true);
  assert.equal(body.ts, "2026-09-15T00:00:00.000Z");
  assert.deepEqual(body.tiers, [100, 1000, 10000]);
  assert.equal(body.rows.length, 2);
  assert.equal(body.rows[0].tierUsd, 100);
  assert.equal(body.rows[1].errorMessage, "No liquidity available");
  await ctx.close();
});

test("GET /depth 在没有扫描数据时返回 ts: null 而不是 404（没扫过是正常状态）", async () => {
  const ctx = await withServer({ depth: { enabled: true, tiers: [100] } });
  const res = await ctx.get("/depth");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ts, null);
  assert.deepEqual(body.rows, []);
  assert.equal(body.enabled, true);
  await ctx.close();
});

test("GET /depth 反映 depth.enabled，让页面能区分「关了」与「还没扫过」", async () => {
  const ctx = await withServer({ depth: { enabled: false, tiers: [100] } });
  const body = await (await ctx.get("/depth")).json();
  assert.equal(body.enabled, false);
  assert.equal(body.ts, null);
  await ctx.close();
});

test("GET /depth?pair= 过滤到单个币对", async () => {
  const ctx = await withServer({ depth: { enabled: true, tiers: [100] } }, (store) => {
    store.insertDepthQuotes([
      { ts: "2026-09-15T00:00:00.000Z", pairId: PAIR.id, tierUsd: 100, ok: true },
      { ts: "2026-09-15T00:00:00.000Z", pairId: "near:USDC>sol:USDC", tierUsd: 100, ok: false, errorCode: "http_4xx" },
    ]);
  });
  const body = await (await ctx.get(`/depth?pair=${encodeURIComponent(PAIR.id)}`)).json();
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].pairId, PAIR.id);
  await ctx.close();
});

test("GET /depth 也要令牌（与其它数据端点一致）", async () => {
  const ctx = await withServer({ bearerToken: "s3cret", depth: { enabled: true, tiers: [100] } });
  assert.equal((await ctx.get("/depth")).status, 401);
  await ctx.close();
});
```

并在 `withServer` 的签名与 config 构造里加上 `depth`：

```js
async function withServer({ bearerToken = "", health, cors = "*", depth = { enabled: false, tiers: [] } } = {}, seed = () => {}) {
  ...
  const config = { intervalSec: 60, depth, server: { host: "127.0.0.1", port: 0, cors, bearerToken } };
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— `GET /depth` 返回 404

- [ ] **Step 3: 改 `src/server.js`**

在 `handle` 的 `switch` 里、`case "/alerts":` 之前插入：

```js
    case "/depth": {
      const sweep = store.getLatestSweep();
      const pairId = query.get("pair");
      send(200, {
        enabled: config.depth.enabled,
        ts: sweep.ts,
        tiers: config.depth.tiers,
        rows: pairId ? sweep.rows.filter((row) => row.pairId === pairId) : sweep.rows,
      });
      return;
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS —— 新增 5 个用例，总数 **271**，输出干净

- [ ] **Step 5: 提交**

```bash
git add src/server.js test/server.test.js
git commit -m "feat: GET /depth 端点"
```

---

### Task 7: 面板 —— 「可按」列与展开的档位曲线

**Files:**
- Modify: `public/dashboard.js`（纯函数区加 `depthCell`/`depthCurveFor`，`buildRows` 接受 `depth`；`init()` 取数与渲染）
- Modify: `public/index.html`（第 10 列表头、隐藏列的样式、曲线的样式）
- Modify: `test/dashboard-depth.test.js`、`test/dashboard-dom.test.js`（追加用例）

**Interfaces:**
- Consumes: Task 3 的 `formatTier`/`largestPassingTier`/`buildDepthIndex`、`computeCostPct`/`formatCostPct`
- Produces:
  - `depthCell({ pairId, depth, index }): { text, title }`
  - `depthCurveFor({ pairId, depth, index }): { tierText, ok, costText, note }[]`
  - `buildRows({ pairs, latest, stats, depth, nowIso })` —— `depth` 缺席时行为**完全不变**（`depthText: "?"`），所以既有用例仍通过

- [ ] **Step 1: 写失败测试**

(a) 追加到 `test/dashboard-depth.test.js`。**注意**：下面那段的**第一行 import 要合并进文件顶部已有的 import**，不要另起一行 —— 另起会重复声明 `depthCell`/`depthCurveFor`，整份测试文件会在加载期报 `Identifier ... has already been declared`。顶部的 import 改成：

```js
import { formatTier, largestPassingTier, buildDepthIndex, buildRows, depthCell, depthCurveFor } from "../public/dashboard.js";
```

然后追加下面这一段（**从第二个 import 行之后开始，即 `const sweepDepth = ...` 起**）：

```js
import { depthCell, depthCurveFor } from "../public/dashboard.js";

const sweepDepth = (rows, overrides = {}) => ({
  enabled: true, ts: "2026-09-15T00:30:00.000Z", tiers: [100, 1000, 10000], rows, ...overrides,
});

test("depthCell：有数据时给最大可通档位", () => {
  const rows = [depthRow(100, true), depthRow(1000, true), depthRow(10000, false)];
  const depth = sweepDepth(rows);
  const index = buildDepthIndex(rows);
  const cell = depthCell({ pairId: "near:USDC>eth:USDC", depth, index });
  assert.equal(cell.text, "1k");
  assert.ok(cell.title.includes("最大可通档位"));
});

test("depthCell：全档不通给破折号，没扫过给问号，关闭给破折号", () => {
  const dead = [depthRow(100, false), depthRow(1000, false)];
  const deadDepth = sweepDepth(dead);
  assert.equal(depthCell({ pairId: "near:USDC>eth:USDC", depth: deadDepth, index: buildDepthIndex(dead) }).text, "—");

  const notYet = sweepDepth([], { ts: null });
  const cell = depthCell({ pairId: "near:USDC>eth:USDC", depth: notYet, index: new Map() });
  assert.equal(cell.text, "?");
  assert.ok(cell.title.includes("还没有扫描过"));

  const off = sweepDepth([], { enabled: false });
  const offCell = depthCell({ pairId: "near:USDC>eth:USDC", depth: off, index: new Map() });
  assert.equal(offCell.text, "—");
  assert.ok(offCell.title.includes("关闭"));
});

test("depthCell：接口没取到时（depth 为 null）给问号，不崩", () => {
  assert.equal(depthCell({ pairId: "x", depth: null, index: new Map() }).text, "?");
  assert.equal(depthCell({ pairId: "x", depth: undefined, index: undefined }).text, "?");
});

test("depthCell：该对没有深度数据时给破折号（不能在白名单外瞎显示）", () => {
  const rows = [depthRow(100, true, { pairId: "other:PAIR" })];
  const depth = sweepDepth(rows);
  const cell = depthCell({ pairId: "near:USDC>eth:USDC", depth, index: buildDepthIndex(rows) });
  assert.equal(cell.text, "—");
});

test("depthCurveFor 按档位升序给出曲线，含成本与对方原文", () => {
  const rows = [
    depthRow(1000, false, { amountInUsd: null, amountOutUsd: null }),
    depthRow(100, true, { amountInUsd: "100.41", amountOutUsd: "100.00" }),
  ];
  const depth = sweepDepth(rows);
  const curve = depthCurveFor({ pairId: "near:USDC>eth:USDC", depth, index: buildDepthIndex(rows) });
  assert.deepEqual(curve.map((point) => point.tierText), ["100", "1k"], "必须按档位升序，不是输入顺序");
  assert.equal(curve[0].ok, true);
  assert.equal(curve[0].costText, "0.41%");
  assert.equal(curve[1].ok, false);
  assert.equal(curve[1].costText, "—", "不通的档位没有成本可言");
  assert.equal(curve[1].note, "No liquidity available");
});

test("depthCurveFor 在没有数据时给空数组", () => {
  assert.deepEqual(depthCurveFor({ pairId: "x", depth: null, index: new Map() }), []);
  assert.deepEqual(depthCurveFor({ pairId: "x", depth: sweepDepth([], { ts: null }), index: new Map() }), []);
});

test("buildRows 带上 depth 时给出可按列与曲线", () => {
  const rows = [depthRow(100, true), depthRow(1000, false)];
  const built = buildRows({
    pairs: [PAIR_A], latest: [quote(PAIR_A.id)], stats: [], depth: sweepDepth(rows), nowIso: NOW,
  });
  assert.equal(built[0].depthText, "100");
  assert.equal(built[0].depthCurve.length, 2);
});

test("buildRows 不带 depth 时行为与加这个功能之前一致（既有用例不受影响）", () => {
  const built = buildRows({ pairs: [PAIR_A], latest: [quote(PAIR_A.id)], stats: [], nowIso: NOW });
  assert.equal(built[0].depthText, "?");
  assert.deepEqual(built[0].depthCurve, []);
});
```

注：`test/dashboard-depth.test.js` 需要从 `../public/dashboard.js` 再引入 `buildRows`，并从 `test/dashboard.test.js` 借用的 `PAIR_A`/`quote`/`NOW` 夹具需要在本文件内重新定义（测试文件之间不共享夹具）：

```js
const PAIR_A = {
  id: "near:USDC>eth:USDC", label: "near:USDC → eth:USDC", fromKey: "near:USDC", toKey: "eth:USDC",
  fromDecimals: 6, toDecimals: 6, swapType: "EXACT_OUTPUT", amount: "1500",
};
const quote = (pairId, overrides = {}) => ({
  pairId, ts: "2026-09-15T06:00:00.000Z", ok: true, httpStatus: 201, latencyMs: 2290,
  amountIn: "1501955004", amountOut: "1500000000", amountInUsd: "1501.73", amountOutUsd: "1499.78",
  minAmountIn: "1500453048", minAmountOut: "1500000000", timeEstimate: 27, correlationId: "cid",
  errorCode: null, errorMessage: null, stateStatus: "ok", stateSince: "2026-09-15T06:00:00.000Z", stateFailures: 0,
  ...overrides,
});
const NOW = "2026-09-15T06:00:30.000Z";
```

(b) 更新 `test/dashboard-dom.test.js` 的表头断言为 10 列：

```js
  for (const header of ["币对", "状态", "付 → 得", "成本", "可按", "USD", "较基准", "延迟", "最后报价", "备注"]) {
```

并追加：

```js
test("「可按」表头带上解释与隐藏列的样式钩子", () => {
  assert.ok(html.includes('class="depth-col"'), "表头要能被整列隐藏");
  assert.ok(html.includes("名义美元"), "「可按」必须说明单位是名义美元");
  assert.ok(html.includes("no-depth"), "要有关闭深度扫描时隐藏整列的样式");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— `does not provide an export named 'depthCell'`

- [ ] **Step 3: 在 `public/dashboard.js` 的纯函数区追加（`buildRows` 之前）**

```js
/** 「可按」单元格：这一对能通过的最大档位。 */
export function depthCell({ pairId, depth, index }) {
  // 「没取到」与「已关闭」必须分开：前者是 ?（还没扫过/本次拉取失败），后者才是 —
  if (!depth) return { text: "?", title: "还没有取到深度数据" };
  if (depth.enabled !== true) return { text: "—", title: "深度扫描已在 config.json 里关闭" };
  if (depth.ts === null || depth.ts === undefined) {
    return { text: "?", title: "还没有扫描过（最长等一个扫描间隔）" };
  }
  const entry = index?.get(pairId);
  if (!entry || entry.maxTierUsd === null) {
    return { text: "—", title: "所有档位都没有报价" };
  }
  return { text: formatTier(entry.maxTierUsd), title: "最大可通档位（名义美元）；点开这一行看完整曲线" };
}

/** 展开行里的档位曲线，按档位升序。 */
export function depthCurveFor({ pairId, depth, index }) {
  if (!depth || depth.enabled !== true || depth.ts === null || depth.ts === undefined) return [];
  const entry = index?.get(pairId);
  if (!entry) return [];
  return [...entry.byTier.values()]
    .sort((left, right) => left.tierUsd - right.tierUsd)
    .map((row) => ({
      tierText: formatTier(row.tierUsd),
      ok: row.ok === true,
      costText: row.ok === true ? formatCostPct(computeCostPct(row.amountInUsd, row.amountOutUsd)) : "—",
      note: row.ok === true ? "" : String(row.errorMessage ?? row.errorCode ?? "未知错误"),
    }));
}
```

并把 `buildRows` 改为接受 `depth`：

```js
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
```

`buildRow` 的签名与返回也要改两处：

```js
function buildRow({ pair, quote, stat, depth, depthIndex, nowIso }) {
```

并在返回对象里加两项（放在 `costText` 之后）：

```js
    depthText: depthCell({ pairId, depth: depth ?? null, index: depthIndex }).text,
    depthTitle: depthCell({ pairId, depth: depth ?? null, index: depthIndex }).title,
    depthCurve: depthCurveFor({ pairId, depth: depth ?? null, index: depthIndex }),
```

（`pairId` 在上面已经算好；`depthCell` 调两次是为了可读性，代价可以忽略 —— 它是纯函数且只做几次 Map 查找。若在意，可以先存成局部变量再取 `.text`/`.title`。）

- [ ] **Step 4: 改 `public/index.html`**

(a) 表头：在「成本」之后插入：

```html
          <th class="depth-col" title="这一对能通过的最大档位（名义美元）；点开行看完整曲线">可按</th>
```

(b) CSS 追加（放在 `@media` 之前）：

```css
    .no-depth .depth-col { display: none; }
    tr.detail ol.depth-curve { margin: 6px 0 0; padding-left: 20px; }
    tr.detail ol.depth-curve li { margin: 2px 0; }
    tr.detail ol.depth-curve li.ok { color: var(--ok); }
    tr.detail ol.depth-curve li.bad { color: var(--err); }
```

- [ ] **Step 5: 改 `public/dashboard.js` 的 `init()`**

(a) 取数：`load()` 里从 3 个请求变 4 个，且 `/depth` **失败不影响主表**（失败时按「没取到」处理）：

```js
      const [latest, stats, health, depth] = await Promise.all([
        apiGet("/latest"),
        apiGet("/stats?window=1h"),
        apiGet("/health", { allowStatus: [503] }),
        // /depth 拿不到不该让整页失败 —— 只是「可按」列显示问号
        apiGet("/depth").catch(() => null),
      ]);
      state.health = health;
      state.depth = depth;
```

`state` 里加 `depth: null`。

(b) 隐藏整列（在 `renderRows()` 里，或 `load()` 成功后）：

```js
      // 扫描关闭时整列隐藏 —— 否则会与「全档不通」的破折号长得一样，而手机上悬停不了
      document.getElementById("table").classList.toggle("no-depth", state.depth?.enabled === false);
```

(c) `buildRows` 调用加 `depth: state.depth`：

```js
      state.rows = buildRows({
        pairs: state.pairs, latest: latest.latest ?? [], stats: stats.pairs ?? [],
        depth: state.depth, nowIso: new Date().toISOString(),
      });
```

(d) 行单元格：`cells` 里在 `cost` 之后插 `depth`，并加进 `tr.append`：

```js
      depth: cell(row.depthText, "depth depth-col"),
```

```js
    tr.append(cells.pair, cells.status, cells.amount, cells.cost, cells.depth, cells.usd, cells.deviation, cells.latency, cells.time, cells.note);
```

并在 tooltip 设置那里加：

```js
    if (row.depthTitle) cells.depth.title = row.depthTitle;
```

(e) 展开详情里追加曲线（在现有 `items` 循环之后）：

```js
      if (row.depthCurve.length > 0) {
        const list = document.createElement("ol");
        list.className = "depth-curve";
        for (const point of row.depthCurve) {
          const li = document.createElement("li");
          li.className = point.ok ? "ok" : "bad";
          // 一律 textContent：errorMessage 是对方返回的任意字符串
          li.textContent = point.ok
            ? `${point.tierText} 可通 · 成本 ${point.costText}`
            : `${point.tierText} 不通 · ${point.note}`;
          list.append(li);
        }
        td.append(list);
      }
```

(f) 详情行的 `colSpan` 从 9 改成 10。

- [ ] **Step 6: 跑测试确认通过**

Run: `npm test`
Expected: PASS —— 新增 9 个用例，总数 **280**，输出干净

- [ ] **Step 7: 提交**

```bash
git add public/dashboard.js public/index.html test/dashboard-depth.test.js test/dashboard-dom.test.js
git commit -m "feat: 面板「可按」列与展开的档位曲线"
```

---

### Task 8: README 与端到端验收

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: 前面七个 Task 的全部产物
- Produces: 给运维的「深度扫描」一节与冒烟步骤

- [ ] **Step 1: 在 `README.md` 的「面板」一节之后加「深度扫描」一节**

必须覆盖：

- 它回答什么：**这条路由最深能吃到多大、大额贵多少**（哨兵只回答「通不通」）
- 频率与负载：每 15 分钟一次，38 对 × 5 档 = 190 次请求；单次阻塞 1–2 分钟，所以**每 15 轮里有 1 轮哨兵会被推迟**（日志会打出「立即开始下一轮」）
- 档位是**名义美元**（100 / 1k / 10k / 100k / 1M），按哨兵最近一次成功报价的单价折算成目标币数量；一小时内没有成功报价的币对整对跳过
- **成本曲线是 L 形带尾巴**，附实测数据：小额被固定手续费吃掉（eth 上 100 美元要 0.41%，1 万美元只要 0.11%），中段最便宜，大额开始变贵，再大**直接没有报价**。所以「大额更吃亏」只是后半段
- 断点逐路由差异极大（`bera` 在 10k~100k 之间断，`eth` 到 100k 但 1M 断），固定档位只能粗测，价值在于**跟踪断点随时间往哪边移动**
- **大额不通不报警**（那是稳定的路由特征，接了会天天响）；只在日汇总里有一行当前深度快照
- 深度数据**沿用 14 天保留**，不做长期聚合 —— 14 天前的深度历史会消失（刻意的）
- `config.json` 里的 `depth` 段怎么改：`enabled` / `intervalSec` / `tiers` / `concurrency`，以及 `tiers` 最多 10 项的限制与原因
- 关闭时面板隐藏「可按」整列

- [ ] **Step 2: 在面板冒烟清单里加两条**

```markdown
8. 「可按」列应显示每对能通过的最大档位（如 `1M` / `10k` / `—`）；展开某一行应看到 5 档曲线，
   不通的档位后面跟着对方原文（如 `No liquidity available`）
9. 把 `config.json` 的 `depth.enabled` 改成 `false` 并重启，面板的「可按」整列应消失（不是变成一列破折号）
```

- [ ] **Step 3: 端到端实测**

```bash
npm run once -- --no-notify     # --once 时如果到点也会扫一次
node --disable-warning=ExperimentalWarning -e '...'   # 或起服务后 curl /depth
```

核对要点：

- `/depth` 返回 190 行（38 对 × 5 档），`tiers` 是那 5 个值
- 抽查已知的断点与实测一致：`near:USDC>bera:USDT` 的 10k 档应可通、100k 档应不通；`→ xlayer:USDC` 应全档不通
- `near:USDC>eth:USDC` 的 100 档成本应明显高于 10k 档（约 0.41% vs 0.11%）
- 起了服务的情况下浏览器打开面板，核对「可按」列与展开曲线

- [ ] **Step 4: 跑全量测试**

Run: `npm test`
Expected: PASS —— **280** 个用例全过，输出干净

- [ ] **Step 5: 提交**

```bash
git add README.md
git commit -m "docs: README 补深度扫描一节与冒烟步骤"
```

---

## 完成后的状态

- 每 15 分钟自动跑一次 5 档深度扫描，结果落在独立的 `depth_quotes` 表里，哨兵链路一行未改
- `GET /depth` 暴露最近一次扫描；面板主表多一列「可按」，展开可看 5 档成本曲线与对方原文
- 日汇总多一行当前深度快照（`1M 档 12/38 可通 · …`）
- 既有 230 个测试逐字通过，新增 50 个；零新增依赖
