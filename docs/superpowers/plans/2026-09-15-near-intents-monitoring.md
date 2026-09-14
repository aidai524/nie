# NEAR Intents 多链报价监控 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个零依赖的常驻 Node 服务，按 1 分钟一轮对 38 条币对白名单批量 dry-run 询价，把结果存进 SQLite，按规则判定异常并推 Slack，同时暴露只读 HTTP API 供人工查看与将来的前端面板消费。

**Architecture:** 单体 Node 进程 = 采集循环 + HTTP API + SQLite + Slack 通知器。模块按职责切分（config / amount / numeric / assets / http / store / detect / quote / notify / server），只有 `index.js` 知道全局流程；判定逻辑是纯函数且只读库里的历史，所以改阈值立刻生效、无需重采。

**Tech Stack:** Node.js 24、ESM、**零运行时依赖**（`node:sqlite`、`node:http`、内置 `fetch`、`node:test`、`node:fs`、`node:url`）。

**Spec:** `docs/superpowers/specs/2026-09-15-near-intents-monitoring-design.md`

## Global Constraints

- **Node.js >= 24**，`package.json` 必须含 `"type": "module"`。
- **零运行时依赖**：`package.json` 里不得出现 `dependencies` 或 `devDependencies` 任何条目。
- 只用这些内置模块：`node:sqlite`、`node:http`、`node:test`、`node:assert/strict`、`node:fs`、`node:url`，以及全局 `fetch` / `AbortController` / `setTimeout`。
- `node:sqlite` 是实验特性，会打印 `ExperimentalWarning`。**所有 node 命令都必须带 `--disable-warning=ExperimentalWarning`**，通过 npm script 统一提供。
- 测试命令固定为 `npm test`，其定义是 `node --disable-warning=ExperimentalWarning --test "test/**/*.test.js"`。已验证：`node --test` **不接受裸目录参数**（`node --test test/` 会报 `MODULE_NOT_FOUND`），必须用 glob。
- **所有时间戳都是 ISO8601 UTC 字符串**（`new Date().toISOString()`），落库与 API 输出一致，避免时区歧义。
- **配置里不出现 `assetId`**。白名单一律用 `network:SYMBOL`（如 `near:USDC`）表达，assetId 由 `src/assets.js` 解析。
- **金额全程用字符串传递**，任何换算都不得经过浮点数参与。`amountIn` / `amountOut` 等字段以 TEXT 存库。
- **面向人的文本用中文**（日志、Slack 消息、配置错误、断言消息）；**面向机器的标识符用英文**（字段名、枚举值、错误码、函数名）。
- 面向用户的输出里不要出现 emoji，Slack 消息除外（用 `:red_circle:` 这类 Slack emoji shortcode，不用字面 emoji）。
- 每个 Task 结束必须提交一次，commit message 用 `feat:` / `test:` / `docs:` / `chore:` 前缀。
- **绝不调用真实交易接口**：请求体永远带 `dry: true`，不创建 deposit address，不发起任何转账。

## File Structure

```
nearintents_monitoring/
  package.json                 # type: module，scripts: start / once / test
  config.example.json          # 进版本库的完整示例（含 38 对白名单与地址表）
  config.json                  # 真实配置，已在 .gitignore
  src/
    config.js     # 读取、深合并默认值、校验；ConfigError
    amount.js     # 人类可读金额 ↔ 最小单位换算，EXACT_OUTPUT/EXACT_INPUT 的侧别判定
    numeric.js    # median / percentile 纯数值工具
    assets.js     # token 列表归一化、assetId 解析、白名单 → 已解析币对
    http.js       # fetchJson（超时 + 错误归类）、mapLimit（有界并发）
    store.js      # node:sqlite：建表、写入、查询、小时聚合、保留策略
    detect.js     # 异常判定状态机（纯函数）
    quote.js      # 请求体构造、响应解析、并发询价
    notify.js     # Slack：抑制策略、消息格式化、发送
    server.js     # 只读 HTTP API + CORS + 可选 Bearer
    index.js      # 入口：装配、采集循环、维护任务、信号处理
  test/           # 与 src/ 一一对应的 *.test.js
  deploy/
    nearintents-monitor.service
    Dockerfile
  data/monitor.db
```

相对于 spec §4 的模块清单，本计划**增加了三个小模块**，各自单一职责且都可离线单测：

- `amount.js` —— spec 的 §12 要求「金额换算」有独立单测，但模块清单里没给它归属，塞进 `assets.js` 会让该文件同时负责「token 解析」和「金额数学」两件事。
- `numeric.js` —— `median`（detect 的基准）与 `percentile`（store 的 /stats）都需要，放在任何一方都会制造一条别扭的依赖方向。
- `http.js` —— spec §4 要求 `assets.js` 不发请求，那拉 token 列表的代码就无处安放；`fetchJson` + `mapLimit` 同时被取 token 和询价两处复用，抽出来正好。

---

### Task 1: 项目骨架与配置模块

**Files:**
- Create: `package.json`
- Create: `src/config.js`
- Test: `test/config.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `class ConfigError extends Error`，带 `.issues: string[]`
  - `DEFAULT_CONFIG: object`
  - `DEFAULT_ADDRESSES: Record<string, string>`
  - `mergeDeep(base: object, override: object): object`
  - `validate(cfg: object): string[]`
  - `loadConfig(opts?: { file?: string, env?: object, readFile?: Function }): object`

- [ ] **Step 1: 建 `package.json`**

```json
{
  "name": "nearintents-monitoring",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24.0.0" },
  "scripts": {
    "start": "node --disable-warning=ExperimentalWarning src/index.js",
    "once": "node --disable-warning=ExperimentalWarning src/index.js --once",
    "test": "node --disable-warning=ExperimentalWarning --test \"test/**/*.test.js\""
  }
}
```

- [ ] **Step 2: 写失败测试 `test/config.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, mergeDeep, ConfigError, DEFAULT_CONFIG } from "../src/config.js";

const read = (obj) => () => JSON.stringify(obj);
// 默认关掉 slack，否则每个用例都要编一个 webhook URL
const load = (obj = {}, env = {}) =>
  loadConfig({ file: "config.json", env, readFile: read({ slack: { enabled: false }, ...obj }) });
const ONE_PAIR = { pairs: [{ from: "near:USDC", to: "eth:USDC" }] };

test("找不到配置文件时报出路径", () => {
  const boom = () => { const e = new Error("nope"); e.code = "ENOENT"; throw e; };
  assert.throws(
    () => loadConfig({ file: "nope.json", env: {}, readFile: boom }),
    (e) => e instanceof ConfigError && e.message.includes("nope.json"),
  );
});

test("JSON 解析失败时带上原因", () => {
  assert.throws(
    () => loadConfig({ file: "c.json", env: {}, readFile: () => "{oops" }),
    (e) => e instanceof ConfigError && e.message.includes("无法解析"),
  );
});

test("空配置得到默认值", () => {
  const cfg = load(ONE_PAIR);
  assert.equal(cfg.intervalSec, 60);
  assert.equal(cfg.concurrency, 5);
  assert.equal(cfg.requestTimeoutMs, 15000);
  assert.equal(cfg.detect.priceDeviationPct, 10);
  assert.equal(cfg.detect.minSamples, 5);
  assert.equal(cfg.server.port, 8787);
  assert.equal(cfg.server.host, "127.0.0.1");
  assert.equal(cfg.defaults.swapType, "EXACT_OUTPUT");
  assert.equal(cfg.retention.rawDays, 14);
  assert.equal(cfg.defaultAmounts.USDC, "1500", "稳定币默认 1500 是实测选定的");
  assert.equal(cfg.defaultAmounts.ETH, "0.05");
});

test("深合并保留同节的其他默认值", () => {
  const cfg = load({ ...ONE_PAIR, slack: { enabled: false, digest: { hourLocal: 3 } } });
  assert.equal(cfg.slack.digest.hourLocal, 3);
  assert.equal(cfg.slack.digest.enabled, true, "digest 的兄弟字段应保留默认值");
  assert.equal(cfg.slack.mention, "");
});

test("pairs 整体替换而不是逐项合并", () => {
  const cfg = load({ ...ONE_PAIR, pairs: [{ from: "near:USDC", to: "sol:USDC" }] });
  assert.deepEqual(cfg.pairs, [{ from: "near:USDC", to: "sol:USDC" }]);
});

test("环境变量覆盖敏感项", () => {
  const cfg = load(ONE_PAIR, {
    SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/x",
    SERVER_BEARER_TOKEN: "s3cret",
  });
  assert.equal(cfg.slack.webhookUrl, "https://hooks.slack.com/services/x");
  assert.equal(cfg.server.bearerToken, "s3cret");
});

test("slack 开启但没有 webhook 时启动失败", () => {
  assert.throws(
    () => load({ ...ONE_PAIR, slack: { enabled: true } }),
    (e) => e instanceof ConfigError && e.issues.some((i) => i.includes("webhookUrl")),
  );
});

test("slack 开启且有 webhook 时通过", () => {
  const cfg = load({ ...ONE_PAIR, slack: { enabled: true, webhookUrl: "https://hooks.slack.com/services/x" } });
  assert.equal(cfg.slack.enabled, true);
});

test("非法数值与非法币对会被一次性列全", () => {
  assert.throws(
    () => load({ intervalSec: 0, concurrency: 999, pairs: [{ from: "nearUSDC", to: "eth:USDC" }] }),
    (e) => {
      assert.ok(e.issues.some((i) => i.includes("intervalSec")), "应报 intervalSec");
      assert.ok(e.issues.some((i) => i.includes("concurrency")), "应报 concurrency");
      assert.ok(e.issues.some((i) => i.includes("pairs[0].from")), "应报 pairs[0].from");
      return true;
    },
  );
});

test("pairs 为空数组时报错", () => {
  assert.throws(() => load({ pairs: [] }), (e) => e.issues.some((i) => i.includes("pairs")));
});

test("from 与 to 相同、amount 非法、swapType 非法都会被拒", () => {
  assert.throws(
    () => load({ pairs: [{ from: "near:USDC", to: "near:USDC", amount: "1.2.3", swapType: "EXACT_MIDDLE" }] }),
    (e) => {
      assert.ok(e.issues.some((i) => i.includes("相同")));
      assert.ok(e.issues.some((i) => i.includes("amount")));
      assert.ok(e.issues.some((i) => i.includes("swapType")));
      return true;
    },
  );
});

test("mergeDeep 不改动入参", () => {
  const base = { a: { b: 1 }, list: [1, 2] };
  const out = mergeDeep(base, { a: { c: 2 }, list: [3] });
  assert.deepEqual(base, { a: { b: 1 }, list: [1, 2] });
  assert.deepEqual(out, { a: { b: 1, c: 2 }, list: [3] });
  assert.notEqual(out.list, base.list);
});

test("配置里省略某个段时，它与 base 不能是同一个对象引用", () => {
  const base = { slack: { webhookUrl: "" }, pairs: [] };
  const out = mergeDeep(base, { pairs: [1] });
  assert.notEqual(out.slack, base.slack, "省略的段也必须深拷贝，否则会被写穿");
  out.slack.webhookUrl = "mutated";
  assert.equal(base.slack.webhookUrl, "", "写 out 不能影响 base");
});

