import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTier, largestPassingTier, buildDepthIndex } from "../public/dashboard.js";

test("formatTier 覆盖 1M / 2.5M / 100k / 1.5k / 100", () => {
  assert.equal(formatTier(1000000), "1M");
  assert.equal(formatTier(2500000), "2.5M");
  assert.equal(formatTier(100000), "100k");
  assert.equal(formatTier(10000), "10k");
  assert.equal(formatTier(1000), "1k");
  assert.equal(formatTier(1500), "1.5k");
  assert.equal(formatTier(100), "100");
});

test("formatTier 对坏输入给破折号而不是 NaN", () => {
  assert.equal(formatTier(null), "—");
  assert.equal(formatTier(undefined), "—");
  assert.equal(formatTier("abc"), "—");
  assert.equal(formatTier(0), "—");
  assert.equal(formatTier(-100), "—");
});

test("formatTier 不把 1M 显示成 1.0M", () => {
  assert.equal(formatTier(1000000), "1M");
  assert.ok(!formatTier(1000000).includes(".0"));
});

const depthRow = (tierUsd, ok, extra = {}) => ({
  pairId: "near:USDC>eth:USDC", tierUsd, ok, amountInUsd: "100.41", amountOutUsd: "100.00",
  errorCode: ok ? null : "http_4xx", errorMessage: ok ? null : "No liquidity available", ...extra,
});

test("largestPassingTier 挑出能通过的最大档位，与输入顺序无关", () => {
  assert.equal(largestPassingTier([depthRow(100, true), depthRow(1000, true), depthRow(10000, false)]), 1000);
  assert.equal(largestPassingTier([depthRow(10000, false), depthRow(100, true), depthRow(1000, true)]), 1000);
  assert.equal(largestPassingTier([depthRow(1000000, true), depthRow(100, true)]), 1000000);
});

test("largestPassingTier 在全不通或空输入时给 null", () => {
  assert.equal(largestPassingTier([depthRow(1000, false), depthRow(100, false)]), null);
  assert.equal(largestPassingTier([]), null);
  assert.equal(largestPassingTier([depthRow(100, true), null, { pairId: "x" }]), 100, "坏行要跳过而不是崩");
});

test("buildDepthIndex 按币对归并，并给出每对的详情", () => {
  const index = buildDepthIndex([
    depthRow(100, true), depthRow(1000, false),
    { ...depthRow(100, true), pairId: "near:USDC>sol:USDC" },
    { ...depthRow(10000, true), pairId: "near:USDC>sol:USDC" },
  ]);
  assert.equal(index.size, 2);
  const eth = index.get("near:USDC>eth:USDC");
  assert.equal(eth.maxTierUsd, 100);
  assert.equal(eth.byTier.get(1000).errorMessage, "No liquidity available");
  assert.equal(index.get("near:USDC>sol:USDC").maxTierUsd, 10000);
});

test("buildDepthIndex 对空输入与坏行不崩", () => {
  assert.equal(buildDepthIndex([]).size, 0);
  assert.equal(buildDepthIndex([null, { noPairId: 1 }]).size, 0);
});
