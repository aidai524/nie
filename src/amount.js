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
