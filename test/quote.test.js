import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQuoteBody, parseQuote, classifyError, quotePair, quoteAll, BadShapeError } from "../src/quote.js";
import { HttpError } from "../src/http.js";

const PAIR = {
  id: "near:USDC>eth:USDC", label: "near:USDC → eth:USDC",
  fromAsset: "nep141:usdc.near", toAsset: "nep141:eth-usdc.omft.near",
  swapType: "EXACT_OUTPUT", amount: "1500", amountMinor: "1500000000",
  slippageTolerance: 10, confidentiality: "advanced", deadlineMs: 600000,
  refundTo: "monitor.near", recipient: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
};
const CONFIG = { quoteEndpoint: "https://q/v0/quote", concurrency: 2, requestTimeoutMs: 15000 };
const NOW = new Date("2026-09-15T00:00:00.000Z");
const SUCCESS = {
  correlationId: "cid-1",
  quote: {
    amountIn: "1501660000", amountInFormatted: "1501.66", amountInUsd: "1501.5",
    amountOut: "1500000000", amountOutFormatted: "1500", amountOutUsd: "1500",
    minAmountIn: "1500000000", minAmountOut: "1500000000",
    refundFee: "3000", withdrawFee: "0", timeEstimate: 27,
  },
};
const reply = (payload, status = 200) => async () => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) });
const quoteWith = (fetchImpl) => quotePair(PAIR, { config: CONFIG, deadline: "2026-09-15T00:10:00.000Z", fetchImpl, now: NOW });

test("buildQuoteBody 产出参考实现同构的请求体", () => {
  const body = buildQuoteBody(PAIR, { deadline: "2026-09-15T00:10:00.000Z", now: NOW });
  assert.deepEqual(body, {
    dry: true,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 10,
    originAsset: "nep141:usdc.near",
    depositType: "ORIGIN_CHAIN",
    destinationAsset: "nep141:eth-usdc.omft.near",
    amount: "1500000000",
    refundTo: "monitor.near",
    refundType: "ORIGIN_CHAIN",
    recipient: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    recipientType: "DESTINATION_CHAIN",
    deadline: "2026-09-15T00:10:00.000Z",
    confidentiality: "advanced",
  });
});

test("buildQuoteBody 必须带 dry，否则代理会返回 400", () => {
  assert.equal(buildQuoteBody(PAIR, { now: NOW }).dry, true);
});

test("buildQuoteBody 不传 deadline 时按 deadlineMs 算", () => {
  const body = buildQuoteBody(PAIR, { now: NOW });
  assert.equal(body.deadline, "2026-09-15T00:10:00.000Z");
});

test("parseQuote 取出字段并统一转成字符串", () => {
  const parsed = parseQuote(SUCCESS);
  assert.equal(parsed.amountIn, "1501660000");
  assert.equal(parsed.amountOut, "1500000000");
  assert.equal(parsed.amountInUsd, "1501.5");
  assert.equal(parsed.minAmountOut, "1500000000");
  assert.equal(parsed.timeEstimate, 27);
  assert.equal(parsed.correlationId, "cid-1");
});

test("parseQuote 缺字段时把可选项置 null 而不是 undefined", () => {
  const parsed = parseQuote({ quote: { amountIn: 1 } });
  assert.equal(parsed.amountOut, null);
  assert.equal(parsed.amountInUsd, null);
  assert.equal(parsed.correlationId, null);
});

test("parseQuote 对坏形状抛 bad_shape", () => {
  assert.throws(() => parseQuote({ error: "nope" }), (e) => e instanceof BadShapeError && e.code === "bad_shape");
  assert.throws(() => parseQuote({ quote: { amountIn: "not-a-number" } }), BadShapeError);
  assert.throws(() => parseQuote({ quote: { amountOut: "1" } }), BadShapeError, "amountIn 缺失也算坏形状");
  assert.throws(() => parseQuote(null), BadShapeError);
});

test("classifyError 把 swap limits 归为 limits", () => {
  const error = new HttpError("HTTP 400", { code: "http_4xx", status: 400, body: { message: "Temporary swap limits: minimum swap amount is $1,000" } });
  const out = classifyError(error);
  assert.equal(out.errorCode, "limits");
  assert.ok(out.errorMessage.includes("minimum swap amount"));
});

test("classifyError 对其他 4xx 保留 http_4xx", () => {
  const error = new HttpError("HTTP 400", { code: "http_4xx", status: 400, body: { message: "tokenOut is not valid" } });
  assert.equal(classifyError(error).errorCode, "http_4xx");
});

