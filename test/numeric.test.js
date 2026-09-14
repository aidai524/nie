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