test("环境变量覆盖不会污染 DEFAULT_CONFIG（模块级状态泄漏回归）", () => {
  const before = DEFAULT_CONFIG.slack.webhookUrl;
  // 注意：这里直接调 loadConfig 而不走 load 助手，因为助手会注入 slack 段，
  // 而这条用例要考的正是「配置里完全没有 slack 段」的路径
  loadConfig({
    file: "config.json",
    env: { SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/leaked" },
    readFile: read(ONE_PAIR),
  });
  assert.equal(DEFAULT_CONFIG.slack.webhookUrl, before, "DEFAULT_CONFIG 不能被写穿");
  // 紧接着一次不带环境变量、也不带 slack 段的加载，必须仍然因为缺 webhook 而失败
  assert.throws(
    () => loadConfig({ file: "config.json", env: {}, readFile: read(ONE_PAIR) }),
    (e) => e instanceof ConfigError && e.issues.some((i) => i.includes("webhookUrl")),
  );
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— `Cannot find module '../src/config.js'`

- [ ] **Step 4: 实现 `src/config.js`**

```js
import { readFileSync } from "node:fs";

export class ConfigError extends Error {
  constructor(issues) {
    super("配置无效:\n" + issues.map((issue) => `  - ${issue}`).join("\n"));
    this.name = "ConfigError";
    this.issues = issues;
  }
}

const EVM = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

// near / EVM / sol 三类的默认地址已用真实 dry-run 报价验证过被接受；
// tron 与 zec 的地址是格式合法的占位值，未验证（zec 目标链当前可通，tron 目标链当前返回
// Internal server error，因此在首次实测前无法区分是地址问题还是对方故障）。若某条链首次运行
// 报 `recipient is not valid`，把该链地址换成你自己控制的一个即可。
export const DEFAULT_ADDRESSES = {
  near: "monitor.near",
  eth: EVM, arb: EVM, base: EVM, op: EVM, pol: EVM, bsc: EVM,
  avax: EVM, gnosis: EVM, bera: EVM, xlayer: EVM, scroll: EVM,
  sol: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
  tron: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  zec: "t1a2VZ5kXqJxQz8kQyYvXqZ9mNnR4pLqDk3",
};

export const DEFAULT_CONFIG = {
  intervalSec: 60,
  concurrency: 5,
  requestTimeoutMs: 15000,
  quoteEndpoint: "https://test-api.stableflow.ai/v1/nearintents/quote",
  tokensSources: {
    stableflow: "https://test-api.stableflow.ai/v1/pay/tokens",
    oneclick: "https://1click.chaindefuser.com/v0/tokens",
  },
  defaults: {
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 10,
    confidentiality: "advanced",
    deadlineMs: 600000,
  },
  defaultAmounts: {
    USDC: "1500", USDT: "1500", DAI: "1500",
    ETH: "0.05", WETH: "0.05", SOL: "1",
    BNB: "0.1", AVAX: "5", POL: "100", TRX: "100", ZEC: "0.5",
  },
  addresses: { ...DEFAULT_ADDRESSES },
  pairs: [],
  detect: { priceDeviationPct: 10, minSamples: 5, realertMinutes: 30, rollingWindowMinutes: 60 },
  slack: {
    enabled: true,
    webhookUrl: "",
    mention: "",
    timeoutMs: 10000,
    digest: { enabled: true, hourLocal: 9 },
  },
  retention: { rawDays: 14, hourlyDays: 0 },
  server: { host: "127.0.0.1", port: 8787, cors: "*", bearerToken: "" },
};

const SWAP_TYPES = new Set(["EXACT_OUTPUT", "EXACT_INPUT"]);
const PAIR_KEY = /^[^:\s]+:[^:\s]+$/;
const POSITIVE_DECIMAL = /^\d+(\.\d+)?$/;

export function mergeDeep(base, override) {
  if (Array.isArray(override)) return override.slice();
  if (override === null || typeof override !== "object") return override;
  const out = {};
  // 先深拷贝 base 的每一个嵌套值。只写 {...base} 的话，配置里没提到的段
  // （如整个 slack）会与 DEFAULT_CONFIG 共享同一个对象引用，后续
  // `merged.slack.webhookUrl = env.SLACK_WEBHOOK_URL` 就写穿了模块默认值，
  // 同一个进程里第二次 loadConfig 会继承上一次的环境变量。
  for (const [key, baseValue] of Object.entries(base ?? {})) {
    out[key] = baseValue !== null && typeof baseValue === "object" ? clonePlain(baseValue) : baseValue;
  }
  for (const [key, value] of Object.entries(override)) {
    const baseValue = base?.[key];
    const bothPlainObjects =
      value !== null && typeof value === "object" && !Array.isArray(value) &&
      baseValue !== null && typeof baseValue === "object" && !Array.isArray(baseValue);
    out[key] = bothPlainObjects
      ? mergeDeep(baseValue, value)
      : (value !== null && typeof value === "object" ? clonePlain(value) : value);
  }
  return out;
}

/** 只处理 JSON 能出现的值（对象、数组、基本类型），不处理 Map/Date/函数 */
function clonePlain(value) {
  if (Array.isArray(value)) return value.map(clonePlain);
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const [key, nested] of Object.entries(value)) out[key] = clonePlain(nested);
  return out;
}

function requireInt(issues, path, value, min, max = Infinity) {
  const range = max === Infinity ? `>= ${min}` : `${min}..${max}`;
  if (!Number.isInteger(value) || value < min || value > max) {
    issues.push(`${path} 必须是整数且满足 ${range}，当前为 ${JSON.stringify(value)}`);
  }
}

function requireUrl(issues, path, value) {
  try {
    new URL(value);
  } catch {
    issues.push(`${path} 必须是合法 URL，当前为 ${JSON.stringify(value)}`);
  }
}

export function validate(cfg) {
  const issues = [];

  requireInt(issues, "intervalSec", cfg.intervalSec, 5);
  requireInt(issues, "concurrency", cfg.concurrency, 1, 50);
  requireInt(issues, "requestTimeoutMs", cfg.requestTimeoutMs, 1000);
  requireUrl(issues, "quoteEndpoint", cfg.quoteEndpoint);
  requireUrl(issues, "tokensSources.stableflow", cfg.tokensSources?.stableflow);
  requireUrl(issues, "tokensSources.oneclick", cfg.tokensSources?.oneclick);

  requireInt(issues, "defaults.deadlineMs", cfg.defaults?.deadlineMs, 60000);
  if (!SWAP_TYPES.has(cfg.defaults?.swapType)) {
    issues.push(`defaults.swapType 必须是 EXACT_OUTPUT 或 EXACT_INPUT，当前为 ${JSON.stringify(cfg.defaults?.swapType)}`);
  }
  if (typeof cfg.defaults?.slippageTolerance !== "number" || cfg.defaults.slippageTolerance < 0) {
    issues.push("defaults.slippageTolerance 必须是非负数");
  }

  if (!Array.isArray(cfg.pairs) || cfg.pairs.length === 0) {
    issues.push("pairs 必须是非空数组");
  } else {
    cfg.pairs.forEach((pair, index) => {
      const at = `pairs[${index}]`;
      if (pair === null || typeof pair !== "object") {
        issues.push(`${at} 必须是对象`);
        return;
      }
      if (!PAIR_KEY.test(pair.from ?? "")) {
        issues.push(`${at}.from 必须是 "network:SYMBOL" 形式，当前为 ${JSON.stringify(pair.from)}`);
      }
      if (!PAIR_KEY.test(pair.to ?? "")) {
        issues.push(`${at}.to 必须是 "network:SYMBOL" 形式，当前为 ${JSON.stringify(pair.to)}`);
      }
      if (pair.from && pair.from === pair.to) {
        issues.push(`${at} 的 from 与 to 相同 (${pair.from})`);
      }
      if (pair.amount !== undefined && !POSITIVE_DECIMAL.test(String(pair.amount))) {
        issues.push(`${at}.amount 必须是正的十进制字符串，当前为 ${JSON.stringify(pair.amount)}`);
      }
      if (pair.swapType !== undefined && !SWAP_TYPES.has(pair.swapType)) {
        issues.push(`${at}.swapType 必须是 EXACT_OUTPUT 或 EXACT_INPUT，当前为 ${JSON.stringify(pair.swapType)}`);
      }
      if (pair.slippageTolerance !== undefined &&
          (typeof pair.slippageTolerance !== "number" || pair.slippageTolerance < 0)) {
        issues.push(`${at}.slippageTolerance 必须是非负数`);
      }
    });
  }

  requireInt(issues, "detect.minSamples", cfg.detect?.minSamples, 1);
  requireInt(issues, "detect.realertMinutes", cfg.detect?.realertMinutes, 1);
  requireInt(issues, "detect.rollingWindowMinutes", cfg.detect?.rollingWindowMinutes, 5);
  if (typeof cfg.detect?.priceDeviationPct !== "number" || cfg.detect.priceDeviationPct < 0) {
    issues.push("detect.priceDeviationPct 必须是非负数");
  }

  if (cfg.slack?.enabled === true && !String(cfg.slack.webhookUrl ?? "").trim()) {
    issues.push("slack.enabled 为 true 时 slack.webhookUrl 不能为空（可用环境变量 SLACK_WEBHOOK_URL 提供），或显式设为 enabled: false");
  }
  requireInt(issues, "slack.digest.hourLocal", cfg.slack?.digest?.hourLocal, 0, 23);

  requireInt(issues, "retention.rawDays", cfg.retention?.rawDays, 0);
  requireInt(issues, "retention.hourlyDays", cfg.retention?.hourlyDays, 0);

  if (typeof cfg.server?.host !== "string" || cfg.server.host.trim() === "") {
    issues.push("server.host 不能为空字符串");
  }
  requireInt(issues, "server.port", cfg.server?.port, 1, 65535);
  if (typeof cfg.server?.cors !== "string") issues.push("server.cors 必须是字符串");
  if (typeof cfg.server?.bearerToken !== "string") issues.push("server.bearerToken 必须是字符串");

  return issues;
}

export function loadConfig({ file = "config.json", env = process.env, readFile = readFileSync } = {}) {
  let raw;
  try {
    raw = JSON.parse(readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new ConfigError([`找不到配置文件 ${file}，可从 config.example.json 复制一份为 ${file}`]);
    }
    throw new ConfigError([`无法解析配置文件 ${file}: ${error.message}`]);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError([`配置文件 ${file} 的顶层必须是一个对象`]);
  }

  const merged = mergeDeep(DEFAULT_CONFIG, raw);
  if (env.SLACK_WEBHOOK_URL) merged.slack.webhookUrl = env.SLACK_WEBHOOK_URL;
  if (env.SERVER_BEARER_TOKEN) merged.server.bearerToken = env.SERVER_BEARER_TOKEN;

  const issues = validate(merged);
  if (issues.length > 0) throw new ConfigError(issues);
  return merged;
}
```

- [ ] **Step 5: 跑测试确认全绿**

Run: `npm test`
Expected: PASS，14 个用例全过，且**输出里没有 ExperimentalWarning**（证明 `--disable-warning` 生效）

- [ ] **Step 6: 提交**

```bash
git add package.json src/config.js test/config.test.js
git commit -m "feat: 配置模块与项目骨架（零依赖，node:sqlite 已验通）"
```

---

### Task 2: 金额换算

这是把参考实现里那个 bug 永久锁死的地方：`EXACT_OUTPUT` 的 `amount` 是**目标 token** 的最小单位，不是源 token 的。参考实现用 `from.decimals` 换算，只在两边小数位相同时碰巧正确。

**Files:**
- Create: `src/amount.js`
- Test: `test/amount.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `class AmountError extends Error`
  - `toMinorUnits(human: string|number, decimals: number): string`
  - `unitDecimals({ swapType, fromDecimals, toDecimals }): number`
  - `resolveAmount({ swapType, amount, fromDecimals, toDecimals }): { human, minor, unitDecimals, side }`
  - `pickDefaultAmount({ defaultAmounts, symbol }): string`

- [ ] **Step 1: 写失败测试 `test/amount.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { toMinorUnits, unitDecimals, resolveAmount, pickDefaultAmount, AmountError } from "../src/amount.js";

test("整数值换算", () => {
  assert.equal(toMinorUnits("1", 6), "1000000");
  assert.equal(toMinorUnits("1500", 6), "1500000000");
  assert.equal(toMinorUnits(100, 6), "100000000");
});

test("小数换算不丢精度", () => {
  assert.equal(toMinorUnits("0.05", 18), "50000000000000000");
  assert.equal(toMinorUnits("0.5", 8), "50000000");
  assert.equal(toMinorUnits("1.301437", 6), "1301437");
  assert.equal(toMinorUnits("0.000001", 6), "1");
});

test("超出精度的小数被拒", () => {
  assert.throws(() => toMinorUnits("1.0000001", 6), AmountError);
  assert.throws(() => toMinorUnits("0.05", 0), AmountError);
});

test("零与负数与非数字被拒", () => {
  assert.throws(() => toMinorUnits("0", 6), (e) => e instanceof AmountError && e.message.includes("大于 0"));
  assert.throws(() => toMinorUnits("0.0", 6), AmountError);
  assert.throws(() => toMinorUnits("-1", 6), AmountError);
  assert.throws(() => toMinorUnits("1e6", 6), AmountError);
  assert.throws(() => toMinorUnits("", 6), AmountError);
  assert.throws(() => toMinorUnits("abc", 6), AmountError);
});

test("EXACT_OUTPUT 用目标 token 的小数位（回归：参考实现的 bug）", () => {
  // near:USDC(6) -> eth:ETH(18)，要拿到 0.05 ETH，amount 必须是 18 位
  const out = resolveAmount({ swapType: "EXACT_OUTPUT", amount: "0.05", fromDecimals: 6, toDecimals: 18 });
  assert.equal(out.unitDecimals, 18);
  assert.equal(out.minor, "50000000000000000");
  assert.equal(out.side, "to");

  // 反方向：eth:ETH(18) -> near:USDC(6)，要拿到 1 USDC，amount 必须是 6 位
  const back = resolveAmount({ swapType: "EXACT_OUTPUT", amount: "1", fromDecimals: 18, toDecimals: 6 });
  assert.equal(back.unitDecimals, 6);
  assert.equal(back.minor, "1000000");
});

test("EXACT_INPUT 用源 token 的小数位", () => {
  const out = resolveAmount({ swapType: "EXACT_INPUT", amount: "1", fromDecimals: 18, toDecimals: 6 });
  assert.equal(out.unitDecimals, 18);
  assert.equal(out.minor, "1000000000000000000");
  assert.equal(out.side, "from");
});

test("未知 swapType 报错", () => {
  assert.throws(() => unitDecimals({ swapType: "EXACT_MIDDLE", fromDecimals: 6, toDecimals: 6 }), AmountError);
});

test("缺省金额按目标 token 的 symbol 取，兜底为 1", () => {
  const defaultAmounts = { USDC: "1500", ZEC: "0.5" };
  assert.equal(pickDefaultAmount({ defaultAmounts, symbol: "USDC" }), "1500");
  assert.equal(pickDefaultAmount({ defaultAmounts, symbol: "ZEC" }), "0.5");
  assert.equal(pickDefaultAmount({ defaultAmounts, symbol: "WIF" }), "1");
  assert.equal(pickDefaultAmount({ defaultAmounts: undefined, symbol: "USDC" }), "1");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— `Cannot find module '../src/amount.js'`

- [ ] **Step 3: 实现 `src/amount.js`**

```js
export class AmountError extends Error {
  constructor(message) {
    super(message);
    this.name = "AmountError";
  }
}

const POSITIVE_DECIMAL = /^\d+(\.\d+)?$/;

/**
 * 人类可读金额 → 最小单位整数字符串。
 * 全程字符串运算，绝不经过浮点数。
 */
export function toMinorUnits(human, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new AmountError(`decimals 必须是非负整数，收到 ${JSON.stringify(decimals)}`);
  }
  const raw = String(human ?? "").trim();
  if (!POSITIVE_DECIMAL.test(raw)) {
    throw new AmountError(`金额必须是正的十进制数，收到 ${JSON.stringify(human)}`);
  }
  const [whole, fraction = ""] = raw.split(".");
  if (fraction.length > decimals) {
    throw new AmountError(`金额 ${raw} 的小数位超过该 token 的 ${decimals} 位`);
  }
  const minor = (whole + fraction.padEnd(decimals, "0")).replace(/^0+/, "") || "0";
  if (minor === "0") throw new AmountError(`金额必须大于 0，收到 ${JSON.stringify(human)}`);
  return minor;
}

/**
 * 最小单位属于哪一侧的 token。
 * EXACT_OUTPUT：目标数量固定，amount 是目标 token 的最小单位。
 * EXACT_INPUT：输入数量固定，amount 是源 token 的最小单位。
 */
export function unitDecimals({ swapType, fromDecimals, toDecimals }) {
  if (swapType === "EXACT_OUTPUT") return toDecimals;
  if (swapType === "EXACT_INPUT") return fromDecimals;
  throw new AmountError(`未知的 swapType: ${JSON.stringify(swapType)}`);
}

export function resolveAmount({ swapType, amount, fromDecimals, toDecimals }) {
  const decimals = unitDecimals({ swapType, fromDecimals, toDecimals });
  return {
    human: String(amount),
    minor: toMinorUnits(amount, decimals),
    unitDecimals: decimals,
    side: swapType === "EXACT_OUTPUT" ? "to" : "from",
  };
}

export function pickDefaultAmount({ defaultAmounts, symbol }) {
  const value = defaultAmounts?.[symbol];
  return value === undefined || value === null ? "1" : String(value);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/amount.js test/amount.test.js
git commit -m "feat: 金额换算，EXACT_OUTPUT 按目标 token 的 decimals 取最小单位"
```

---

### Task 3: 数值工具（中位数与分位）

**Files:**
- Create: `src/numeric.js`
- Test: `test/numeric.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `median(values: number[]): number | null` —— 空数组返回 `null`
  - `percentile(values: number[], p: number): number | null` —— `p` 为 0..1，内部自行排序，空数组返回 `null`

- [ ] **Step 1: 写失败测试 `test/numeric.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { median, percentile } from "../src/numeric.js";

test("中位数：奇数个取正中", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4, 5]), 3);
});

test("中位数：偶数个取中间两个的均值", () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([2, 4]), 3);
});

test("中位数：单个与空数组", () => {
  assert.equal(median([7]), 7);
  assert.equal(median([]), null);
});

test("中位数：不改动入参顺序", () => {
  const input = [3, 1, 2];
  median(input);
  assert.deepEqual(input, [3, 1, 2]);
});

test("中位数：单个异常值不影响结果（这是选它当基准的原因）", () => {
  assert.equal(median([1, 1, 1, 1, 100]), 1);
});

test("分位数用最近秩法且在边界上不越界", () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(values, 0.5), 5);
  assert.equal(percentile(values, 0.95), 10);
  assert.equal(percentile(values, 0), 1);
  assert.equal(percentile(values, 1), 10);
});

