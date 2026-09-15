/** 都返回新数组，不改动入参顺序 */
function sortedCopy(values) {
  return [...values].sort((a, b) => a - b);
}

export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = sortedCopy(values);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** 最近秩法（nearest-rank）：取第 ceil(p * n) 个元素，1-based */
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = sortedCopy(values);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}
