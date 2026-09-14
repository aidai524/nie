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