test("分位数：空数组返回 null，不排序入参", () => {
  assert.equal(percentile([], 0.5), null);
  const input = [5, 1, 3];
  percentile(input, 0.5);
  assert.deepEqual(input, [5, 1, 3]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— `Cannot find module '../src/numeric.js'`

- [ ] **Step 3: 实现 `src/numeric.js`**

```js
/** 都返回新数组，不改动入参顺序 */
function sortedCopy(values) {
  return [...values].sort((a, b) => a - b);
}

export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = sortedCopy(values);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** 最近秩法（nearest-rank）：取第 ceil(p * n) 个元素，1-based */
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = sortedCopy(values);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/numeric.js test/numeric.test.js
git commit -m "feat: median 与 percentile 数值工具"
```

---

### Task 4: token 归一化与币对绑定

**Files:**
- Create: `src/assets.js`
- Test: `test/assets.test.js`

**Interfaces:**
- Consumes: `ConfigError`（`src/config.js`）、`resolveAmount` / `pickDefaultAmount`（`src/amount.js`）
- Produces:
  - `resolveAssetId(payToken: object, oneclickTokens: object[]): string`
  - `normalizeTokens({ stableflow: object[], oneclick: object[] }): Token[]`，其中 `Token = { key, network, symbol, decimals, contractAddress, assetId, supportPayment, supportReceive }`
  - `indexTokens(tokens: Token[]): Map<string, Token>`
  - `parsePairKey(key: string): { network, symbol }`
  - `buildPairs({ pairDefs, tokens, addresses, defaults, defaultAmounts }): ResolvedPair[]`，其中 `ResolvedPair = { id, label, fromKey, toKey, fromAsset, toAsset, swapType, amount, amountMinor, fromDecimals, toDecimals, slippageTolerance, confidentiality, deadlineMs, refundTo, recipient }`；任一条目有问题就抛 `ConfigError`，`.issues` 列出全部问题
  - `pairDefs` 里 `enabled === false` 的条目被跳过

- [ ] **Step 1: 写失败测试 `test/assets.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTokens, indexTokens, parsePairKey, resolveAssetId, buildPairs } from "../src/assets.js";
import { ConfigError } from "../src/config.js";

const ONECLICK = [
  { blockchain: "near", contractAddress: "usdc.near", assetId: "nep141:usdc.near" },
  { blockchain: "eth", contractAddress: "0xA0b8", assetId: "nep141:eth-0xa0b8.omft.near" },
  { blockchain: "sol", contractAddress: "", assetId: "nep141:sol.omft.near" },
];
const STABLEFLOW = [
  { network: "near", symbol: "USDC", decimals: 6, contract_address: "usdc.near", support_payment: true, support_receive: true },
  { network: "eth", symbol: "USDC", decimals: 6, contract_address: "0xA0b8", support_payment: true, support_receive: true },
  { network: "eth", symbol: "ETH", decimals: 18, contract_address: "", support_payment: true, support_receive: true },
  { network: "zec", symbol: "ZEC", decimals: 8, contract_address: "", support_payment: true, support_receive: true },
  { network: "bsc", symbol: "USDC", decimals: 18, contract_address: "0xBSC", support_payment: true, support_receive: false },
  { network: "tron", symbol: "USDT", decimals: 6, contract_address: "TR7", support_payment: false, support_receive: true },
];

const DEFAULTS = { swapType: "EXACT_OUTPUT", slippageTolerance: 10, confidentiality: "advanced", deadlineMs: 600000 };
const ADDRESSES = { near: "monitor.near", eth: "0xADDR", zec: "t1addr" };
const DEFAULT_AMOUNTS = { USDC: "1500", ZEC: "0.5", ETH: "0.05" };

const build = (pairDefs, overrides = {}) =>
  buildPairs({
    pairDefs,
    tokens: normalizeTokens({ stableflow: STABLEFLOW, oneclick: ONECLICK }),
    addresses: ADDRESSES,
    defaults: DEFAULTS,
    defaultAmounts: DEFAULT_AMOUNTS,
    ...overrides,
  });

test("normalizeTokens 用 network:symbol 做 key 并归一化字段", () => {
  const tokens = normalizeTokens({ stableflow: STABLEFLOW, oneclick: ONECLICK });
  assert.equal(tokens.length, 6);
  assert.deepEqual(tokens[0], {
    key: "near:USDC",
    network: "near",
    symbol: "USDC",
    decimals: 6,
    contractAddress: "usdc.near",
    assetId: "nep141:usdc.near",
    supportPayment: true,
    supportReceive: true,
  });
});

test("oneclick 载荷不是数组时降级为空，不抛异常", () => {
  const tokens = normalizeTokens({ stableflow: STABLEFLOW, oneclick: { error: "nope" } });
  assert.equal(tokens.length, 6);
  assert.equal(tokens[0].assetId, "nep141:usdc.near", "near 的 fallback 是 nep141:<contract>");
  assert.equal(tokens[3].assetId, "nep141:zec.omft.near", "无合约的链走 nep141:<network>.omft.near");
});

test("resolveAssetId：1click 命中时直接用它的 assetId", () => {
  assert.equal(resolveAssetId({ network: "ETH", contract_address: "0xa0b8" }, ONECLICK), "nep141:eth-0xa0b8.omft.near");
});

test("resolveAssetId：未命中时按规则拼接", () => {
  // nearc 上没有 contract 的链
  assert.equal(resolveAssetId({ network: "zec", contract_address: "" }, []), "nep141:zec.omft.near");
  // 0x 开头的合约：强制转小写（与真实 assetId 一致）
  assert.equal(resolveAssetId({ network: "bsc", contract_address: "0xDEAD" }, []), "nep141:bsc-0xdead.omft.near");
  // 非 0x 的非 near 合约
  assert.equal(resolveAssetId({ network: "sol", contract_address: "So1abc" }, []), "nep141:sol-so1abc.omft.near");
  // near 本身
  assert.equal(resolveAssetId({ network: "near", contract_address: "usdc.near" }, []), "nep141:usdc.near");
});

test("parsePairKey 拆出 network 与 symbol", () => {
  assert.deepEqual(parsePairKey("near:USDC"), { network: "near", symbol: "USDC" });
});

test("buildPairs 产出完整可用的币对", () => {
  const [pair] = build([{ from: "near:USDC", to: "eth:USDC" }]);
  assert.equal(pair.id, "near:USDC>eth:USDC");
  assert.equal(pair.label, "near:USDC → eth:USDC");
  assert.equal(pair.fromAsset, "nep141:usdc.near");
  assert.equal(pair.toAsset, "nep141:eth-0xa0b8.omft.near");
  assert.equal(pair.amount, "1500");
  assert.equal(pair.amountMinor, "1500000000", "目标 eth:USDC 是 6 位");
  assert.equal(pair.refundTo, "monitor.near");
  assert.equal(pair.recipient, "0xADDR");
  assert.equal(pair.swapType, "EXACT_OUTPUT");
  assert.equal(pair.slippageTolerance, 10);
  assert.equal(pair.confidentiality, "advanced");
  assert.equal(pair.deadlineMs, 600000);
});

test("缺省金额按目标 token 的 symbol 选，并用目标 decimals 换算", () => {
  const [pair] = build([{ from: "near:USDC", to: "zec:ZEC" }]);
  assert.equal(pair.amount, "0.5", "ZEC 的默认金额");
  assert.equal(pair.amountMinor, "50000000", "ZEC 是 8 位");
});

test("币对级 amount 覆盖全局默认", () => {
  const [pair] = build([{ from: "near:USDC", to: "eth:USDC", amount: "50" }]);
  assert.equal(pair.amountMinor, "50000000");
});

test("EXACT_OUTPUT 缺省金额取目标 symbol 而不是源 symbol", () => {
  // near:USDC(6) -> eth:ETH(18)：默认金额应取 ETH 的 0.05，用 18 位换算
  const [pair] = build([{ from: "near:USDC", to: "eth:ETH" }]);
  assert.equal(pair.amount, "0.05");
  assert.equal(pair.amountMinor, "50000000000000000");
  assert.equal(pair.recipient, "0xADDR", "receipient 取目标链 eth 的地址");
});

test("enabled: false 的币对被跳过", () => {
  const pairs = build([
    { from: "near:USDC", to: "eth:USDC" },
    { from: "near:USDC", to: "zec:ZEC", enabled: false },
  ]);
  assert.equal(pairs.length, 1);
});

test("未知 token 一次性列全，并指出是第几条", () => {
  assert.throws(
    () => build([{ from: "near:WIF", to: "eth:USDC" }, { from: "near:USDC", to: "sol:BONK" }]),
    (e) => {
      assert.ok(e instanceof ConfigError);
      assert.ok(e.issues.some((i) => i.includes("pairs[0]") && i.includes("near:WIF")));
      assert.ok(e.issues.some((i) => i.includes("pairs[1]") && i.includes("sol:BONK")));
      return true;
    },
  );
});

test("缺少某条链的地址时启动失败", () => {
  assert.throws(
    () => build([{ from: "near:USDC", to: "zec:ZEC" }], { addresses: { near: "monitor.near" } }),
    (e) => e.issues.some((i) => i.includes("zec") && i.includes("接收地址")),
  );
});

test("来源链缺地址时报退款地址缺失", () => {
  assert.throws(
    () => build([{ from: "zec:ZEC", to: "near:USDC" }], { addresses: { near: "monitor.near" } }),
    (e) => e.issues.some((i) => i.includes("zec") && i.includes("退款地址")),
  );
});

test("目标链不支持接收时被拒", () => {
  assert.throws(
    () => build([{ from: "near:USDC", to: "bsc:USDC" }]),
    (e) => e.issues.some((i) => i.includes("bsc:USDC") && i.includes("support_receive")),
  );
});

test("源链不支持支付时被拒", () => {
  assert.throws(
    () => build([{ from: "tron:USDT", to: "near:USDC" }]),
    (e) => e.issues.some((i) => i.includes("tron:USDT") && i.includes("support_payment")),
  );
});

test("重复币对被拒", () => {
  assert.throws(
    () => build([{ from: "near:USDC", to: "eth:USDC" }, { from: "near:USDC", to: "eth:USDC" }]),
    (e) => e.issues.some((i) => i.includes("重复")),
  );
});

test("金额精度不够时把 AmountError 转成配置错误", () => {
  assert.throws(
    () => build([{ from: "near:USDC", to: "eth:USDC", amount: "1.0000001" }]),
    (e) => e instanceof ConfigError && e.issues.some((i) => i.includes("小数位")),
  );
});

test("indexTokens 建出可查的索引", () => {
  const tokens = normalizeTokens({ stableflow: STABLEFLOW, oneclick: ONECLICK });
  const byKey = indexTokens(tokens);
  assert.equal(byKey.get("eth:ETH").decimals, 18);
  assert.equal(byKey.get("nope"), undefined);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— `Cannot find module '../src/assets.js'`

- [ ] **Step 3: 实现 `src/assets.js`**

```js
import { ConfigError } from "./config.js";
import { pickDefaultAmount, resolveAmount } from "./amount.js";

/** 与参考实现 near-intents.html 的 matchAssetId 同源；实测 45 个 token 全部命中 1click，fallback 未触发过 */
export function resolveAssetId(payToken, oneclickTokens) {
  const network = String(payToken.network || "").toLowerCase();
  const contract = String(payToken.contract_address || "").toLowerCase();
  const hit = oneclickTokens.find(
    (token) =>
      String(token.blockchain || "").toLowerCase() === network &&
      String(token.contractAddress || "").toLowerCase() === contract,
  );
  if (hit?.assetId) return hit.assetId;
  if (network === "near" && contract) return `nep141:${payToken.contract_address}`;
  if (!contract) return `nep141:${network}.omft.near`;
  // 统一小写：实测 1click 的 102 个 EVM 合约 assetId 里 101 个是全小写，
  // 真实形如 nep141:eth-0xa0b8…eb48.omft.near。之前这里另起一个
  // `if (contract.startsWith("0x"))` 分支但两条 return 模板完全相同，
  // 唯一区别是用小写的 contract 还是原值 payToken.contract_address，属于无谓的死分支。
  return `nep141:${network}-${contract}.omft.near`;
}

export function normalizeTokens({ stableflow, oneclick }) {
  if (!Array.isArray(stableflow)) throw new ConfigError(["StableFlow token 列表不是数组，无法继续"]);
  const oneclickTokens = Array.isArray(oneclick) ? oneclick : [];
  return stableflow.map((item) => ({
    key: `${item.network}:${item.symbol}`,
    network: item.network,
    symbol: item.symbol,
    decimals: Number(item.decimals),
    contractAddress: item.contract_address || "",
    assetId: resolveAssetId(item, oneclickTokens),
    supportPayment: Boolean(item.support_payment),
    supportReceive: Boolean(item.support_receive),
  }));
}

export function indexTokens(tokens) {
  const byKey = new Map();
  for (const token of tokens) byKey.set(token.key, token);
  return byKey;
}

export function parsePairKey(key) {
  const [network, symbol] = String(key).split(":");
  return { network, symbol };
}

export function buildPairs({ pairDefs, tokens, addresses, defaults, defaultAmounts }) {
  const byKey = indexTokens(tokens);
  const issues = [];
  const pairs = [];
  const seen = new Set();

  pairDefs.forEach((def, index) => {
    if (def?.enabled === false) return;
    const at = `pairs[${index}] (${def?.from} → ${def?.to})`;

    const from = byKey.get(def.from);
    const to = byKey.get(def.to);
    if (!from) { issues.push(`${at}: 未知的 origin token ${JSON.stringify(def.from)}`); return; }
    if (!to) { issues.push(`${at}: 未知的 destination token ${JSON.stringify(def.to)}`); return; }
    if (!from.supportPayment) issues.push(`${at}: ${def.from} 不支持作为支付方 (support_payment=false)`);
    if (!to.supportReceive) issues.push(`${at}: ${def.to} 不支持作为接收方 (support_receive=false)`);

    const refundTo = addresses?.[from.network];
    const recipient = addresses?.[to.network];
    if (!refundTo) issues.push(`${at}: addresses 缺少 ${from.network} 的退款地址`);
    if (!recipient) issues.push(`${at}: addresses 缺少 ${to.network} 的接收地址`);
    if (!refundTo || !recipient) return;

    const id = `${def.from}>${def.to}`;
    if (seen.has(id)) { issues.push(`${at}: 重复的币对 ${id}`); return; }
    seen.add(id);

    const swapType = def.swapType ?? defaults.swapType;
    const amountSymbol = (swapType === "EXACT_OUTPUT" ? to : from).symbol;
    const amount = def.amount ?? pickDefaultAmount({ defaultAmounts, symbol: amountSymbol });

    let resolved;
    try {
      resolved = resolveAmount({ swapType, amount, fromDecimals: from.decimals, toDecimals: to.decimals });
    } catch (error) {
      issues.push(`${at}: ${error.message}`);
      return;
    }

    pairs.push({
      id,
      label: `${def.from} → ${def.to}`,
      fromKey: def.from,
      toKey: def.to,
      fromAsset: from.assetId,
      toAsset: to.assetId,
      swapType,
      amount: resolved.human,
      amountMinor: resolved.minor,
      fromDecimals: from.decimals,
      toDecimals: to.decimals,
      slippageTolerance: def.slippageTolerance ?? defaults.slippageTolerance,
      confidentiality: defaults.confidentiality,
      deadlineMs: defaults.deadlineMs,
      refundTo,
      recipient,
    });
  });

  if (issues.length > 0) throw new ConfigError(issues);
  return pairs;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/assets.js test/assets.test.js
git commit -m "feat: token 归一化、assetId 解析与白名单绑定，解析失败启动即报"
```

---

### Task 5: HTTP 管道（超时、错误归类、有界并发）

**Files:**
- Create: `src/http.js`
- Test: `test/http.test.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `class HttpError extends Error`，字段 `.code: "http_4xx"|"http_5xx"|"timeout"|"network"`、`.status: number|null`、`.body: any`
  - `fetchJson(url, { method?, headers?, body?, timeoutMs?, fetchImpl? }): Promise<{ status, payload, latencyMs }>`，非 2xx、超时、网络故障一律抛 `HttpError`
  - `mapLimit(items, limit, worker): Promise<Array<{ ok: true, value } | { ok: false, error }>>`，**保序**，worker 抛错被捕获成 `{ ok:false, error }` 而不是让整批失败

- [ ] **Step 1: 写失败测试 `test/http.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchJson, mapLimit, HttpError } from "../src/http.js";

const reply = (status, text, ok = status >= 200 && status < 300) => async () => ({ ok, status, text: async () => text });

test("2xx 解析 JSON 并给出耗时", async () => {
  const out = await fetchJson("https://x/y", { fetchImpl: reply(200, '{"a":1}') });
  assert.equal(out.status, 200);
  assert.deepEqual(out.payload, { a: 1 });
  assert.equal(typeof out.latencyMs, "number");
});

test("2xx 但响应不是 JSON 时原样返回文本", async () => {
  const out = await fetchJson("https://x/y", { fetchImpl: reply(200, "pong") });
  assert.equal(out.payload, "pong");
});

test("2xx 且响应体为空时 payload 为 null", async () => {
  const out = await fetchJson("https://x/y", { fetchImpl: reply(204, "") });
  assert.equal(out.payload, null);
});

test("4xx 抛 HttpError 并带上服务端 message", async () => {
  await assert.rejects(
    fetchJson("https://x/y", { fetchImpl: reply(400, '{"message":"tokenOut is not valid"}') }),
    (e) => {
      assert.ok(e instanceof HttpError);
      assert.equal(e.code, "http_4xx");
      assert.equal(e.status, 400);
      assert.ok(e.message.includes("tokenOut is not valid"));
      assert.deepEqual(e.body, { message: "tokenOut is not valid" });
      return true;
    },
  );
});

test("5xx 归类为 http_5xx", async () => {
  await assert.rejects(
    fetchJson("https://x/y", { fetchImpl: reply(503, '{"error":"down"}') }),
    (e) => e.code === "http_5xx" && e.status === 503 && e.message.includes("down"),
  );
});

test("超时归类为 timeout", async () => {
  const hanging = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  await assert.rejects(
    fetchJson("https://x/y", { timeoutMs: 10, fetchImpl: hanging }),
    (e) => e.code === "timeout" && e.message.includes("超时"),
  );
});

test("网络故障归类为 network", async () => {
  await assert.rejects(
    fetchJson("https://x/y", { fetchImpl: async () => { throw new TypeError("fetch failed"); } }),
    (e) => e.code === "network" && e.message.includes("fetch failed"),
  );
});

test("fetchJson 把方法、头、体、signal 透传给 fetchImpl", async () => {
  let seen;
  await fetchJson("https://x/y", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"a":1}',
    fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, status: 200, text: async () => "{}" }; },
  });
  assert.equal(seen.url, "https://x/y");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.body, '{"a":1}');
  assert.ok(seen.init.signal instanceof AbortSignal);
});

test("mapLimit 保序返回", async () => {
  const out = await mapLimit([3, 1, 2], 2, async (n) => { await new Promise((r) => setTimeout(r, n)); return n * 10; });
  assert.deepEqual(out.map((r) => r.value), [30, 10, 20]);
});

test("mapLimit 遵守并发上限", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return "done";
  });
  assert.equal(peak, 3);
  assert.equal(out.length, 8);
  assert.ok(out.every((r) => r.ok && r.value === "done"));
});

test("mapLimit 把 worker 抛错捕获成结果项，不中断整批", async () => {
  const out = await mapLimit([1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error("boom");
    return n;
  });
  assert.equal(out[0].value, 1);
  assert.equal(out[1].ok, false);
  assert.equal(out[1].error.message, "boom");
  assert.equal(out[2].value, 3);
});

test("mapLimit 处理空数组", async () => {
  assert.deepEqual(await mapLimit([], 5, async () => 1), []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— `Cannot find module '../src/http.js'`

- [ ] **Step 3: 实现 `src/http.js`**

```js
export class HttpError extends Error {
  constructor(message, { code, status = null, body = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "HttpError";
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

/** 非 2xx / 超时 / 网络故障一律抛 HttpError，code 直接就是落库用的 error_code */
export async function fetchJson(url, { method = "GET", headers = {}, body, timeoutMs = 15000, fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(url, { method, headers, body, signal: controller.signal });
    const text = await response.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = text; }
    }
    if (!response.ok) {
      const detail = payload !== null && typeof payload === "object" ? (payload.message ?? payload.error ?? null) : payload;
      throw new HttpError(
        `${method} ${url} → HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
        { code: response.status >= 500 ? "http_5xx" : "http_4xx", status: response.status, body: payload },
      );
    }
    return { status: response.status, payload, latencyMs: Date.now() - startedAt };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error?.name === "AbortError") {
      throw new HttpError(`${method} ${url} 超时（${timeoutMs}ms）`, { code: "timeout", cause: error });
    }
    throw new HttpError(`${method} ${url} 网络错误: ${error?.message ?? error}`, { code: "network", cause: error });
  } finally {
    clearTimeout(timer);
  }
}

/** 有界并发，保序返回。worker 抛错变成结果项，单条失败不会拖垮整批。 */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runner = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await worker(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  };
  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: size }, runner));
  return results;
}
```

`mapLimit` 的并发上限取 `Math.min(limit, items.length)` 且至少为 1，所以空数组不会死锁。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/http.js test/http.test.js
git commit -m "feat: fetchJson 超时与错误归类、mapLimit 有界并发"
```

---

### Task 6: 存储核心（建表、写入、查询）

**Files:**
- Create: `src/store.js`
- Test: `test/store.test.js`

**Interfaces:**
- Consumes: `percentile`（`src/numeric.js`）
- Produces:
  - `openStore(file: string, opts?: { DatabaseImpl? }): Store`
  - `class Store`，方法：
    - `upsertPairs(pairs: ResolvedPair[], nowIso: string): void` —— 配置里已消失的币对置 `enabled=0`，不删历史
    - `getPairs(): object[]` / `getPairsWithState(): object[]`
    - `insertQuotes(rows: Row[]): number` —— 单事务，返回写入条数
    - `getRecentQuotes(pairId, sinceIso, limit): Quote[]` —— 按 id 倒序
    - `getPairStates(): Map<string, PairState>` / `upsertPairState(state): void`
    - `insertAlert({ ts, pairId, kind, detail, notified }): number`（返回 id）/ `getAlerts({ limit?, since? }): object[]` / `markAlertNotified(id, notified)`
    - `getLatestPerPair(): object[]` —— 每对最新一条，带 `stateStatus` / `stateSince` / `stateFailures`
    - `getHistory({ pairId?, from?, to?, limit?, resolution? }): object[]`
    - `getStats({ sinceIso, resolution }): { resolution, pairs: [...] }`
    - `getMeta(key, fallback?): any` / `setMeta(key, value): void` —— 值 JSON 往返
    - `close(): void`
  - `Row 行形状`：`{ ts, pairId, ok, httpStatus?, latencyMs?, amountIn?, amountOut?, amountInUsd?, amountOutUsd?, minAmountIn?, minAmountOut?, timeEstimate?, correlationId?, errorCode?, errorMessage? }`

- [ ] **Step 1: 写失败测试 `test/store.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../src/store.js";

const PAIR_A = {
  id: "near:USDC>eth:USDC", label: "near:USDC → eth:USDC", fromKey: "near:USDC", toKey: "eth:USDC",
  fromAsset: "nep141:usdc.near", toAsset: "nep141:eth-usdc.omft.near", swapType: "EXACT_OUTPUT",
  amount: "1500", amountMinor: "1500000000", fromDecimals: 6, toDecimals: 6,
};
const PAIR_B = { ...PAIR_A, id: "near:USDC>sol:USDC", label: "near:USDC → sol:USDC", toKey: "sol:USDC", toAsset: "nep141:sol-usdc.omft.near" };

const row = (pairId, ts, overrides = {}) => ({
  ts, pairId, ok: true, httpStatus: 201, latencyMs: 1000,
  amountIn: "1501.5", amountOut: "1500", amountInUsd: "1501.4", amountOutUsd: "1500",
  minAmountIn: "1501.4", minAmountOut: "1500", timeEstimate: 27, correlationId: "cid",
  ...overrides,
});

function fresh() {
  const store = openStore(":memory:");
  store.upsertPairs([PAIR_A, PAIR_B], "2026-09-15T00:00:00Z");
  return store;
}

test("建表幂等：重复 openStore 同一文件不报错", () => {
  const store = openStore(":memory:");
  store.close();
});

test("upsertPairs 可反复调用，且把消失的币对置为 disabled 而不删历史", () => {
  const store = fresh();
  store.insertQuotes([row(PAIR_B.id, "2026-09-15T00:00:00Z")]);
  store.upsertPairs([PAIR_A], "2026-09-15T00:05:00Z");
  const pairs = store.getPairs();
  assert.equal(pairs.length, 2, "PAIR_B 的记录应保留");
  assert.equal(pairs.find((p) => p.id === PAIR_A.id).enabled, true);
  assert.equal(pairs.find((p) => p.id === PAIR_B.id).enabled, false);
  assert.equal(store.getHistory({ pairId: PAIR_B.id }).length, 1, "历史不该被删");
  store.close();
});

test("insertQuotes 写入并在失败时整体回滚", () => {
  const store = fresh();
  assert.equal(store.insertQuotes([row(PAIR_A.id, "2026-09-15T00:00:00Z")]), 1);
  assert.equal(store.insertQuotes([]), 0);
  // pair_id 为 undefined 会让 NOT NULL 约束失败
  assert.throws(() => store.insertQuotes([row(PAIR_A.id, "2026-09-15T00:01:00Z"), { ts: "x", pairId: null, ok: false }]), /NOT NULL|constraint/i);
  assert.equal(store.getHistory({ pairId: PAIR_A.id }).length, 1, "同一事务里的第一条也应回滚");
  store.close();
});

test("getRecentQuotes 倒序、按时间过滤、遵守 limit", () => {
  const store = fresh();
  store.insertQuotes([
    row(PAIR_A.id, "2026-09-15T00:00:00Z"),
    row(PAIR_A.id, "2026-09-15T00:01:00Z"),
    row(PAIR_A.id, "2026-09-15T00:02:00Z"),
  ]);
  const recent = store.getRecentQuotes(PAIR_A.id, "2026-09-15T00:00:00Z", 10);
  assert.deepEqual(recent.map((q) => q.ts), ["2026-09-15T00:02:00Z", "2026-09-15T00:01:00Z", "2026-09-15T00:00:00Z"]);
  assert.equal(store.getRecentQuotes(PAIR_A.id, "2026-09-15T00:01:00Z", 10).length, 2);
  assert.equal(store.getRecentQuotes(PAIR_A.id, "2026-09-15T00:00:00Z", 2).length, 2);
  assert.equal(store.getRecentQuotes("nope", "2026-09-15T00:00:00Z", 10).length, 0);
  store.close();
});

test("errorMessage 截断到 500 字符", () => {
  const store = fresh();
  store.insertQuotes([row(PAIR_A.id, "2026-09-15T00:00:00Z", { ok: false, errorCode: "http_4xx", errorMessage: "x".repeat(900) })]);
  assert.equal(store.getRecentQuotes(PAIR_A.id, "2026-09-15T00:00:00Z", 1)[0].errorMessage.length, 500);
  store.close();
});

test("pair_state 往返，且 ok 字段是布尔", () => {
  const store = fresh();
  assert.equal(store.getPairStates().size, 0);
  store.upsertPairState({
    pairId: PAIR_A.id, status: "error", statusSince: "2026-09-15T00:00:00Z",
    lastOkTs: "2026-09-14T23:59:00Z", lastAlertTs: "2026-09-15T00:00:00Z",
    consecutiveFailures: 2, lastMetric: 1501.5,
  });
  const state = store.getPairStates().get(PAIR_A.id);
  assert.equal(state.status, "error");
  assert.equal(state.consecutiveFailures, 2);
  assert.equal(state.lastMetric, 1501.5);
  store.upsertPairState({ ...state, status: "ok", consecutiveFailures: 0 });
  assert.equal(store.getPairStates().get(PAIR_A.id).status, "ok");
  store.close();
});

test("insertQuotes 写入的行读回来是布尔 ok", () => {
  const store = fresh();
  store.insertQuotes([row(PAIR_A.id, "2026-09-15T00:00:00Z"), row(PAIR_A.id, "2026-09-15T00:01:00Z", { ok: false })]);
  const [newest, oldest] = store.getRecentQuotes(PAIR_A.id, "2026-09-15T00:00:00Z", 10);
  assert.equal(newest.ok, false);
  assert.equal(oldest.ok, true);
  assert.equal(oldest.amountIn, "1501.5");
  store.close();
});

test("alerts 写入、过滤、标记已通知", () => {
  const store = fresh();
  const id = store.insertAlert({ ts: "2026-09-15T00:00:00Z", pairId: PAIR_A.id, kind: "error", detail: { errorCode: "http_4xx" }, notified: false });
  store.insertAlert({ ts: "2026-09-15T00:10:00Z", pairId: PAIR_B.id, kind: "recover", detail: {}, notified: true });
  assert.equal(store.getAlerts({}).length, 2);
  assert.equal(store.getAlerts({ since: "2026-09-15T00:05:00Z" }).length, 1);
  assert.equal(store.getAlerts({ limit: 1 }).length, 1);
  assert.equal(store.getAlerts({}).find((a) => a.id === id).notified, false);
  store.markAlertNotified(id, true);
  assert.equal(store.getAlerts({}).find((a) => a.id === id).notified, true);
  store.close();
});

test("getLatestPerPair 每对只返回最新一条并带上状态", () => {
  const store = fresh();
  store.insertQuotes([
    row(PAIR_A.id, "2026-09-15T00:00:00Z"),
    row(PAIR_B.id, "2026-09-15T00:00:30Z"),
    row(PAIR_A.id, "2026-09-15T00:01:00Z", { amountIn: "1600" }),
  ]);
  store.upsertPairState({ pairId: PAIR_A.id, status: "deviant", statusSince: "2026-09-15T00:01:00Z", lastOkTs: null, lastAlertTs: null, consecutiveFailures: 0, lastMetric: 1600 });
  const latest = store.getLatestPerPair();
  assert.equal(latest.length, 2);
  const a = latest.find((r) => r.pairId === PAIR_A.id);
  assert.equal(a.amountIn, "1600");
  assert.equal(a.stateStatus, "deviant");
  assert.equal(latest.find((r) => r.pairId === PAIR_B.id).stateStatus, null, "尚无状态的对应为 null");
  store.close();
});

test("getHistory 支持 pairId / 时间窗 / limit 组合", () => {
  const store = fresh();
  store.insertQuotes([
    row(PAIR_A.id, "2026-09-15T00:00:00Z"),
    row(PAIR_A.id, "2026-09-15T01:00:00Z"),
    row(PAIR_B.id, "2026-09-15T02:00:00Z"),
  ]);
  assert.equal(store.getHistory({}).length, 3, "无过滤条件时返回全部");
  assert.equal(store.getHistory({ pairId: PAIR_A.id }).length, 2);
  assert.equal(store.getHistory({ from: "2026-09-15T00:30:00Z" }).length, 2);
  assert.equal(store.getHistory({ to: "2026-09-15T01:30:00Z" }).length, 2);
  assert.equal(store.getHistory({ pairId: PAIR_A.id, from: "2026-09-15T00:30:00Z", limit: 1 }).length, 1);
  store.close();
});

test("getStats 的 hourly 分支的计数来自小时桶而不是原始表（长窗口在原始数据被清理后才不掉数）", () => {
  const store = fresh();
  store.insertQuotes([
    row(PAIR_A.id, "2026-09-15T00:10:00Z"),// 已聚合进小时桶
    row(PAIR_A.id, "2026-09-15T01:10:00Z"),// 故意未聚合，只存在于原始表
  ]);
  // quotes_hourly 的公开写入接口属于 Task 7；这里直接用 db 造一条桶，专门考「计数从哪个表来」。
  // 不能用公开 API：那正是这条用例要隔离掉的变量。
  store.db.prepare(`
    INSERT INTO quotes_hourly (pair_id, hour, n, ok_n, amount_in_avg, amount_in_min, amount_in_max,
                               amount_out_avg, amount_out_min, amount_out_max, latency_avg_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(PAIR_A.id, "2026-09-15T00:00:00Z", 1, 1, 1501.5, 1501.5, 1501.5, 1500, 1500, 1500, 1000);
  const [entry] = store.getStats({ sinceIso: "2026-09-15T00:00:00Z", resolution: "hourly" }).pairs;
  assert.equal(entry.pairId, PAIR_A.id);
  assert.equal(entry.n, 1, "只应统计已聚合进小时桶的那一条；从原始表取会得 2");
  assert.equal(entry.okN, 1);
  assert.equal(entry.okRate, 1);
  assert.equal(entry.metric.mean, 1501.5);
  assert.equal(entry.latency.mean, 1000);
  store.close();
});

test("meta JSON 往返，缺失时给 fallback", () => {
  const store = fresh();
  assert.equal(store.getMeta("missing"), undefined);
  assert.equal(store.getMeta("missing", 42), 42);
  store.setMeta("last_rollup_hour", "2026-09-15T00:00:00Z");
  store.setMeta("count", 7);
  assert.equal(store.getMeta("last_rollup_hour"), "2026-09-15T00:00:00Z");
  assert.equal(store.getMeta("count"), 7);
  store.setMeta("count", 8);
  assert.equal(store.getMeta("count"), 8, "重复 setMeta 应覆盖");
  store.close();
});

test("getStats（raw 分辨率）算成功率、价格中位数与 p95", () => {
  const store = fresh();
  const at = (m) => `2026-09-15T00:${String(m).padStart(2, "0")}:00Z`;
  store.insertQuotes([
    row(PAIR_A.id, at(0), { amountIn: "100", latencyMs: 1000 }),
    row(PAIR_A.id, at(1), { amountIn: "200", latencyMs: 2000 }),
    row(PAIR_A.id, at(2), { amountIn: "300", latencyMs: 3000 }),
    row(PAIR_A.id, at(3), { amountIn: "400", latencyMs: 4000 }),
    row(PAIR_A.id, at(4), { ok: false, errorCode: "http_4xx", errorMessage: "nope" }),
  ]);
  const stats = store.getStats({ sinceIso: "2026-09-15T00:00:00Z", resolution: "raw" });
  assert.equal(stats.resolution, "raw");
  const a = stats.pairs.find((p) => p.pairId === PAIR_A.id);
  assert.equal(a.n, 5);
  assert.equal(a.okN, 4);
  assert.equal(a.okRate, 0.8);
  assert.equal(a.metric.median, 250);
  assert.equal(a.metric.p95, 400);
  assert.equal(a.metric.min, 100);
  assert.equal(a.metric.max, 400);
  assert.equal(a.latency.median, 2500);
  assert.equal(a.latency.p95, 4000);
  store.close();
});

test("getStats 对 EXACT_INPUT 币对改用 amountOut 作为价格侧", () => {
  const store = openStore(":memory:");
  const pair = { ...PAIR_A, id: "near:USDC>sol:USDC", swapType: "EXACT_INPUT" };
  store.upsertPairs([pair], "2026-09-15T00:00:00Z");
  store.insertQuotes([
    row(pair.id, "2026-09-15T00:00:00Z", { amountIn: "100", amountOut: "999" }),
    row(pair.id, "2026-09-15T00:01:00Z", { amountIn: "100", amountOut: "1001" }),
  ]);
  const [stat] = store.getStats({ sinceIso: "2026-09-15T00:00:00Z", resolution: "raw" }).pairs;
  assert.equal(stat.metric.median, 1000, "应取 amountOut 而不是 amountIn");
  store.close();
});

test("getStats 只统计窗口内且 ok=1 的数据算中位数，但成功率算全部", () => {
  const store = fresh();
  store.insertQuotes([
    row(PAIR_A.id, "2026-09-14T23:00:00Z", { amountIn: "9999" }),
    row(PAIR_A.id, "2026-09-15T00:00:00Z", { amountIn: "100" }),
    row(PAIR_A.id, "2026-09-15T00:01:00Z", { amountIn: "200" }),
  ]);
  const [stat] = store.getStats({ sinceIso: "2026-09-15T00:00:00Z", resolution: "raw" }).pairs;
  assert.equal(stat.n, 2, "窗口外的行不计入成功率的分子分母");
  assert.equal(stat.metric.median, 150);
  store.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— `Cannot find module '../src/store.js'`

- [ ] **Step 3: 实现 `src/store.js`**

```js
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

  getMeta(key, fallback) {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row === undefined ? fallback : JSON.parse(row.value);
  }

  setMeta(key, value) {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
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
```

注意 `average` / `min` / `max` 三个 helper 定义在文件末尾，被 `getStats` 使用（函数声明会提升，位置不影响）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/store.js test/store.test.js
git commit -m "feat: SQLite 存储层，含币对/报价/状态/告警与统计查询"
```

---

### Task 7: 存储维护（小时聚合与保留策略）

**Files:**
- Modify: `src/store.js`（追加 `hourFloorIso` / `hourBucketsBetween` 导出，以及 `Store` 的四个方法）
- Test: `test/store-maintenance.test.js`

**Interfaces:**
- Consumes: Task 6 的 `Store`
- Produces:
  - `hourFloorIso(date: Date): string` —— 向下取整到整点，返回 ISO8601 UTC
  - `hourBucketsBetween(fromIso: string, toIsoExclusive: string): string[]` —— 左闭右开，最多返回 2000 个桶
  - `Store.prototype.rollupHour(hourIso): { pairs: number, rows: number }` —— 幂等（同小时重复跑结果一致）
  - `Store.prototype.rollupHours(fromHourIso, toHourIsoExclusive): { hours: number, rows: number }`
  - `Store.prototype.pruneRaw(beforeIso): number` —— 返回删除行数
  - `Store.prototype.pruneHourly(beforeIso): number`

- [ ] **Step 1: 写失败测试 `test/store-maintenance.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore, hourFloorIso, hourBucketsBetween } from "../src/store.js";

const PAIR = {
  id: "near:USDC>eth:USDC", label: "a → b", fromKey: "near:USDC", toKey: "eth:USDC",
  fromAsset: "x", toAsset: "y", swapType: "EXACT_OUTPUT", amount: "1500",
  amountMinor: "1500000000", fromDecimals: 6, toDecimals: 6,
};
const row = (ts, overrides = {}) => ({
  ts, pairId: PAIR.id, ok: true, latencyMs: 1000, amountIn: "100", amountOut: "99",
  ...overrides,
});

function fresh() {
  const store = openStore(":memory:");
  store.upsertPairs([PAIR], "2026-09-15T00:00:00Z");
  return store;
}

test("hourFloorIso 向下取整到整点", () => {
  assert.equal(hourFloorIso(new Date("2026-09-15T13:45:31.500Z")), "2026-09-15T13:00:00.000Z");
  assert.equal(hourFloorIso(new Date("2026-09-15T00:00:00.000Z")), "2026-09-15T00:00:00.000Z");
});

test("hourBucketsBetween 左闭右开且能跨天", () => {
  assert.deepEqual(
    hourBucketsBetween("2026-09-15T00:00:00.000Z", "2026-09-15T03:00:00.000Z"),
    ["2026-09-15T00:00:00.000Z", "2026-09-15T01:00:00.000Z", "2026-09-15T02:00:00.000Z"],
  );
  assert.deepEqual(hourBucketsBetween("2026-09-15T00:00:00.000Z", "2026-09-15T00:00:00.000Z"), []);
  assert.equal(hourBucketsBetween("2026-09-14T23:00:00.000Z", "2026-09-15T02:00:00.000Z").length, 3);
});

test("rollupHour 聚合出计数、分位与均值", () => {
  const store = fresh();
  store.insertQuotes([
    row("2026-09-15T00:00:00.000Z", { amountIn: "100", latencyMs: 1000 }),
    row("2026-09-15T00:30:00.000Z", { amountIn: "300", latencyMs: 3000 }),
    row("2026-09-15T00:59:59.999Z", { ok: false, errorCode: "timeout", amountIn: null, latencyMs: 2000 }),
  ]);
  const result = store.rollupHour("2026-09-15T00:00:00.000Z");
  assert.deepEqual(result, { pairs: 1, rows: 1 });
  const [bucket] = store.getHistory({ resolution: "hourly" });
  assert.equal(bucket.n, 3);
  assert.equal(bucket.okN, 2);
  assert.equal(bucket.amountInAvg, 200);
  assert.equal(bucket.amountInMin, 100);
  assert.equal(bucket.amountInMax, 300);
  assert.equal(bucket.latencyAvgMs, 2000);
  store.close();
});

test("rollupHour 幂等：重复跑不会重复累加", () => {
  const store = fresh();
  store.insertQuotes([row("2026-09-15T00:00:00.000Z"), row("2026-09-15T00:30:00.000Z")]);
  store.rollupHour("2026-09-15T00:00:00.000Z");
  store.rollupHour("2026-09-15T00:00:00.000Z");
  const [bucket] = store.getHistory({ resolution: "hourly" });
  assert.equal(bucket.n, 2, "第二次应覆盖而不是变成 4");
  store.close();
});

test("没数据的小时不产生空行", () => {
  const store = fresh();
  assert.deepEqual(store.rollupHour("2026-09-15T05:00:00.000Z"), { pairs: 0, rows: 0 });
  assert.equal(store.getHistory({ resolution: "hourly" }).length, 0);
  store.close();
});

test("rollupHours 覆盖一个区间，且跳过无数据的桶", () => {
  const store = fresh();
  store.insertQuotes([row("2026-09-15T00:10:00.000Z"), row("2026-09-15T02:10:00.000Z")]);
  const result = store.rollupHours("2026-09-15T00:00:00.000Z", "2026-09-15T03:00:00.000Z");
  assert.equal(result.hours, 2, "00 点与 02 点各一个桶");
  assert.equal(result.rows, 2);
  assert.equal(store.getHistory({ resolution: "hourly" }).length, 2);
  store.close();
});

test("getStats 的 hourly 分支能读回小时聚合（raw 只覆盖到 24h，7d 靠这条路径）", () => {
  const store = fresh();
  store.insertQuotes([
    row("2026-09-15T00:00:00.000Z", { amountIn: "100", latencyMs: 1000 }),
    row("2026-09-15T00:30:00.000Z", { amountIn: "300", latencyMs: 3000 }),
  ]);
  store.rollupHour("2026-09-15T00:00:00.000Z");
  const stats = store.getStats({ sinceIso: "2026-09-15T00:00:00.000Z", resolution: "hourly" });
  assert.equal(stats.resolution, "hourly");
  const [entry] = stats.pairs;
  assert.equal(entry.pairId, PAIR.id);
  assert.equal(entry.n, 2);
  assert.equal(entry.okN, 2);
  assert.equal(entry.okRate, 1);
  assert.equal(entry.metric.mean, 200);
  assert.equal(entry.metric.min, 100);
  assert.equal(entry.metric.max, 300);
  assert.equal(entry.latency.mean, 2000);
  store.close();
});

test("getStats 的 hourly 分支的计数来自小时桶而不是原始表（长窗口在原始数据被清理后才不掉数）", () => {
  const store = fresh();
  store.insertQuotes([
    row("2026-09-15T00:10:00.000Z"), // 会被聚合进小时桶
    row("2026-09-15T01:10:00.000Z"), // 故意不聚合，只存在于原始表
  ]);
  store.rollupHour("2026-09-15T00:00:00.000Z");
  const stats = store.getStats({ sinceIso: "2026-09-15T00:00:00.000Z", resolution: "hourly" });
  const [entry] = stats.pairs;
  assert.equal(entry.n, 1, "只应统计已聚合进小时桶的那一条；从原始表取会得 2");
  assert.equal(entry.okN, 1);
  assert.equal(entry.okRate, 1);
  store.close();
});

test("pruneRaw 只删窗口之前的数据", () => {
  const store = fresh();
  store.insertQuotes([
    row("2026-09-01T00:00:00.000Z"),
    row("2026-09-14T00:00:00.000Z"),
    row("2026-09-15T00:00:00.000Z"),
  ]);
  // cutoff 取整点：ts < cutoff 的删掉，等于或晚于的留下
  assert.equal(store.pruneRaw("2026-09-14T00:00:00.000Z"), 1);
  assert.deepEqual(store.getHistory({}).map((q) => q.ts),
    ["2026-09-15T00:00:00.000Z", "2026-09-14T00:00:00.000Z"]);
  store.close();
});

test("pruneHourly 只删窗口之前的小时桶", () => {
  const store = fresh();
  store.insertQuotes([row("2026-09-10T00:00:00.000Z"), row("2026-09-15T00:00:00.000Z")]);
  store.rollupHours("2026-09-10T00:00:00.000Z", "2026-09-15T01:00:00.000Z");
  assert.equal(store.getHistory({ resolution: "hourly" }).length, 2);
  assert.equal(store.pruneHourly("2026-09-14T00:00:00.000Z"), 1);
  assert.equal(store.getHistory({ resolution: "hourly" }).length, 1);
  store.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— `hourFloorIso is not a function`

- [ ] **Step 3: 在 `src/store.js` 末尾追加实现**

```js
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
```

然后往 `class Store` 里追加四个方法（插在 `setMeta` 之后、类结束之前）：

```js
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/store.js test/store-maintenance.test.js
git commit -m "feat: 小时聚合与保留策略，聚合幂等"
```

---

### Task 8: 异常判定状态机

**Files:**
- Create: `src/detect.js`
- Test: `test/detect.test.js`

**Interfaces:**
- Consumes: `median`（`src/numeric.js`）
- Produces:
  - `STATUS = { OK: "ok", ERROR: "error", DEVIANT: "deviant" }`
  - `priceMetric(quote, swapType): number | null`
  - `evaluate({ quote, history, prevStatus, detect }): { status, metric, baseline, sampleCount, deviationPct, event }`
    - `event` 为 `null` 或 `{ kind: "error"|"deviation"|"recover", isNew: boolean, detail: object }`
    - **每轮异常都会产出 event**，`isNew` 表示是否为状态迁移。是否真的推送由 `notify` 决定（见 Task 9）

**关键约定**：`history` 是**本轮写入之前**读出的历史报价，因此基准不含当前样本，不会被自己拉偏。`history` 里 `ok === false` 的行不参与基准。

- [ ] **Step 1: 写失败测试 `test/detect.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, priceMetric, STATUS } from "../src/detect.js";

const DETECT = { priceDeviationPct: 10, minSamples: 5, realertMinutes: 30, rollingWindowMinutes: 60 };

const ok = (amountIn, extra = {}) => ({ ok: true, swapType: "EXACT_OUTPUT", amountIn: String(amountIn), amountOut: "1500", ...extra });
const failed = (extra = {}) => ({ ok: false, errorCode: "http_4xx", errorMessage: "tokenOut is not valid", httpStatus: 400, ...extra });
const historyOf = (...amounts) => amounts.map((a) => ok(a));
const stable = historyOf(100, 100, 100, 100, 100);

const run = (quote, { history = stable, prevStatus = STATUS.OK } = {}) =>
  evaluate({ quote, history, prevStatus, detect: DETECT });

test("priceMetric 按 swapType 取不同侧", () => {
  assert.equal(priceMetric({ ok: true, amountIn: "100", amountOut: "99" }, "EXACT_OUTPUT"), 100);
  assert.equal(priceMetric({ ok: true, amountIn: "100", amountOut: "99" }, "EXACT_INPUT"), 99);
});

test("priceMetric 对失败行与不可解析值返回 null", () => {
  assert.equal(priceMetric({ ok: false, amountIn: "100" }, "EXACT_OUTPUT"), null);
  assert.equal(priceMetric({ ok: true, amountIn: "abc" }, "EXACT_OUTPUT"), null);
  assert.equal(priceMetric({ ok: true }, "EXACT_OUTPUT"), null);
});

test("硬失败 → error，且首次为 isNew", () => {
  const out = run(failed(), { prevStatus: STATUS.OK });
  assert.equal(out.status, STATUS.ERROR);
  assert.equal(out.event.kind, "error");
  assert.equal(out.event.isNew, true);
  assert.equal(out.event.detail.errorCode, "http_4xx");
  assert.ok(out.event.detail.errorMessage.includes("tokenOut"));
  assert.equal(out.event.detail.httpStatus, 400);
});

test("持续失败时仍产出 event 但 isNew 为 false（由 notify 负责克制）", () => {
  const out = run(failed(), { prevStatus: STATUS.ERROR });
  assert.equal(out.status, STATUS.ERROR);
  assert.equal(out.event.kind, "error");
  assert.equal(out.event.isNew, false);
});

test("从没观测过（prevStatus 为 null）且失败时也算 isNew", () => {
  const out = run(failed(), { prevStatus: null });
  assert.equal(out.event.isNew, true);
});

test("样本不足时不判定偏离", () => {
  const out = run(ok(999), { history: historyOf(100, 100, 100, 100) });
  assert.equal(out.status, STATUS.OK);
  assert.equal(out.sampleCount, 4);
  assert.equal(out.deviationPct, null);
  assert.equal(out.event, null);
});

test("样本数刚好达到 minSamples 时开始判定", () => {
  const out = run(ok(200), { history: historyOf(100, 100, 100, 100, 100) });
  assert.equal(out.sampleCount, 5);
  assert.equal(out.status, STATUS.DEVIANT);
  assert.equal(out.deviationPct, 100);
});

test("无历史（冷启动）时恒为 ok", () => {
  const out = run(ok(12345), { history: [], prevStatus: null });
  assert.equal(out.status, STATUS.OK);
  assert.equal(out.event, null);
});

test("基准里忽略失败行", () => {
  const history = [ok(100), ok(100), ok(100), ok(100), failed(), failed()];
  const out = run(ok(105), { history });
  assert.equal(out.sampleCount, 4, "只有 4 条成功样本，不足 5 条");
  assert.equal(out.status, STATUS.OK);
  assert.equal(out.deviationPct, null);
});

test("偏离在阈值内不判异常", () => {
  const out = run(ok(109));
  assert.equal(out.status, STATUS.OK);
  assert.equal(out.deviationPct, 9);
  assert.equal(out.event, null);
});

test("偏离刚好等于阈值不判异常（严格大于才算）", () => {
  assert.equal(run(ok(110)).status, STATUS.OK);
  assert.equal(run(ok(110.01)).status, STATUS.DEVIANT);
});

test("变便宜（负向偏离）同样判异常", () => {
  const out = run(ok(50));
  assert.equal(out.status, STATUS.DEVIANT);
  assert.equal(out.deviationPct, -50);
  assert.equal(out.event.kind, "deviation");
  assert.equal(out.event.isNew, true);
});

test("偏离事件带上 metric / baseline / sampleCount", () => {
  const out = run(ok(200));
  assert.deepEqual(out.event.detail, { metric: 200, baseline: 100, deviationPct: 100, sampleCount: 5 });
});

test("EXACT_INPUT 币对用 amountOut 判定（回归）", () => {
  const history = [1, 2, 3, 4, 5].map((n) => ({ ok: true, swapType: "EXACT_INPUT", amountIn: "1000", amountOut: String(99 + n) }));
  // amountOut 基准中位数 102；当前 amountIn 恒定 1000、amountOut 1000 → 偏离 880%
  const out = evaluate({
    quote: { ok: true, swapType: "EXACT_INPUT", amountIn: "1000", amountOut: "1000" },
    history, prevStatus: STATUS.OK, detect: DETECT,
  });
  assert.equal(out.status, STATUS.DEVIANT);
  assert.equal(out.baseline, 102);
  assert.equal(out.metric, 1000);
});

test("从 error 恢复到 ok 产出 recover 事件", () => {
  const out = run(ok(100), { prevStatus: STATUS.ERROR });
  assert.equal(out.status, STATUS.OK);
  assert.equal(out.event.kind, "recover");
  assert.equal(out.event.isNew, true);
});

test("从 deviant 恢复到 ok 产出 recover 事件", () => {
  const out = run(ok(100), { prevStatus: STATUS.DEVIANT });
  assert.equal(out.event.kind, "recover");
});

test("一直 ok 时不产出事件", () => {
  assert.equal(run(ok(100), { prevStatus: STATUS.OK }).event, null);
});

test("从 error 直接变成 deviant 会产出 deviation 事件", () => {
  const out = run(ok(500), { prevStatus: STATUS.ERROR });
  assert.equal(out.status, STATUS.DEVIANT);
  assert.equal(out.event.kind, "deviation");
  assert.equal(out.event.isNew, true);
});

test("当前报价金额不可解析时状态为 ok 且不判定，但能从 error 恢复", () => {
  const out = run({ ok: true, swapType: "EXACT_OUTPUT", amountIn: "abc", amountOut: "1500" }, { prevStatus: STATUS.ERROR });
  assert.equal(out.metric, null);
  assert.equal(out.status, STATUS.OK);
  assert.equal(out.event.kind, "recover");
});

test("阈值可配：调大到 200 后同样的偏离不再报警", () => {
  const out = evaluate({ quote: ok(200), history: stable, prevStatus: STATUS.OK, detect: { ...DETECT, priceDeviationPct: 200 } });
  assert.equal(out.status, STATUS.OK);
  assert.equal(out.deviationPct, 100);
});

test("失败行缺少 errorCode 时给 unknown，不会崩", () => {
  const out = run({ ok: false }, { prevStatus: null });
  assert.equal(out.event.detail.errorCode, "unknown");
  assert.equal(out.event.detail.httpStatus, null);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— `Cannot find module '../src/detect.js'`

- [ ] **Step 3: 实现 `src/detect.js`**

```js
import { median } from "./numeric.js";

export const STATUS = Object.freeze({ OK: "ok", ERROR: "error", DEVIANT: "deviant" });

/**
 * 价格侧由 swapType 决定：固定的是哪一侧，就盯另一侧。
 * EXACT_OUTPUT 固定目标数量，看「要付多少源币」= amountIn；
 * EXACT_INPUT 固定源数量，看「能收到多少目标币」= amountOut。
 */
export function priceMetric(quote, swapType) {
  if (!quote?.ok) return null;
  const raw = swapType === "EXACT_INPUT" ? quote.amountOut : quote.amountIn;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** history 应是本轮写入之前的报价，基准不含当前样本 */
export function evaluate({ quote, history = [], prevStatus = null, detect }) {
  const isFailure = !quote?.ok;
  let status = STATUS.OK;
  let metric = null;
  let baseline = null;
  let sampleCount = 0;
  let deviationPct = null;

  if (isFailure) {
    status = STATUS.ERROR;
  } else {
    metric = priceMetric(quote, quote.swapType);
    const samples = history
      .map((past) => priceMetric(past, quote.swapType))
      .filter((value) => value !== null);
    sampleCount = samples.length;
    baseline = median(samples);
    if (metric !== null && baseline !== null && sampleCount >= detect.minSamples) {
      deviationPct = baseline === 0 ? 0 : ((metric - baseline) / baseline) * 100;
    }
    if (deviationPct !== null && Math.abs(deviationPct) > detect.priceDeviationPct) {
      status = STATUS.DEVIANT;
    }
  }

  let event = null;
  if (status === STATUS.ERROR) {
    event = {
      kind: "error",
      isNew: prevStatus !== STATUS.ERROR,
      detail: {
        errorCode: quote?.errorCode ?? "unknown",
        errorMessage: quote?.errorMessage ?? "未知错误",
        httpStatus: quote?.httpStatus ?? null,
      },
    };
  } else if (status === STATUS.DEVIANT) {
    event = {
      kind: "deviation",
      isNew: prevStatus !== STATUS.DEVIANT,
      detail: { metric, baseline, deviationPct, sampleCount },
    };
  } else if (prevStatus !== null && prevStatus !== STATUS.OK) {
    event = { kind: "recover", isNew: true, detail: { metric, baseline } };
  }

  return { status, metric, baseline, sampleCount, deviationPct, event };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/detect.js test/detect.test.js
git commit -m "feat: 异常判定状态机，价格侧随 swapType 切换"
```

---

### Task 9: 报价请求（构造、解析、错误归类、并发）

**Files:**
- Create: `src/quote.js`
- Test: `test/quote.test.js`

**Interfaces:**
- Consumes: `fetchJson` / `HttpError` / `mapLimit`（`src/http.js`）
- Produces:
  - `class BadShapeError extends Error`，`.code === "bad_shape"`
  - `buildQuoteBody(pair, { deadline, dry?, now? }): object`
  - `parseQuote(payload): object` —— 缺 `quote` 字段或 `amountIn` 不可解析时抛 `BadShapeError`
  - `classifyError(error): { errorCode, errorMessage }` —— 把 `swap limits` 这类 4xx 归为 `limits`
  - `quotePair(pair, { config, deadline, fetchImpl?, timeoutMs?, now? }): Promise<Row>` —— **永不抛错**，失败时返回 `ok:false` 的行
  - `quoteAll(pairs, { config, deadline, fetchImpl?, timeoutMs?, now? }): Promise<Row[]>` —— 保序，每个 pair 恰好一行

- [ ] **Step 1: 写失败测试 `test/quote.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQuoteBody, parseQuote, classifyError, quotePair, quoteAll, BadShapeError } from "../src/quote.js";
import { HttpError } from "../src/http.js";

const PAIR = {
  id: "near:USDC>eth:USDC", label: "near:USDC → eth:USDC",
  fromAsset: "nep141:usdc.near", toAsset: "nep141:eth-usdc.omft.near",
  swapType: "EXACT_OUTPUT", amount: "1500", amountMinor: "1500000000",
  slippageTolerance: 10, confidentiality: "advanced", deadlineMs: 600000,
  refundTo: "monitor.near", recipient: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
};
const CONFIG = { quoteEndpoint: "https://q/v0/quote", concurrency: 2, requestTimeoutMs: 15000 };
const NOW = new Date("2026-09-15T00:00:00.000Z");
const SUCCESS = {
  correlationId: "cid-1",
  quote: {
    amountIn: "1501660000", amountInFormatted: "1501.66", amountInUsd: "1501.5",
    amountOut: "1500000000", amountOutFormatted: "1500", amountOutUsd: "1500",
    minAmountIn: "1500000000", minAmountOut: "1500000000",
    refundFee: "3000", withdrawFee: "0", timeEstimate: 27,
  },
};
const reply = (payload, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) });
const quoteWith = (fetchImpl) => quotePair(PAIR, { config: CONFIG, deadline: "2026-09-15T00:10:00.000Z", fetchImpl, now: NOW });

test("buildQuoteBody 产出参考实现同构的请求体", () => {
  const body = buildQuoteBody(PAIR, { deadline: "2026-09-15T00:10:00.000Z", now: NOW });
  assert.deepEqual(body, {
    dry: true,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 10,
    originAsset: "nep141:usdc.near",
    depositType: "ORIGIN_CHAIN",
    destinationAsset: "nep141:eth-usdc.omft.near",
    amount: "1500000000",
    refundTo: "monitor.near",
    refundType: "ORIGIN_CHAIN",
    recipient: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    recipientType: "DESTINATION_CHAIN",
    deadline: "2026-09-15T00:10:00.000Z",
    confidentiality: "advanced",
  });
});

test("buildQuoteBody 必须带 dry，否则代理会返回 400", () => {
  assert.equal(buildQuoteBody(PAIR, { now: NOW }).dry, true);
});

test("buildQuoteBody 不传 deadline 时按 deadlineMs 算", () => {
  const body = buildQuoteBody(PAIR, { now: NOW });
  assert.equal(body.deadline, "2026-09-15T00:10:00.000Z");
});

test("parseQuote 取出字段并统一转成字符串", () => {
  const parsed = parseQuote(SUCCESS);
  assert.equal(parsed.amountIn, "1501660000");
  assert.equal(parsed.amountOut, "1500000000");
  assert.equal(parsed.amountInUsd, "1501.5");
  assert.equal(parsed.minAmountOut, "1500000000");
  assert.equal(parsed.timeEstimate, 27);
  assert.equal(parsed.correlationId, "cid-1");
});

test("parseQuote 缺字段时把可选项置 null 而不是 undefined", () => {
  const parsed = parseQuote({ quote: { amountIn: 1 } });
  assert.equal(parsed.amountOut, null);
  assert.equal(parsed.amountInUsd, null);
  assert.equal(parsed.correlationId, null);
});

test("parseQuote 对坏形状抛 bad_shape", () => {
  assert.throws(() => parseQuote({ error: "nope" }), (e) => e instanceof BadShapeError && e.code === "bad_shape");
  assert.throws(() => parseQuote({ quote: { amountIn: "not-a-number" } }), BadShapeError);
  assert.throws(() => parseQuote({ quote: { amountOut: "1" } }), BadShapeError, "amountIn 缺失也算坏形状");
  assert.throws(() => parseQuote(null), BadShapeError);
});

test("classifyError 把 swap limits 归为 limits", () => {
  const error = new HttpError("HTTP 400", { code: "http_4xx", status: 400, body: { message: "Temporary swap limits: minimum swap amount is $1,000" } });
  const out = classifyError(error);
  assert.equal(out.errorCode, "limits");
  assert.ok(out.errorMessage.includes("minimum swap amount"));
});

test("classifyError 对其他 4xx 保留 http_4xx", () => {
  const error = new HttpError("HTTP 400", { code: "http_4xx", status: 400, body: { message: "tokenOut is not valid" } });
  assert.equal(classifyError(error).errorCode, "http_4xx");
});

test("classifyError 对无 body 的 4xx 退回 error.message", () => {
  const error = new HttpError("HTTP 400", { code: "http_4xx", status: 400, body: null });
  const out = classifyError(error);
  assert.equal(out.errorCode, "http_4xx");
  assert.ok(out.errorMessage.includes("HTTP 400"));
});

test("classifyError 对 bad_shape 与 timeout 原样传递", () => {
  assert.equal(classifyError(new BadShapeError("x", null)).errorCode, "bad_shape");
  assert.equal(classifyError(new HttpError("y", { code: "timeout" })).errorCode, "timeout");
  assert.equal(classifyError(new HttpError("z", { code: "network" })).errorCode, "network");
});

test("quotePair 成功时产出 ok 行", async () => {
  const row = await quoteWith(reply(SUCCESS, 201));
  assert.equal(row.ok, true);
  assert.equal(row.pairId, PAIR.id);
  assert.equal(row.ts, NOW.toISOString());
  assert.equal(row.httpStatus, 201);
  assert.equal(row.amountIn, "1501660000");
  assert.equal(row.correlationId, "cid-1");
  assert.equal(row.errorCode, null);
  assert.equal(typeof row.latencyMs, "number");
});

test("quotePair 失败时返回 ok:false 的行而绝不抛错", async () => {
  const row = await quoteWith(reply({ message: "Temporary swap limits: minimum swap amount is $1,000" }, 400));
  assert.equal(row.ok, false);
  assert.equal(row.errorCode, "limits");
  assert.equal(row.httpStatus, 400);
  assert.ok(row.errorMessage.includes("minimum swap amount"));
});

test("quotePair 把 5xx / 网络 / 超时 归类而不崩溃", async () => {
  assert.equal((await quoteWith(reply({ error: "down" }, 502))).errorCode, "http_5xx");
  assert.equal((await quoteWith(async () => { throw new TypeError("fetch failed"); })).errorCode, "network");
  const hanging = (_url, { signal }) => new Promise((_r, reject) => signal.addEventListener("abort", () => {
    const e = new Error("aborted"); e.name = "AbortError"; reject(e);
  }));
  const row = await quotePair(PAIR, { config: { ...CONFIG, requestTimeoutMs: 10 }, fetchImpl: hanging, now: NOW });
  assert.equal(row.ok, false);
  assert.equal(row.errorCode, "timeout");
});

test("quotePair 把 201 但缺 quote 字段归为 bad_shape", async () => {
  const row = await quoteWith(reply({ correlationId: "cid" }, 201));
  assert.equal(row.ok, false);
  assert.equal(row.errorCode, "bad_shape");
  assert.equal(row.httpStatus, 201, "HTTP 层面是成功的，需要保留下来才能分辨");
});

test("quotePair 把请求体原样发给端点", async () => {
  let seen;
  await quotePair(PAIR, {
    config: CONFIG, deadline: "2026-09-15T00:10:00.000Z", now: NOW,
    fetchImpl: async (url, init) => {
      seen = { url, method: init.method, headers: init.headers, body: JSON.parse(init.body) };
      return { ok: true, status: 201, text: async () => JSON.stringify(SUCCESS) };
    },
  });
  assert.equal(seen.url, CONFIG.quoteEndpoint);
  assert.equal(seen.method, "POST");
  assert.equal(seen.headers["Content-Type"], "application/json");
  assert.equal(seen.body.dry, true);
  assert.equal(seen.body.amount, "1500000000");
});

test("quoteAll 保序、每对一行、单条失败不拖累其他", async () => {
  const pairs = [
    { ...PAIR, id: "a>b" },
    { ...PAIR, id: "c>d" },
    { ...PAIR, id: "e>f" },
  ];
  let call = 0;
  const rows = await quoteAll(pairs, {
    config: CONFIG, deadline: "2026-09-15T00:10:00.000Z", now: NOW,
    fetchImpl: async () => {
      call += 1;
      const nth = call;
      // 让第 1 个请求最慢完成，确保结果顺序与完成顺序不同
      if (nth === 1) await new Promise((resolve) => setTimeout(resolve, 20));
      return nth === 2
        ? { ok: false, status: 400, text: async () => JSON.stringify({ message: "tokenOut is not valid" }) }
        : { ok: true, status: 201, text: async () => JSON.stringify(SUCCESS) };
    },
  });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.pairId), ["a>b", "c>d", "e>f"], "应按入参顺序回填，而不是按完成顺序");
  assert.equal(rows.filter((r) => !r.ok).length, 1);
  assert.equal(rows.find((r) => !r.ok).errorCode, "http_4xx", "失败应被隔离成一行，不影响其余两条");
});
```

`appFees` / `refundFee` / `withdrawFee` **故意不入库**：spec §2 把它们列为响应字段，但 §5 的数据模型没给它们列。本计划以 §5 为准，因为监控关心的是「报价能不能出、价格偏不偏」，手续费明细属于另一类分析需求，将来要就加列。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— `Cannot find module '../src/quote.js'`

- [ ] **Step 3: 实现 `src/quote.js`**

```js
import { fetchJson, HttpError, mapLimit } from "./http.js";

export class BadShapeError extends Error {
  constructor(message, payload) {
    super(message);
    this.name = "BadShapeError";
    this.code = "bad_shape";
    this.payload = payload;
  }
}

const SWAP_LIMITS = /swap limits/i;

function extractMessage(body) {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return body;
  if (typeof body === "object") return body.message ?? body.error ?? null;
  return String(body);
}

/** 实测：最低额限制也是 400，但语义上是「限额」而不是「路由/参数错误」，因此单独归类 */
export function classifyError(error) {
  if (error instanceof BadShapeError) {
    return { errorCode: "bad_shape", errorMessage: error.message };
  }
  if (error instanceof HttpError && error.code === "http_4xx") {
    const detail = extractMessage(error.body);
    if (detail !== null && SWAP_LIMITS.test(detail)) {
      return { errorCode: "limits", errorMessage: detail };
    }
    return { errorCode: "http_4xx", errorMessage: detail ?? error.message };
  }
  return { errorCode: error?.code ?? "network", errorMessage: error?.message ?? String(error) };
}

export function buildQuoteBody(pair, { deadline, dry = true, now = new Date() } = {}) {
  return {
    dry,
    swapType: pair.swapType,
    slippageTolerance: pair.slippageTolerance,
    originAsset: pair.fromAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: pair.toAsset,
    amount: pair.amountMinor,
    refundTo: pair.refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: pair.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: deadline ?? new Date(now.getTime() + pair.deadlineMs).toISOString(),
    confidentiality: pair.confidentiality,
  };
}

const asText = (value) => (value === null || value === undefined ? null : String(value));

export function parseQuote(payload) {
  const quote = payload?.quote;
  if (quote === null || typeof quote !== "object") {
    throw new BadShapeError("响应缺少 quote 字段", payload);
  }
  const amountIn = quote.amountIn;
  if (amountIn === null || amountIn === undefined || !Number.isFinite(Number(amountIn))) {
    throw new BadShapeError("响应里 amountIn 缺失或不可解析", payload);
  }
  return {
    amountIn: String(amountIn),
    amountInFormatted: asText(quote.amountInFormatted),
    amountInUsd: asText(quote.amountInUsd),
    amountOut: asText(quote.amountOut),
    amountOutFormatted: asText(quote.amountOutFormatted),
    amountOutUsd: asText(quote.amountOutUsd),
    minAmountIn: asText(quote.minAmountIn),
    minAmountOut: asText(quote.minAmountOut),
    timeEstimate: quote.timeEstimate ?? null,
    correlationId: payload.correlationId ?? null,
  };
}

/** 永不抛错：任何失败都以 ok:false 的行返回，避免单条异常拖垮整轮 */
export async function quotePair(pair, { config, deadline, fetchImpl, timeoutMs, now = new Date() } = {}) {
  const ts = now.toISOString();
  const startedAt = Date.now();
  // HTTP 状态码必须在解析前抢下来：bad_shape 是在 HTTP 201 之后才发现的，
  // 如果只在 catch 里从 error 取状态码，这种情况会被误记成 null
  let httpStatus = null;
  try {
    const response = await fetchJson(config.quoteEndpoint, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(buildQuoteBody(pair, { deadline, now })),
      timeoutMs: timeoutMs ?? config.requestTimeoutMs,
      fetchImpl,
    });
    httpStatus = response.status;
    return {
      ts, pairId: pair.id, ok: true,
      httpStatus, latencyMs: response.latencyMs,
      ...parseQuote(response.payload),
      errorCode: null, errorMessage: null,
    };
  } catch (error) {
    const { errorCode, errorMessage } = classifyError(error);
    return {
      ts, pairId: pair.id, ok: false,
      httpStatus: error instanceof HttpError ? error.status : httpStatus,
      latencyMs: Date.now() - startedAt,
      errorCode, errorMessage,
    };
  }
}

export async function quoteAll(pairs, { config, deadline, fetchImpl, timeoutMs, now = new Date() } = {}) {
  const options = { config, deadline, fetchImpl, timeoutMs, now };
  const results = await mapLimit(pairs, config.concurrency, (pair) => quotePair(pair, options));
  // quotePair 不抛错，所以这里的 error 分支只可能是内部 bug（如 pair 结构不对）；仍要产出一行
  return pairs.map((pair, index) => {
    const result = results[index];
    if (result?.ok) return result.value;
    return {
      ts: now.toISOString(), pairId: pair.id, ok: false,
      httpStatus: null, latencyMs: null,
      errorCode: "internal",
      errorMessage: `内部错误: ${result?.error?.message ?? result?.error}`,
    };
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/quote.js test/quote.test.js
git commit -m "feat: 报价请求构造与解析，把最低额限制归为 limits"
```

---

### Task 10: Slack 通知（抑制策略、格式化、发送）

**Files:**
- Create: `src/notify.js`
- Test: `test/notify.test.js`

**Interfaces:**
- Consumes: `fetchJson`（`src/http.js`）
- Produces:
  - `decideEventAction({ event, lastAlertTs, nowIso, realertMinutes }): "send" | "suppress" | "none"`
  - `decideDigestAction({ lastDigestTs, nowIso, hourLocal, enabled }): boolean`
  - `formatEvent(event, pair, { mention?, statusSince?, lastOkTs?, consecutiveFailures? }): string`
  - `formatDigest(summary, { windowHours?, mention? }): string`
  - `createNotifier({ enabled, webhookUrl, timeoutMs?, fetchImpl?, logger? }): { send(text) }` —— `send` 永不抛错，失败返回 `{ ok: false, error }`。**`mention` 不进工厂**，它是格式化的事，由 `formatEvent` / `formatDigest` 接收

- [ ] **Step 1: 写失败测试 `test/notify.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideEventAction, decideDigestAction, formatEvent, formatDigest, createNotifier } from "../src/notify.js";

const PAIR = { id: "near:USDC>eth:USDC", label: "near:USDC → eth:USDC", swapType: "EXACT_OUTPUT" };
const EVENT = { kind: "error", isNew: true, detail: { errorCode: "limits", errorMessage: "minimum swap amount is $1,000", httpStatus: 400 } };
const DEVIATION = { kind: "deviation", isNew: true, detail: { metric: 200, baseline: 100, deviationPct: 100, sampleCount: 5 } };

// 用本地时间构造时间戳，使断言不依赖 TZ
const LOCAL = (hour, minutes = 0, dayOffset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minutes, 0, 0);
  return d.toISOString();
};

test("边沿：状态迁移必发", () => {
  assert.equal(decideEventAction({ event: EVENT, lastAlertTs: LOCAL(0), nowIso: LOCAL(0, 1), realertMinutes: 30 }), "send");
});

test("边沿：持续异常在 realertMinutes 内被抑制", () => {
  const event = { ...EVENT, isNew: false };
  assert.equal(decideEventAction({ event, lastAlertTs: LOCAL(0, 0), nowIso: LOCAL(0, 10), realertMinutes: 30 }), "suppress");
});

test("边沿：超过 realertMinutes 后重新提醒", () => {
  const event = { ...EVENT, isNew: false };
  assert.equal(decideEventAction({ event, lastAlertTs: LOCAL(0, 0), nowIso: LOCAL(0, 30), realertMinutes: 30 }), "send");
  assert.equal(decideEventAction({ event, lastAlertTs: LOCAL(0, 0), nowIso: LOCAL(0, 29), realertMinutes: 30 }), "suppress");
});

test("边沿：持续异常但从未告警过时直接发", () => {
  assert.equal(decideEventAction({ event: { ...EVENT, isNew: false }, lastAlertTs: null, nowIso: LOCAL(0), realertMinutes: 30 }), "send");
});

test("边沿：恢复必发，不受 realertMinutes 抑制", () => {
  const recover = { kind: "recover", isNew: true, detail: {} };
  assert.equal(decideEventAction({ event: recover, lastAlertTs: LOCAL(0, 0), nowIso: LOCAL(0, 1), realertMinutes: 30 }), "send");
});

test("没有事件时不做任何事", () => {
  assert.equal(decideEventAction({ event: null, lastAlertTs: null, nowIso: LOCAL(0), realertMinutes: 30 }), "none");
});

test("日汇总：关掉时永不发", () => {
  assert.equal(decideDigestAction({ enabled: false, lastDigestTs: null, nowIso: LOCAL(9), hourLocal: 9 }), false);
});

test("日汇总：只在配置的那个本地小时发", () => {
  assert.equal(decideDigestAction({ enabled: true, lastDigestTs: null, nowIso: LOCAL(9), hourLocal: 9 }), true);
  assert.equal(decideDigestAction({ enabled: true, lastDigestTs: null, nowIso: LOCAL(10), hourLocal: 9 }), false);
});

test("日汇总：一天内不重发（重启不会补发一堆）", () => {
  assert.equal(decideDigestAction({ enabled: true, lastDigestTs: LOCAL(9, 0, -1), nowIso: LOCAL(9, 5), hourLocal: 9 }), false);
  assert.equal(decideDigestAction({ enabled: true, lastDigestTs: LOCAL(9, 0, -2), nowIso: LOCAL(9, 5), hourLocal: 9 }), true);
});

test("错误消息包含图标、币对、错误码与原文", () => {
  const text = formatEvent(EVENT, PAIR, { consecutiveFailures: 3, lastOkTs: "2026-09-14T23:59:00.000Z" });
  assert.ok(text.includes(":red_circle:"));
  assert.ok(text.includes("near:USDC → eth:USDC"));
  assert.ok(text.includes("limits"));
  assert.ok(text.includes("minimum swap amount is $1,000"));
  assert.ok(text.includes("连续失败 3 次"));
});

test("偏离消息带上 metric 名称、基准、百分比与样本数", () => {
  const text = formatEvent(DEVIATION, PAIR);
  assert.ok(text.includes(":large_yellow_circle:"));
  assert.ok(text.includes("amountIn"));
  assert.ok(text.includes("+100.00%"));
  assert.ok(text.includes("样本 5"));
});

test("EXACT_INPUT 币对的偏离消息说 amountOut", () => {
  const text = formatEvent(DEVIATION, { ...PAIR, swapType: "EXACT_INPUT" });
  assert.ok(text.includes("amountOut"));
  assert.ok(!text.includes("amountIn"));
});

test("恢复消息带上异常持续时长", () => {
  const text = formatEvent({ kind: "recover", isNew: true, detail: {} }, PAIR, { statusSince: "2026-09-15T00:00:00.000Z" });
  assert.ok(text.includes(":large_green_circle:"));
  assert.ok(text.includes("已恢复"));
});

test("mention 被加到消息开头", () => {
  const text = formatEvent(EVENT, PAIR, { mention: "<!channel>" });
  assert.ok(text.startsWith("<!channel> "));
});

test("日汇总消息带上成功率与最差币对", () => {
  const text = formatDigest({
    windowHours: 24, pairCount: 38, totalRounds: 54720, okRounds: 54300, okRate: 0.9923,
    worst: [{ pairId: "a>b", label: "near:USDC → bsc:USDC", failures: 1440 }],
    latencyP95: 2100,
  });
  assert.ok(text.includes("99.2%"));
  assert.ok(text.includes("near:USDC → bsc:USDC"));
  assert.ok(text.includes("1440"));
  assert.ok(text.includes("2100"));
});

test("日汇总在成功率为 null 时不崩", () => {
  const text = formatDigest({ windowHours: 24, pairCount: 0, totalRounds: 0, okRounds: 0, okRate: null, worst: [], latencyP95: null });
  assert.ok(text.includes("0 对"));
});

test("notifier 禁用时不发请求，但把消息写进日志", async () => {
  const logged = [];
  let called = false;
  const notifier = createNotifier({
    enabled: false, webhookUrl: "https://hooks.slack.com/x",
    fetchImpl: async () => { called = true; },
    logger: { info: (m) => logged.push(m), warn: () => {}, error: () => {} },
  });
  const result = await notifier.send("hello");
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(called, false);
  assert.ok(logged.some((line) => line.includes("hello")));
});

test("notifier 把 { text } POST 到 webhook", async () => {
  let seen;
  const notifier = createNotifier({
    enabled: true, webhookUrl: "https://hooks.slack.com/x",
    fetchImpl: async (url, init) => { seen = { url, method: init.method, body: JSON.parse(init.body) }; return { ok: true, status: 200, text: async () => "ok" }; },
  });
  const result = await notifier.send("hello");
  assert.equal(result.ok, true);
  assert.equal(seen.url, "https://hooks.slack.com/x");
  assert.equal(seen.method, "POST");
  assert.deepEqual(seen.body, { text: "hello" });
});

test("notifier 把发送失败返回成 ok:false 而不抛错", async () => {
  const errors = [];
  const notifier = createNotifier({
    enabled: true, webhookUrl: "https://hooks.slack.com/x",
    fetchImpl: async () => { throw new TypeError("fetch failed"); },
    logger: { info: () => {}, warn: () => {}, error: (m) => errors.push(m) },
  });
  const result = await notifier.send("hello");
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("fetch failed"));
  assert.equal(errors.length, 1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— `Cannot find module '../src/notify.js'`

- [ ] **Step 3: 实现 `src/notify.js`**

```js
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
```

注：`createNotifier` 的 `mention` 参数不在工厂里用——`mention` 是**格式化**的事，由 `formatEvent` / `formatDigest` 接收。工厂只负责发送。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/notify.js test/notify.test.js
git commit -m "feat: Slack 通知，边沿触发抑制与日汇总"
```

---

### Task 11: 只读 HTTP API

**Files:**
- Create: `src/server.js`
- Test: `test/server.test.js`

**Interfaces:**
- Consumes: Task 6/7 的 `Store`
- Produces:
  - `createServer({ store, config, healthSnapshot, logger? }): http.Server`
  - `healthSnapshot()` 返回 `{ startedAt, lastRoundTs, lastRoundDurationMs, consecutiveRoundErrors, pairs }`
  - 端点：`/health`、`/pairs`、`/latest?status=`、`/history?pair=&from=&to=&limit=&res=`、`/stats?window=1h|24h|7d`、`/alerts?limit=&since=`

- [ ] **Step 1: 写失败测试 `test/server.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { openStore } from "../src/store.js";
import { createServer } from "../src/server.js";

const PAIR = {
  id: "near:USDC>eth:USDC", label: "near:USDC → eth:USDC", fromKey: "near:USDC", toKey: "eth:USDC",
  fromAsset: "x", toAsset: "y", swapType: "EXACT_OUTPUT", amount: "1500",
  amountMinor: "1500000000", fromDecimals: 6, toDecimals: 6,
};
const row = (ts, overrides = {}) => ({
  ts, pairId: PAIR.id, ok: true, httpStatus: 201, latencyMs: 1000,
  amountIn: "1501.5", amountOut: "1500", ...overrides,
});

async function withServer({ bearerToken = "", health, cors = "*" } = {}, seed = () => {}) {
  const store = openStore(":memory:");
  store.upsertPairs([PAIR], "2026-09-15T00:00:00Z");
  seed(store);
  const config = { intervalSec: 60, server: { host: "127.0.0.1", port: 0, cors, bearerToken } };
  const server = createServer({
    store, config,
    healthSnapshot: health ?? (() => ({ startedAt: "2026-09-15T00:00:00.000Z", lastRoundTs: new Date().toISOString(), lastRoundDurationMs: 1200, consecutiveRoundErrors: 0, pairs: 1 })),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    config,
    async get(path, init) { return fetch(`${base}${path}`, init); },
    async close() { server.close(); await once(server, "close"); store.close(); },
  };
}

test("GET /health 新鲜时 200", async () => {
  const ctx = await withServer();
  const res = await ctx.get("/health");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.pairs, 1);
  await ctx.close();
});

test("GET /health 超过 3 倍 intervalSec 未采集时 503", async () => {
  const stale = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const ctx = await withServer({ health: () => ({ startedAt: stale, lastRoundTs: stale, lastRoundDurationMs: 1, consecutiveRoundErrors: 3, pairs: 1 }) });
  const res = await ctx.get("/health");
  assert.equal(res.status, 503);
  assert.equal((await res.json()).ok, false);
  await ctx.close();
});

test("GET /pairs 返回白名单及状态", async () => {
  const ctx = await withServer({}, (store) => {
    store.upsertPairState({ pairId: PAIR.id, status: "error", statusSince: "2026-09-15T00:00:00Z", consecutiveFailures: 2 });
  });
  const body = await (await ctx.get("/pairs")).json();
  assert.equal(body.pairs.length, 1);
  assert.equal(body.pairs[0].state.status, "error");
  await ctx.close();
});

test("GET /latest 返回每对最新一条，并支持 status 过滤", async () => {
  const ctx = await withServer({}, (store) => {
    store.insertQuotes([row("2026-09-15T00:00:00Z", { amountIn: "1" }), row("2026-09-15T00:01:00Z", { amountIn: "2" })]);
    store.upsertPairState({ pairId: PAIR.id, status: "error", statusSince: "2026-09-15T00:01:00Z", consecutiveFailures: 1 });
  });
  const all = await (await ctx.get("/latest")).json();
  assert.equal(all.latest.length, 1);
  assert.equal(all.latest[0].amountIn, "2");
  assert.equal((await (await ctx.get("/latest?status=error")).json()).latest.length, 1);
  assert.equal((await (await ctx.get("/latest?status=ok")).json()).latest.length, 0);
  await ctx.close();
});

test("GET /history 支持 limit 与时间窗", async () => {
  const ctx = await withServer({}, (store) => {
    store.insertQuotes([row("2026-09-15T00:00:00Z"), row("2026-09-15T00:01:00Z"), row("2026-09-15T00:02:00Z")]);
  });
  const limited = await (await ctx.get("/history?limit=2")).json();
  assert.equal(limited.rows.length, 2);
  assert.equal(limited.resolution, "raw");
  const from = await (await ctx.get("/history?from=2026-09-15T00:01:00Z")).json();
  assert.equal(from.rows.length, 2);
  await ctx.close();
});

test("GET /history 的 limit 非法时回退到默认值", async () => {
  const ctx = await withServer({}, (store) => {
    store.insertQuotes([row("2026-09-15T00:00:00Z"), row("2026-09-15T00:01:00Z")]);
  });
  assert.equal((await (await ctx.get("/history?limit=abc")).json()).rows.length, 2);
  assert.equal((await (await ctx.get("/history?limit=-5")).json()).rows.length, 2);
  await ctx.close();
});

test("GET /stats 支持 1h / 24h / 7d，非法 window 返回 400", async () => {
  const ctx = await withServer({}, (store) => {
    store.insertQuotes([row(new Date().toISOString(), { amountIn: "1501.5" })]);
  });
  const oneHour = await (await ctx.get("/stats?window=1h")).json();
  assert.equal(oneHour.window, "1h");
  assert.equal(oneHour.pairs.length, 1);
  assert.equal(oneHour.pairs[0].n, 1);
  assert.equal((await (await ctx.get("/stats?window=24h")).json()).resolution, "raw");
  assert.equal((await (await ctx.get("/stats?window=7d")).json()).resolution, "hourly", "7d 走小时聚合以免拉百万行原始数据");
  assert.equal((await ctx.get("/stats?window=bogus")).status, 400);
  await ctx.close();
});

test("GET /alerts 支持 limit", async () => {
  const ctx = await withServer({}, (store) => {
    store.insertAlert({ ts: "2026-09-15T00:00:00Z", pairId: PAIR.id, kind: "error", detail: { a: 1 }, notified: true });
    store.insertAlert({ ts: "2026-09-15T00:01:00Z", pairId: PAIR.id, kind: "recover", detail: {}, notified: true });
  });
  assert.equal((await (await ctx.get("/alerts")).json()).alerts.length, 2);
  assert.equal((await (await ctx.get("/alerts?limit=1")).json()).alerts.length, 1);
  await ctx.close();
});

test("未知端点返回 404，非 GET 返回 405", async () => {
  const ctx = await withServer();
  assert.equal((await ctx.get("/nope")).status, 404);
  assert.equal((await ctx.get("/health", { method: "POST" })).status, 405);
  await ctx.close();
});

test("带尾斜杠的路径也能匹配", async () => {
  const ctx = await withServer();
  assert.equal((await ctx.get("/health/")).status, 200);
  assert.equal((await ctx.get("/")).status, 404);
  await ctx.close();
});

test("CORS 头存在，OPTIONS 预检返回 204", async () => {
  const ctx = await withServer({ cors: "https://panel.example.com" });
  const res = await ctx.get("/health");
  assert.equal(res.headers.get("access-control-allow-origin"), "https://panel.example.com");
  const preflight = await ctx.get("/health", { method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, OPTIONS");
  await ctx.close();
});

test("配了 bearerToken 时未授权返回 401，带对了返回 200", async () => {
  const ctx = await withServer({ bearerToken: "s3cret" });
  assert.equal((await ctx.get("/health")).status, 401);
  assert.equal((await ctx.get("/health", { headers: { Authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await ctx.get("/health", { headers: { Authorization: "Bearer s3cret" } })).status, 200);
  await ctx.close();
});

test("没配 bearerToken 时不校验", async () => {
  const ctx = await withServer({ bearerToken: "" });
  assert.equal((await ctx.get("/health")).status, 200);
  await ctx.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— `Cannot find module '../src/server.js'`

- [ ] **Step 3: 实现 `src/server.js`**

```js
import { createServer as createHttpServer } from "node:http";

/** 非法 limit 回退到 fallback，过大则封顶，避免被人一句 ?limit=99999999 把库拉爆 */
function clampLimit(raw, fallback, maximum) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), maximum);
}

const STATS_WINDOWS = { "1h": 3600e3, "24h": 86400e3, "7d": 7 * 86400e3 };
const HOURLY_THRESHOLD_MS = 25 * 3600e3;

function handle({ url, send, store, config, healthSnapshot }) {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const query = url.searchParams;

  switch (path) {
    case "/health": {
      const health = healthSnapshot();
      const stale = !health.lastRoundTs || Date.now() - Date.parse(health.lastRoundTs) > config.intervalSec * 1000 * 3;
      send(stale ? 503 : 200, { ok: !stale, ...health });
      return;
    }
    case "/pairs":
      send(200, { pairs: store.getPairsWithState() });
      return;
    case "/latest": {
      const status = query.get("status");
      const latest = store.getLatestPerPair();
      send(200, { latest: status ? latest.filter((row) => row.stateStatus === status) : latest });
      return;
    }
    case "/history": {
      const resolution = query.get("res") === "hourly" ? "hourly" : "raw";
      const rows = store.getHistory({
        pairId: query.get("pair") ?? undefined,
        from: query.get("from") ?? undefined,
        to: query.get("to") ?? undefined,
        limit: clampLimit(query.get("limit"), 1000, 5000),
        resolution,
      });
      send(200, { resolution, rows });
      return;
    }
    case "/stats": {
      const window = query.get("window") ?? "1h";
      const windowMs = STATS_WINDOWS[window];
      if (!windowMs) {
        send(400, { error: `window 只支持 1h | 24h | 7d，收到 ${JSON.stringify(window)}` });
        return;
      }
      const sinceIso = new Date(Date.now() - windowMs).toISOString();
      const resolution = windowMs >= HOURLY_THRESHOLD_MS ? "hourly" : "raw";
      send(200, { window, since: sinceIso, ...store.getStats({ sinceIso, resolution }) });
      return;
    }
    case "/alerts":
      send(200, {
        alerts: store.getAlerts({
          limit: clampLimit(query.get("limit"), 100, 1000),
          since: query.get("since") ?? undefined,
        }),
      });
      return;
    default:
      send(404, { error: `未知端点 ${path}` });
  }
}

export function createServer({ store, config, healthSnapshot = () => ({}), logger = console }) {
  return createHttpServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": config.server.cors,
      Vary: "Origin",
      "Cache-Control": "no-store",
    };
    const send = (status, payload) => {
      response.writeHead(status, headers);
      response.end(JSON.stringify(payload));
    };

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        ...headers,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "600",
      });
      response.end();
      return;
    }

    if (request.method !== "GET") {
      send(405, { error: `只支持 GET，收到 ${request.method}` });
      return;
    }

    if (config.server.bearerToken) {
      const provided = request.headers.authorization ?? "";
      if (provided !== `Bearer ${config.server.bearerToken}`) {
        send(401, { error: "未授权：需要 Authorization: Bearer <token>" });
        return;
      }
    }

    try {
      handle({ url, send, store, config, healthSnapshot });
    } catch (error) {
      logger.error(`[server] ${url.pathname} 处理失败: ${error?.stack ?? error?.message ?? error}`);
      send(500, { error: error?.message ?? "内部错误" });
    }
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/server.js test/server.test.js
git commit -m "feat: 只读 HTTP API，CORS 与可选 Bearer"
```

---

### Task 12: 主流程装配

**Files:**
- Create: `src/index.js`
- Test: `test/index.test.js`

**Interfaces:**
- Consumes: 前面所有模块
- Produces:
  - `parseArgs(argv): { once, notify, configPath, dataPath, help }`
  - `createLogger(stream?): { info, warn, error }`
  - `createWakeup(): { wait(ms), interrupt() }` —— 可被中断的 sleep，让 Ctrl-C 能立即退出而不是等完一分钟
  - `loadPairs({ config, fetchImpl, logger }): Promise<ResolvedPair[]>`
  - `runRound(ctx): Promise<summary>`，`ctx = { config, pairs, store, notifier, logger, fetchImpl?, metrics?, now? }`
  - `runMaintenance(ctx): Promise<void>`
  - `main(argv?, deps?): Promise<number>` —— 返回退出码
  - CLI：`--once` `--no-notify` `--config <path>` `--data <path>` `--help`

- [ ] **Step 1: 写失败测试 `test/index.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, createWakeup, createLogger, loadPairs, runRound } from "../src/index.js";
import { openStore } from "../src/store.js";
import { ConfigError } from "../src/config.js";

const PAIR_A = {
  id: "near:USDC>eth:USDC", label: "near:USDC → eth:USDC", fromKey: "near:USDC", toKey: "eth:USDC",
  fromAsset: "nep141:usdc.near", toAsset: "nep141:eth-usdc.omft.near",
  swapType: "EXACT_OUTPUT", amount: "1500", amountMinor: "1500000000",
  fromDecimals: 6, toDecimals: 6, slippageTolerance: 10, confidentiality: "advanced", deadlineMs: 600000,
  refundTo: "monitor.near", recipient: "0xADDR",
};
const PAIR_B = { ...PAIR_A, id: "near:USDC>sol:USDC", label: "near:USDC → sol:USDC", toKey: "sol:USDC", recipient: "soladdr" };

const CONFIG = {
  intervalSec: 60, concurrency: 5, requestTimeoutMs: 15000,
  quoteEndpoint: "https://q/v0/quote",
  tokensSources: { stableflow: "https://sf/pay/tokens", oneclick: "https://oc/v0/tokens" },
  defaults: { swapType: "EXACT_OUTPUT", slippageTolerance: 10, confidentiality: "advanced", deadlineMs: 600000 },
  defaultAmounts: { USDC: "1500" },
  addresses: { near: "monitor.near", eth: "0xADDR", sol: "soladdr" },
  pairs: [{ from: "near:USDC", to: "eth:USDC" }, { from: "near:USDC", to: "sol:USDC" }],
  detect: { priceDeviationPct: 10, minSamples: 5, realertMinutes: 30, rollingWindowMinutes: 60 },
  slack: { enabled: true, mention: "", digest: { enabled: false, hourLocal: 9 } },
  retention: { rawDays: 14, hourlyDays: 0 },
  server: { host: "127.0.0.1", port: 0, cors: "*", bearerToken: "" },
};

const QUIET = { info: () => {}, warn: () => {}, error: () => {} };
const T = (minutes) => new Date(Date.parse("2026-09-15T00:00:00.000Z") + minutes * 60000);

test("parseArgs 默认值", () => {
  assert.deepEqual(parseArgs([]), { once: false, notify: true, configPath: "config.json", dataPath: "data/monitor.db", help: false });
});

test("parseArgs 解析各个开关", () => {
  assert.deepEqual(parseArgs(["--once", "--no-notify", "--config", "a.json", "--data", "b.db"]), {
    once: true, notify: false, configPath: "a.json", dataPath: "b.db", help: false,
  });
  assert.equal(parseArgs(["--config=a.json"]).configPath, "a.json");
  assert.equal(parseArgs(["-h"]).help, true);
});

test("parseArgs 对未知参数报错", () => {
  assert.throws(() => parseArgs(["--wat"]), (e) => e instanceof ConfigError && e.message.includes("--wat"));
});

test("createWakeup 到点自行唤醒", async () => {
  const wakeup = createWakeup();
  const startedAt = Date.now();
  await wakeup.wait(20);
  assert.ok(Date.now() - startedAt >= 15);
});

test("createWakeup 被 interrupt 时立即唤醒（Ctrl-C 不用等满一分钟）", async () => {
  const wakeup = createWakeup();
  const startedAt = Date.now();
  setTimeout(() => wakeup.interrupt(), 5);
  await wakeup.wait(60000);
  assert.ok(Date.now() - startedAt < 1000);
});

test("createWakeup 的 wait(0) 立即返回", async () => {
  await createWakeup().wait(0);
});

test("createLogger 带上时间戳与级别", () => {
  const lines = [];
  const logger = createLogger({ log: (line) => lines.push(line) });
  logger.warn("attention");
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes("[WARN]"));
  assert.ok(lines[0].includes("attention"));
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(lines[0]));
});

test("loadPairs 从两个 token 列表构造出币对", async () => {
  const stableflow = { code: 200, data: [
    { network: "near", symbol: "USDC", decimals: 6, contract_address: "usdc.near", support_payment: true, support_receive: true },
    { network: "eth", symbol: "USDC", decimals: 6, contract_address: "0xA0b8", support_payment: true, support_receive: true },
    { network: "sol", symbol: "USDC", decimals: 6, contract_address: "So1", support_payment: true, support_receive: true },
  ] };
  const oneclick = [{ blockchain: "near", contractAddress: "usdc.near", assetId: "nep141:usdc.near" }];
  const fetchImpl = async (url) => (String(url).includes("pay/tokens")
    ? { ok: true, status: 200, text: async () => JSON.stringify(stableflow) }
    : { ok: true, status: 200, text: async () => JSON.stringify(oneclick) });
  const pairs = await loadPairs({ config: CONFIG, fetchImpl, logger: QUIET });
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].id, "near:USDC>eth:USDC");
  assert.equal(pairs[0].amountMinor, "1500000000");
  assert.equal(pairs[1].id, "near:USDC>sol:USDC");
});

test("loadPairs 在 oneclick 挂掉时降级而不是失败", async () => {
  const stableflow = { code: 200, data: [
    { network: "near", symbol: "USDC", decimals: 6, contract_address: "usdc.near", support_payment: true, support_receive: true },
    { network: "eth", symbol: "USDC", decimals: 6, contract_address: "0xA0b8", support_payment: true, support_receive: true },
    { network: "sol", symbol: "USDC", decimals: 6, contract_address: "So1", support_payment: true, support_receive: true },
  ] };
  const warnings = [];
  const fetchImpl = async (url) => {
    if (String(url).includes("pay/tokens")) return { ok: true, status: 200, text: async () => JSON.stringify(stableflow) };
    throw new TypeError("oc down");
  };
  const pairs = await loadPairs({ config: CONFIG, fetchImpl, logger: { ...QUIET, warn: (m) => warnings.push(m) } });
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0].fromAsset, "nep141:usdc.near", "应回退到本地拼接");
  assert.equal(warnings.length, 1);
});

test("loadPairs 在 StableFlow 列表格式异常时抛配置错误", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 500, message: "boom" }) });
  await assert.rejects(loadPairs({ config: CONFIG, fetchImpl, logger: QUIET }), ConfigError);
});

