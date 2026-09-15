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
