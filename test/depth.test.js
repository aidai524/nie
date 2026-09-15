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