function makeCtx({ fetchImpl, now, store = openStore(":memory:"), notifier } = {}) {
  const pairs = [PAIR_A, PAIR_B];
  store.upsertPairs(pairs, "2026-09-15T00:00:00.000Z");
  const sent = [];
  return {
    sent,
    store,
    ctx: {
      config: CONFIG, pairs, store, logger: QUIET, fetchImpl, now,
      notifier: notifier ?? { send: async (text) => { sent.push(text); return { ok: true }; } },
      metrics: {},
    },
  };
}

const okFetch = (amountIn) => async (_url, init) => ({
  ok: true, status: 201,
  text: async () => JSON.stringify({
    correlationId: "cid",
    quote: {
      amountIn: String(amountIn), amountInFormatted: "x", amountInUsd: "1",
      amountOut: JSON.parse(init.body).amount, amountOutFormatted: "y", amountOutUsd: "1",
      minAmountIn: String(amountIn), minAmountOut: JSON.parse(init.body).amount, timeEstimate: 10,
    },
  }),
});
const failFetch = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ message: "tokenOut is not valid" }) });

test("runRound 成功时写入两行、状态为 ok、不发告警", async () => {
  const { ctx, store, sent } = makeCtx({ fetchImpl: okFetch(100), now: T(0) });
  const summary = await runRound(ctx);
  assert.equal(summary.ok, 2);
  assert.equal(summary.error, 0);
  assert.equal(summary.alertsSent, 0);
  assert.equal(store.getHistory({}).length, 2);
  assert.equal(store.getPairStates().get(PAIR_A.id).status, "ok");
  assert.equal(store.getPairStates().get(PAIR_A.id).lastOkTs, T(0).toISOString());
  assert.deepEqual(sent, []);
  store.close();
});

