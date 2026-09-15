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
