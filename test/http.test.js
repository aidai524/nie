import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchJson, mapLimit, HttpError } from "../src/http.js";

const reply = (status, text, ok = status >= 200 && status < 300) => async () => ({ ok, status, text: async () => text });

test("2xx 解析 JSON 并给出耗时", async () => {
  const out = await fetchJson("https://x/y", { fetchImpl: reply(200, '{"a":1}') });
  assert.equal(out.status, 200);
  assert.deepEqual(out.payload, { a: 1 });
  assert.equal(typeof out.latencyMs, "number");
});

test("2xx 但响应不是 JSON 时原样返回文本", async () => {
  const out = await fetchJson("https://x/y", { fetchImpl: reply(200, "pong") });
  assert.equal(out.payload, "pong");
});

test("2xx 且响应体为空时 payload 为 null", async () => {
  const out = await fetchJson("https://x/y", { fetchImpl: reply(204, "") });
  assert.equal(out.payload, null);
});

test("4xx 抛 HttpError 并带上服务端 message", async () => {
  await assert.rejects(
    fetchJson("https://x/y", { fetchImpl: reply(400, '{"message":"tokenOut is not valid"}') }),
    (e) => {
      assert.ok(e instanceof HttpError);
      assert.equal(e.code, "http_4xx");
      assert.equal(e.status, 400);
      assert.ok(e.message.includes("tokenOut is not valid"));
      assert.deepEqual(e.body, { message: "tokenOut is not valid" });
      return true;
    },
  );
});

test("5xx 归类为 http_5xx", async () => {
  await assert.rejects(
    fetchJson("https://x/y", { fetchImpl: reply(503, '{"error":"down"}') }),
    (e) => e.code === "http_5xx" && e.status === 503 && e.message.includes("down"),
  );
});

test("超时归类为 timeout", async () => {
  const hanging = (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  await assert.rejects(
    fetchJson("https://x/y", { timeoutMs: 10, fetchImpl: hanging }),
    (e) => e.code === "timeout" && e.message.includes("超时"),
  );
});

test("网络故障归类为 network", async () => {
  await assert.rejects(
    fetchJson("https://x/y", { fetchImpl: async () => { throw new TypeError("fetch failed"); } }),
    (e) => e.code === "network" && e.message.includes("fetch failed"),
  );
});

test("fetchJson 把方法、头、体、signal 透传给 fetchImpl", async () => {
  let seen;
  await fetchJson("https://x/y", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"a":1}',
    fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, status: 200, text: async () => "{}" }; },
  });
  assert.equal(seen.url, "https://x/y");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.body, '{"a":1}');
  assert.ok(seen.init.signal instanceof AbortSignal);
});

test("mapLimit 保序返回", async () => {
  const out = await mapLimit([3, 1, 2], 2, async (n) => { await new Promise((r) => setTimeout(r, n)); return n * 10; });
  assert.deepEqual(out.map((r) => r.value), [30, 10, 20]);
});

test("mapLimit 遵守并发上限", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return "done";
  });
  assert.equal(peak, 3);
  assert.equal(out.length, 8);
  assert.ok(out.every((r) => r.ok && r.value === "done"));
});

test("mapLimit 把 worker 抛错捕获成结果项，不中断整批", async () => {
  const out = await mapLimit([1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error("boom");
    return n;
  });
  assert.equal(out[0].value, 1);
  assert.equal(out[1].ok, false);
  assert.equal(out[1].error.message, "boom");
  assert.equal(out[2].value, 3);
});

test("mapLimit 处理空数组", async () => {
  assert.deepEqual(await mapLimit([], 5, async () => 1), []);
});