test("runRound 失败时写 error 状态、落 alerts 并发一条 Slack", async () => {
  const { ctx, store, sent } = makeCtx({ fetchImpl: failFetch, now: T(0) });
  const summary = await runRound(ctx);
  assert.equal(summary.error, 2);
  assert.equal(summary.alertsSent, 2);
  assert.equal(sent.length, 2);
  assert.ok(sent[0].includes("报价失败"));
  const state = store.getPairStates().get(PAIR_A.id);
  assert.equal(state.status, "error");
  assert.equal(state.consecutiveFailures, 1);
  assert.equal(state.lastAlertTs, T(0).toISOString());
  assert.equal(store.getAlerts({}).length, 2);
  store.close();
});

test("runRound 连续失败时第二轮被抑制，alerts 仍然落库", async () => {
  const { ctx, store, sent } = makeCtx({ fetchImpl: failFetch, now: T(0) });
  await runRound(ctx);
  ctx.now = T(1);
  const second = await runRound(ctx);
  assert.equal(second.alertsSent, 0, "T(0) → T(1) 只过了一分钟，仍在 realertMinutes 内");
  assert.equal(sent.length, 2, "只有第一轮发了");
  assert.equal(store.getAlerts({}).length, 4, "两轮各落两条事件，只是没推");
  assert.equal(store.getPairStates().get(PAIR_A.id).consecutiveFailures, 2);
  store.close();
});

