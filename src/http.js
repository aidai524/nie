export class HttpError extends Error {
  constructor(message, { code, status = null, body = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "HttpError";
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

/** 非 2xx / 超时 / 网络故障一律抛 HttpError，code 直接就是落库用的 error_code */
export async function fetchJson(url, { method = "GET", headers = {}, body, timeoutMs = 15000, fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(url, { method, headers, body, signal: controller.signal });
    const text = await response.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = text; }
    }
    if (!response.ok) {
      const detail = payload !== null && typeof payload === "object" ? (payload.message ?? payload.error ?? null) : payload;
      throw new HttpError(
        `${method} ${url} → HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
        { code: response.status >= 500 ? "http_5xx" : "http_4xx", status: response.status, body: payload },
      );
    }
    return { status: response.status, payload, latencyMs: Date.now() - startedAt };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error?.name === "AbortError") {
      throw new HttpError(`${method} ${url} 超时（${timeoutMs}ms）`, { code: "timeout", cause: error });
    }
    throw new HttpError(`${method} ${url} 网络错误: ${error?.message ?? error}`, { code: "network", cause: error });
  } finally {
    clearTimeout(timer);
  }
}

/** 有界并发，保序返回。worker 抛错变成结果项，单条失败不会拖垮整批。 */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runner = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await worker(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  };
  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: size }, runner));
  return results;
}
