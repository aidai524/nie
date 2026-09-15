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