test("runRound 超过 realertMinutes 后重新提醒", async () => {
  const { ctx, store, sent } = makeCtx({ fetchImpl: failFetch, now: T(0) });
  await runRound(ctx);
  ctx.now = T(31);
  const second = await runRound(ctx);
  assert.equal(second.alertsSent, 2);
  assert.equal(sent.length, 4);
  store.close();
});

test("runRound 从 error 恢复时发 recover 并清零连续失败", async () => {
  const { ctx, store, sent } = makeCtx({ fetchImpl: failFetch, now: T(0) });
  await runRound(ctx);
  ctx.fetchImpl = okFetch(100);
  ctx.now = T(1);
  await runRound(ctx);
  assert.equal(sent.length, 4, "2 条 error + 2 条 recover");
  assert.ok(sent[2].includes("已恢复"));
  const state = store.getPairStates().get(PAIR_A.id);
  assert.equal(state.status, "ok");
  assert.equal(state.consecutiveFailures, 0);
  store.close();
});

test("runRound 用写入前的历史做基准，所以第六轮才开始判偏离", async () => {
  const { ctx, store, sent } = makeCtx({ fetchImpl: okFetch(100), now: T(0) });
  for (let round = 0; round < 5; round += 1) {
    ctx.fetchImpl = okFetch(100);
    ctx.now = T(round);
    const summary = await runRound(ctx);
    assert.equal(summary.deviant, 0, `第 ${round + 1} 轮样本不足，不应判偏离`);
  }
  // 此时库里已有 5 条历史；下一轮给出 200 的 amountIn，基准中位数 100 → 偏离 100%
  ctx.fetchImpl = okFetch(200);
  ctx.now = T(5);
  const summary = await runRound(ctx);
  assert.equal(summary.deviant, 2);
  assert.equal(sent.length, 2);
  assert.ok(sent[0].includes("报价偏离"));
  assert.equal(store.getPairStates().get(PAIR_A.id).status, "deviant");
  assert.equal(store.getPairStates().get(PAIR_A.id).lastMetric, 200);
  store.close();
});

