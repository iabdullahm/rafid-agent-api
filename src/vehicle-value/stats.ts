/** vehicle_value_estimate — small, dependency-free, deterministic statistics helpers. */

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** Linear-interpolation quantile (type 7, the common default). */
export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

/** Weighted median: the smallest value whose cumulative weight reaches half the total; ties in
 *  value are resolved by sort order (value, then index) so the result is deterministic. When the
 *  cumulative weight lands exactly on half, the two neighbours are averaged. */
export function weightedMedian(values: readonly number[], weights: readonly number[]): number | null {
  const items = values.map((v, i) => ({ v, w: Math.max(0, weights[i] ?? 0), i })).filter(x => x.w > 0).sort((a, b) => a.v - b.v || a.i - b.i);
  if (items.length === 0) return median(values);
  const total = items.reduce((a, x) => a + x.w, 0);
  let cum = 0;
  for (let k = 0; k < items.length; k++) {
    cum += items[k]!.w;
    if (Math.abs(cum - total / 2) < 1e-12 && k + 1 < items.length) return (items[k]!.v + items[k + 1]!.v) / 2;
    if (cum > total / 2) return items[k]!.v;
  }
  return items[items.length - 1]!.v;
}

/** Median absolute deviation (unscaled). */
export function mad(values: readonly number[]): number | null {
  const m = median(values);
  if (m === null) return null;
  return median(values.map(v => Math.abs(v - m)));
}

/** Weighted least squares for y = b0 + Σ bj·xj. Returns null when the system is singular or
 *  under-determined. Solved via the normal equations with Gaussian elimination (≤ 3 unknowns). */
export function weightedLeastSquares(rows: readonly { y: number; x: readonly number[]; w: number }[]): number[] | null {
  if (rows.length === 0) return null;
  const k = rows[0]!.x.length + 1;
  if (rows.length < k + 2) return null;
  const A = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const b = new Array<number>(k).fill(0);
  for (const r of rows) {
    const xs = [1, ...r.x];
    for (let i = 0; i < k; i++) {
      b[i]! += r.w * xs[i]! * r.y;
      for (let j = 0; j < k; j++) A[i]![j]! += r.w * xs[i]! * xs[j]!;
    }
  }
  // Gaussian elimination with partial pivoting.
  for (let col = 0; col < k; col++) {
    let pivot = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(A[r]![col]!) > Math.abs(A[pivot]![col]!)) pivot = r;
    if (Math.abs(A[pivot]![col]!) < 1e-9) return null;
    [A[col], A[pivot]] = [A[pivot]!, A[col]!];
    [b[col], b[pivot]] = [b[pivot]!, b[col]!];
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = A[r]![col]! / A[col]![col]!;
      for (let c = col; c < k; c++) A[r]![c]! -= f * A[col]![c]!;
      b[r]! -= f * b[col]!;
    }
  }
  const solution = b.map((v, i) => v / A[i]![i]!);
  return solution.every(Number.isFinite) ? solution : null;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const round = (v: number, dp: number) => { const f = 10 ** dp; return Math.round(v * f) / f; };