test("classifyError 对无 body 的 4xx 退回 error.message", () => {
  const error = new HttpError("HTTP 400", { code: "http_4xx", status: 400, body: null });
  const out = classifyError(error);
  assert.equal(out.errorCode, "http_4xx");
  assert.ok(out.errorMessage.includes("HTTP 400"));
});

test("classifyError 对 bad_shape 与 timeout 原样传递", () => {
  assert.equal(classifyError(new BadShapeError("x", null)).errorCode, "bad_shape");
  assert.equal(classifyError(new HttpError("y", { code: "timeout" })).errorCode, "timeout");
  assert.equal(classifyError(new HttpError("z", { code: "network" })).errorCode, "network");
});

test("quotePair 成功时产出 ok 行", async () => {
  const row = await quoteWith(reply(SUCCESS, 201));
  assert.equal(row.ok, true);
  assert.equal(row.pairId, PAIR.id);
  assert.equal(row.ts, NOW.toISOString());
  assert.equal(row.httpStatus, 201);
  assert.equal(row.amountIn, "1501660000");
  assert.equal(row.correlationId, "cid-1");
  assert.equal(row.errorCode, null);
  assert.equal(typeof row.latencyMs, "number");
});

test("quotePair 失败时返回 ok:false 的行而绝不抛错", async () => {
  const row = await quoteWith(reply({ message: "Temporary swap limits: minimum swap amount is $1,000" }, 400));
  assert.equal(row.ok, false);
  assert.equal(row.errorCode, "limits");
  assert.equal(row.httpStatus, 400);
  assert.ok(row.errorMessage.includes("minimum swap amount"));
});

test("quotePair 把 5xx / 网络 / 超时 归类而不崩溃", async () => {
  assert.equal((await quoteWith(reply({ error: "down" }, 502))).errorCode, "http_5xx");
  assert.equal((await quoteWith(async () => { throw new TypeError("fetch failed"); })).errorCode, "network");
  const hanging = (_url, { signal }) => new Promise((_r, reject) => signal.addEventListener("abort", () => {
    const e = new Error("aborted"); e.name = "AbortError"; reject(e);
  }));
  const row = await quotePair(PAIR, { config: { ...CONFIG, requestTimeoutMs: 10 }, fetchImpl: hanging, now: NOW });
  assert.equal(row.ok, false);
  assert.equal(row.errorCode, "timeout");
});

test("quotePair 把 201 但缺 quote 字段归为 bad_shape", async () => {
  const row = await quoteWith(reply({ correlationId: "cid" }, 201));
  assert.equal(row.ok, false);
  assert.equal(row.errorCode, "bad_shape");
  assert.equal(row.httpStatus, 201, "HTTP 层面是成功的，需要保留下来才能分辨");
});

test("quotePair 把请求体原样发给端点", async () => {
  let seen;
  await quotePair(PAIR, {
    config: CONFIG, deadline: "2026-09-15T00:10:00.000Z", now: NOW,
    fetchImpl: async (url, init) => {
      seen = { url, method: init.method, headers: init.headers, body: JSON.parse(init.body) };
      return { ok: true, status: 201, text: async () => JSON.stringify(SUCCESS) };
    },
  });
  assert.equal(seen.url, CONFIG.quoteEndpoint);
  assert.equal(seen.method, "POST");
  assert.equal(seen.headers["Content-Type"], "application/json");
  assert.equal(seen.body.dry, true);
  assert.equal(seen.body.amount, "1500000000");
});

test("quoteAll 保序、每对一行、单条失败不拖累其他", async () => {
  const pairs = [
    { ...PAIR, id: "a>b" },
    { ...PAIR, id: "c>d" },
    { ...PAIR, id: "e>f" },
  ];
  let call = 0;
  const rows = await quoteAll(pairs, {
    config: CONFIG, deadline: "2026-09-15T00:10:00.000Z", now: NOW,
    fetchImpl: async () => {
      call += 1;
      const nth = call;
      // 让第 1 个请求最慢完成，确保结果顺序与完成顺序不同
      if (nth === 1) await new Promise((resolve) => setTimeout(resolve, 20));
      return nth === 2
        ? { ok: false, status: 400, text: async () => JSON.stringify({ message: "tokenOut is not valid" }) }
        : { ok: true, status: 201, text: async () => JSON.stringify(SUCCESS) };
    },
  });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.pairId), ["a>b", "c>d", "e>f"], "应按入参顺序回填，而不是按完成顺序");
  assert.equal(rows.filter((r) => !r.ok).length, 1);
  assert.equal(rows.find((r) => !r.ok).errorCode, "http_4xx", "失败应被隔离成一行，不影响其余两条");
});