test("runRound 把请求体发到配置的端点，并带上 dry", async () => {
  const seen = [];
  const { ctx, store } = makeCtx({
    now: T(0),
    fetchImpl: async (url, init) => { seen.push({ url, body: JSON.parse(init.body) }); return okFetch(100)(url, init); },
  });
  await runRound(ctx);
  assert.equal(seen.length, 2);
  assert.equal(new Set(seen.map((s) => s.url)).size, 1);
  assert.equal(seen[0].url, CONFIG.quoteEndpoint);
  assert.ok(seen.every((s) => s.body.dry === true), "每一条都必须带 dry，否则代理返回 400");
  assert.ok(seen.every((s) => s.body.amount === "1500000000"));
  store.close();
});

test("runRound 在 Slack 发送失败时不把它算作已告警", async () => {
  const failing = { send: async () => ({ ok: false, error: "boom" }) };
  const { ctx, store } = makeCtx({ fetchImpl: failFetch, now: T(0), notifier: failing });
  const summary = await runRound(ctx);
  assert.equal(summary.alertsSent, 0);
  assert.equal(store.getPairStates().get(PAIR_A.id).lastAlertTs, null, "发送失败则不应记录提醒时间，下一轮重试");
  assert.equal(store.getAlerts({}).every((alert) => alert.notified === false), true);
  store.close();
});

