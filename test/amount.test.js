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
