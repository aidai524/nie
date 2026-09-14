import { median } from "./numeric.js";

export const STATUS = Object.freeze({ OK: "ok", ERROR: "error", DEVIANT: "deviant" });

/**
 * 价格侧由 swapType 决定：固定的是哪一侧，就盯另一侧。
 * EXACT_OUTPUT 固定目标数量，看「要付多少源币」= amountIn；
 * EXACT_INPUT 固定源数量，看「能收到多少目标币」= amountOut。
 */
export function priceMetric(quote, swapType) {
  if (!quote?.ok) return null;
  const raw = swapType === "EXACT_INPUT" ? quote.amountOut : quote.amountIn;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** history 应是本轮写入之前的报价，基准不含当前样本 */
export function evaluate({ quote, history = [], prevStatus = null, detect }) {
  const isFailure = !quote?.ok;
  let status = STATUS.OK;
  let metric = null;
  let baseline = null;
  let sampleCount = 0;
  let deviationPct = null;

  if (isFailure) {
    status = STATUS.ERROR;
  } else {
    metric = priceMetric(quote, quote.swapType);
    const samples = history
      .map((past) => priceMetric(past, quote.swapType))
      .filter((value) => value !== null);
    sampleCount = samples.length;
    baseline = median(samples);
    if (metric !== null && baseline !== null && sampleCount >= detect.minSamples) {
      deviationPct = baseline === 0 ? 0 : ((metric - baseline) / baseline) * 100;
    }
    if (deviationPct !== null && Math.abs(deviationPct) > detect.priceDeviationPct) {
      status = STATUS.DEVIANT;
    }
  }

  let event = null;
  if (status === STATUS.ERROR) {
    event = {
      kind: "error",
      isNew: prevStatus !== STATUS.ERROR,
      detail: {
        errorCode: quote?.errorCode ?? "unknown",
        errorMessage: quote?.errorMessage ?? "未知错误",
        httpStatus: quote?.httpStatus ?? null,
      },
    };
  } else if (status === STATUS.DEVIANT) {
    event = {
      kind: "deviation",
      isNew: prevStatus !== STATUS.DEVIANT,
      detail: { metric, baseline, deviationPct, sampleCount },
    };
  } else if (prevStatus !== null && prevStatus !== STATUS.OK) {
    event = { kind: "recover", isNew: true, detail: { metric, baseline } };
  }

  return { status, metric, baseline, sampleCount, deviationPct, event };
}
