import { fetchJson, HttpError, mapLimit } from "./http.js";

export class BadShapeError extends Error {
  constructor(message, payload) {
    super(message);
    this.name = "BadShapeError";
    this.code = "bad_shape";
    this.payload = payload;
  }
}

const SWAP_LIMITS = /swap limits/i;

function extractMessage(body) {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return body;
  if (typeof body === "object") return body.message ?? body.error ?? null;
  return String(body);
}

/** 实测：最低额限制也是 400，但语义上是「限额」而不是「路由/参数错误」，因此单独归类 */
export function classifyError(error) {
  if (error instanceof BadShapeError) {
    return { errorCode: "bad_shape", errorMessage: error.message };
  }
  if (error instanceof HttpError && error.code === "http_4xx") {
    const detail = extractMessage(error.body);
    if (detail !== null && SWAP_LIMITS.test(detail)) {
      return { errorCode: "limits", errorMessage: detail };
    }
    return { errorCode: "http_4xx", errorMessage: detail ?? error.message };
  }
  return { errorCode: error?.code ?? "network", errorMessage: error?.message ?? String(error) };
}

export function buildQuoteBody(pair, { deadline, dry = true, now = new Date() } = {}) {
  return {
    dry,
    swapType: pair.swapType,
    slippageTolerance: pair.slippageTolerance,
    originAsset: pair.fromAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: pair.toAsset,
    amount: pair.amountMinor,
    refundTo: pair.refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: pair.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: deadline ?? new Date(now.getTime() + pair.deadlineMs).toISOString(),
    confidentiality: pair.confidentiality,
  };
}

const asText = (value) => (value === null || value === undefined ? null : String(value));

export function parseQuote(payload) {
  const quote = payload?.quote;
  if (quote === null || typeof quote !== "object") {
    throw new BadShapeError("响应缺少 quote 字段", payload);
  }
  const amountIn = quote.amountIn;
  if (amountIn === null || amountIn === undefined || !Number.isFinite(Number(amountIn))) {
    throw new BadShapeError("响应里 amountIn 缺失或不可解析", payload);
  }
  return {
    amountIn: String(amountIn),
    amountInFormatted: asText(quote.amountInFormatted),
    amountInUsd: asText(quote.amountInUsd),
    amountOut: asText(quote.amountOut),
    amountOutFormatted: asText(quote.amountOutFormatted),
    amountOutUsd: asText(quote.amountOutUsd),
    minAmountIn: asText(quote.minAmountIn),
    minAmountOut: asText(quote.minAmountOut),
    timeEstimate: quote.timeEstimate ?? null,
    correlationId: payload.correlationId ?? null,
  };
}

/** 永不抛错：任何失败都以 ok:false 的行返回，避免单条异常拖垮整轮 */
export async function quotePair(pair, { config, deadline, fetchImpl, timeoutMs, now = new Date() } = {}) {
  const ts = now.toISOString();
  const startedAt = Date.now();
  // HTTP 状态码必须在解析前抢下来：bad_shape 是在 HTTP 201 之后才发现的，
  // 如果只在 catch 里从 error 取状态码，这种情况会被误记成 null
  let httpStatus = null;
  try {
    const response = await fetchJson(config.quoteEndpoint, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(buildQuoteBody(pair, { deadline, now })),
      timeoutMs: timeoutMs ?? config.requestTimeoutMs,
      fetchImpl,
    });
    httpStatus = response.status;
    return {
      ts, pairId: pair.id, ok: true,
      httpStatus, latencyMs: response.latencyMs,
      ...parseQuote(response.payload),
      errorCode: null, errorMessage: null,
    };
  } catch (error) {
    const { errorCode, errorMessage } = classifyError(error);
    return {
      ts, pairId: pair.id, ok: false,
      httpStatus: error instanceof HttpError ? error.status : httpStatus,
      latencyMs: Date.now() - startedAt,
      errorCode, errorMessage,
    };
  }
}

export async function quoteAll(pairs, { config, deadline, fetchImpl, timeoutMs, now = new Date() } = {}) {
  const options = { config, deadline, fetchImpl, timeoutMs, now };
  const results = await mapLimit(pairs, config.concurrency, (pair) => quotePair(pair, options));
  // quotePair 不抛错，所以这里的 error 分支只可能是内部 bug（如 pair 结构不对）；仍要产出一行
  return pairs.map((pair, index) => {
    const result = results[index];
    if (result?.ok) return result.value;
    return {
      ts: now.toISOString(), pairId: pair.id, ok: false,
      httpStatus: null, latencyMs: null,
      errorCode: "internal",
      errorMessage: `内部错误: ${result?.error?.message ?? result?.error}`,
    };
  });
}
