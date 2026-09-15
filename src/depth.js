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
  return { pairCount, byTier, deadPairs: [...seenPairs].filter((id) => !passingPairs.has(id)).length };
}