test("runRound 更新 metrics 供 /health 读取", async () => {
  const { ctx, store } = makeCtx({ fetchImpl: okFetch(100), now: T(0) });
  await runRound(ctx);
  assert.equal(ctx.metrics.lastRoundTs, T(0).toISOString());
  assert.equal(typeof ctx.metrics.lastRoundDurationMs, "number");
  store.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— `Cannot find module '../src/index.js'`

- [ ] **Step 3: 实现 `src/index.js`**

```js
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
  logger.info(`HTTP API 监听 http://${config.server.host}:${config.server.port}`);

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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/index.js test/index.test.js
git commit -m "feat: 主流程装配，采集循环 + 维护任务 + 信号处理"
```

---

### Task 13: 配置示例、部署产物与首次实战验收

**Files:**
- Create: `config.example.json`
- Create: `deploy/nearintents-monitor.service`
- Create: `deploy/Dockerfile`
- Create: `README.md`

**Interfaces:**
- Consumes: 前面所有模块
- Produces: 可直接跑的服务；`README.md` 里的运维说明

- [ ] **Step 1: 写 `config.example.json`（38 对白名单）**

```json
{
  "intervalSec": 60,
  "concurrency": 5,
  "requestTimeoutMs": 15000,
  "quoteEndpoint": "https://test-api.stableflow.ai/v1/nearintents/quote",
  "tokensSources": {
    "stableflow": "https://test-api.stableflow.ai/v1/pay/tokens",
    "oneclick": "https://1click.chaindefuser.com/v0/tokens"
  },
  "defaults": {
    "swapType": "EXACT_OUTPUT",
    "slippageTolerance": 10,
    "confidentiality": "advanced",
    "deadlineMs": 600000
  },
  "defaultAmounts": {
    "USDC": "1500", "USDT": "1500", "DAI": "1500",
    "ETH": "0.05", "WETH": "0.05", "SOL": "1",
    "BNB": "0.1", "AVAX": "5", "POL": "100", "TRX": "100", "ZEC": "0.5"
  },
  "addresses": {
    "near": "monitor.near",
    "eth": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "arb": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "base": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "op": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "pol": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "bsc": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "avax": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "gnosis": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "bera": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "xlayer": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "scroll": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "sol": "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    "tron": "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    "zec": "t1a2VZ5kXqJxQz8kQyYvXqZ9mNnR4pLqDk3"
  },
  "pairs": [
    { "from": "near:USDC", "to": "eth:USDC" },
    { "from": "eth:USDC", "to": "near:USDC" },
    { "from": "near:USDC", "to": "sol:USDC" },
    { "from": "sol:USDC", "to": "near:USDC" },
    { "from": "near:USDC", "to": "bsc:USDC" },
    { "from": "bsc:USDC", "to": "near:USDC" },
    { "from": "near:USDC", "to": "tron:USDT" },
    { "from": "tron:USDT", "to": "near:USDC" },
    { "from": "near:USDC", "to": "avax:USDC" },
    { "from": "avax:USDC", "to": "near:USDC" },
    { "from": "near:USDC", "to": "arb:USDC" },
    { "from": "arb:USDC", "to": "near:USDC" },
    { "from": "near:USDC", "to": "base:USDC" },
    { "from": "base:USDC", "to": "near:USDC" },
    { "from": "near:USDC", "to": "gnosis:USDC" },
    { "from": "gnosis:USDC", "to": "near:USDC" },
    { "from": "near:USDC", "to": "pol:USDC" },
    { "from": "pol:USDC", "to": "near:USDC" },
    { "from": "near:USDC", "to": "op:USDC" },
    { "from": "op:USDC", "to": "near:USDC" },
    { "from": "near:USDC", "to": "bera:USDT" },
    { "from": "bera:USDT", "to": "near:USDC" },
    { "from": "near:USDC", "to": "xlayer:USDC" },
    { "from": "xlayer:USDC", "to": "near:USDC" },
    { "from": "near:USDC", "to": "scroll:USDT" },
    { "from": "scroll:USDT", "to": "near:USDC" },
    { "from": "near:USDC", "to": "zec:ZEC" },
    { "from": "zec:ZEC", "to": "near:USDC" },
    { "from": "near:USDT", "to": "near:USDC" },
    { "from": "near:USDC", "to": "near:USDT" },
    { "from": "near:ETH", "to": "near:USDC" },
    { "from": "near:USDC", "to": "near:ETH" },
    { "from": "eth:USDC", "to": "sol:USDC" },
    { "from": "sol:USDC", "to": "eth:USDC" },
    { "from": "eth:USDC", "to": "base:USDC" },
    { "from": "base:USDC", "to": "eth:USDC" },
    { "from": "bsc:USDT", "to": "tron:USDT" },
    { "from": "tron:USDT", "to": "bsc:USDT" }
  ],
  "detect": {
    "priceDeviationPct": 10,
    "minSamples": 5,
    "realertMinutes": 30,
    "rollingWindowMinutes": 60
  },
  "slack": {
    "enabled": true,
    "webhookUrl": "",
    "mention": "",
    "timeoutMs": 10000,
    "digest": { "enabled": true, "hourLocal": 9 }
  },
  "retention": { "rawDays": 14, "hourlyDays": 0 },
  "server": { "host": "127.0.0.1", "port": 8787, "cors": "*", "bearerToken": "" }
}
```

- [ ] **Step 2: 写部署产物**

`deploy/nearintents-monitor.service`：

```ini
[Unit]
Description=NEAR Intents multi-chain quote monitor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=nearintents
Group=nearintents
WorkingDirectory=/opt/nearintents_monitoring
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/index.js \
  --config /etc/nearintents-monitor/config.json \
  --data /var/lib/nearintents-monitor/monitor.db
EnvironmentFile=-/etc/nearintents-monitor/env
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/nearintents-monitor

[Install]
WantedBy=multi-user.target
```

`/etc/nearintents-monitor/env` 只需要放敏感项，权限设 0600：

```
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx/yyy/zzz
SERVER_BEARER_TOKEN=
```

`deploy/Dockerfile`：

```dockerfile
FROM node:24-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src

RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning
EXPOSE 8787
VOLUME ["/app/data"]

CMD ["node", "src/index.js", "--config", "/app/config.json", "--data", "/app/data/monitor.db"]
```

- [ ] **Step 3: 写 `README.md`**

内容至少覆盖：项目一句话说明、设计文档与实现计划的链接、快速开始（`cp config.example.json config.json` → 填 Slack URL → `npm run once -- --no-notify`）、`npm test`、部署（systemd 与 Docker 各一段）、API 端点表、`--once` / `--no-notify` / `--config` / `--data` 四个参数、以及「数据文件默认 `data/monitor.db`，已 gitignore；原始数据保留 14 天，之后按小时聚合永久保留」。

- [ ] **Step 4: 跑全量测试**

Run: `npm test`
Expected: PASS，所有 Task 的用例全绿

- [ ] **Step 5: 首次实战验收（唯一联网的一步）**

```bash
cp config.example.json config.json
# 把 config.json 里的 slack.webhookUrl 填上，或先把 slack.enabled 改成 false
npm run once -- --no-notify
```

Expected，逐条对照：

1. 启动阶段打印「已解析 38 个币对」。少一个就说明配置里有解析不了的条目，错误信息会点名是 `pairs[i]` 哪一条。
2. `error` 数应为 3 左右，失败明细是全部以 `bsc:USDC` 或 `tron:USDT` 为目标链的币对（配置里共 3 条：`near:USDC → bsc:USDC`、`near:USDC → tron:USDT`、`bsc:USDT → tron:USDT`）。这些是**对方侧当前的真实状态**（`→bsc:USDC` 在任何金额下都返回最低额错误，`→tron:USDT` 返回 `Internal server error`），不是配置问题，不要去“修”。以 `tron:USDT` 为**源**的币对能否走通未探测，实际报错与否都算正常，看错误码判断是不是配置问题。
3. 如果出现 `recipient is not valid`，说明那条链的哑地址没通过校验。把 `config.json` 里对应 `addresses.<chain>` 换成你自己控制的一个合法地址后重跑。已知 near / 全部 EVM 链 / sol 的默认值已验证通过；tron 与 zec 的默认值未验证。
4. 如果出现 `limits` 错误码，说明该链的最低额限制高于 1500，给那条币对在 `config.json` 里加 `"amount": "<更大的值>"`。

- [ ] **Step 6: 验收 API**

```bash
node --disable-warning=ExperimentalWarning src/index.js &
curl -s localhost:8787/health | head -c 400
curl -s "localhost:8787/latest?status=error" | head -c 400
curl -s "localhost:8787/stats?window=1h" | head -c 400
curl -s "localhost:8787/history?limit=3" | head -c 400
```

Expected：`/health` 返回 `ok: true`；`/latest?status=error` 能列出那两条 bsc/tron 币对；`/stats?window=1h` 的 `pairs` 里每对有 `okRate`；`/history` 返回原始报价行。看完 `Ctrl-C`，确认进程是收到信号后**立即**退出而不是等满一分钟。

- [ ] **Step 7: 提交**

```bash
git add config.example.json deploy README.md
# config.json 在 .gitignore 里，不会被误提交；确认一下：
git status --short
git commit -m "chore: 配置示例、systemd/Docker 部署产物与 README"
```

---

## 完成后的状态

所有 Task 完成后应当满足：

- `npm test` 全绿，零运行时依赖，`node_modules` 不存在
- `npm start` 能在服务器上常驻，1 分钟一轮，38 对币对
- `--once` 能跑一轮就退出，`--no-notify` 能把 Slack 消息打到日志
- `curl localhost:8787/*` 六个端点都能用，CORS 就绪，供将来的面板消费
- 数据落 `data/monitor.db`：原始数据 14 天 + 小时聚合永久
- Slack 只在状态变化、超过 realertMinutes、恢复、以及每日汇总时响


