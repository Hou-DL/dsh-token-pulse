import type { DayAgg } from "../aggregation.ts";
import { addDays } from "../date-bucket.ts";

/**
 * Pure logic for the bottom-of-page trend line chart: window slicing,
 * top-model selection, per-model series building and monotone cubic smoothing.
 * Kept free of React/DOM so it is unit-testable and reusable.
 */

/** N consecutive day keys ending at `endKey` (inclusive). */
export function recentDayKeys(endKey: string, n: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(addDays(endKey, -i));
  return out;
}

/** Sum each model's tokens over `dayKeys`. */
function modelTotals(days: DayAgg[], dayKeys: string[]): Map<string, number> {
  const inWindow = new Set(dayKeys);
  const totals = new Map<string, number>();
  for (const d of days) {
    if (!inWindow.has(d.dayKey)) continue;
    for (const [model, tokens] of d.byModel) {
      totals.set(model, (totals.get(model) ?? 0) + tokens);
    }
  }
  return totals;
}

const byTotalDesc = (a: [string, number], b: [string, number]) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1);

/** Sum each model's tokens over `dayKeys`, return up to `k` names by total desc. */
export function pickTopModels(days: DayAgg[], dayKeys: string[], k = 5): string[] {
  return [...modelTotals(days, dayKeys).entries()]
    .sort(byTotalDesc)
    .slice(0, k)
    .map(([model]) => model);
}

/**
 * Legend selection for the trend chart: the range's top-k models PLUS the
 * week's top-`weekTopN` models guaranteed (a model that took over this week
 * must stay visible in a 30/90-day view). If the union exceeds `k`, the
 * weakest range-ranked models give up their slots. Result is ordered by range
 * usage desc, deduplicated, at most `k` names.
 */
export function pickTrendModels(
  days: DayAgg[],
  dayKeys: string[],
  weekKeys: string[],
  k = 10,
  weekTopN = 3,
): string[] {
  const rangeTotals = modelTotals(days, dayKeys);
  const rangeRanked = [...rangeTotals.entries()].sort(byTotalDesc).slice(0, k).map(([m]) => m);
  const weekTop = pickTopModels(days, weekKeys, weekTopN);
  const selected = new Set<string>(weekTop);
  for (const m of rangeRanked) {
    if (selected.size >= k) break;
    selected.add(m);
  }
  return [...selected].sort(
    (a, b) => ((rangeTotals.get(b) ?? 0) - (rangeTotals.get(a) ?? 0)) || (a < b ? -1 : 1),
  );
}

export type TrendSeries = { model: string; points: number[] };

/** One series per model: its daily tokens aligned to `dayKeys`, 0 where absent. */
export function buildSeries(days: DayAgg[], dayKeys: string[], models: string[]): TrendSeries[] {
  const index = new Map(days.map((d) => [d.dayKey, d]));
  return models.map((model) => ({
    model,
    points: dayKeys.map((k) => index.get(k)?.byModel.get(model) ?? 0),
  }));
}

export type Segment = {
  p0: [number, number];
  c1: [number, number];
  c2: [number, number];
  p1: [number, number];
};

/**
 * Monotone cubic (Fritsch–Carlson) Hermite interpolation of 2-D points as
 * cubic bezier segments. Used instead of plain Catmull-Rom because a smooth
 * trend line must NOT overshoot: a zero day between two peaks stays at zero
 * instead of dipping below the axis and inventing a fake trough.
 */
export function monotoneSegments(pts: Array<[number, number]>): Segment[] {
  const n = pts.length;
  if (n < 2) return [];
  // slopes (secants) between neighbours
  const h: number[] = [];
  const delta: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    h.push(dx);
    delta.push(dx === 0 ? 0 : (pts[i + 1][1] - pts[i][1]) / dx);
  }
  // tangents: start with mean of neighbouring secants
  const m: number[] = new Array(n);
  m[0] = delta[0];
  m[n - 1] = delta[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = delta[i - 1] * delta[i] <= 0 ? 0 : (delta[i - 1] + delta[i]) / 2;
  }
  // Fritsch–Carlson limiter: keep the curve monotone (no overshoot)
  for (let i = 0; i < n - 1; i++) {
    if (delta[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / delta[i];
    const b = m[i + 1] / delta[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * delta[i];
      m[i + 1] = t * b * delta[i];
    }
  }
  // Hermite -> cubic bezier control points
  const segs: Segment[] = [];
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const dx = (x1 - x0) / 3;
    segs.push({
      p0: [x0, y0],
      c1: [x0 + dx, y0 + m[i] * (x1 - x0) / 3],
      c2: [x1 - dx, y1 - m[i + 1] * (x1 - x0) / 3],
      p1: [x1, y1],
    });
  }
  return segs;
}

const fmtNum = (v: number) => Math.round(v * 100) / 100;

/** SVG path `d` for a smoothed polyline through `points` ([x,y] pairs). */
export function seriesPath(points: Array<[number, number]>): string {
  if (points.length === 0) return "";
  const head = `M ${fmtNum(points[0][0])} ${fmtNum(points[0][1])}`;
  if (points.length === 1) return head;
  const segs = monotoneSegments(points);
  return head + segs
    .map((s) => ` C ${fmtNum(s.c1[0])} ${fmtNum(s.c1[1])}, ${fmtNum(s.c2[0])} ${fmtNum(s.c2[1])}, ${fmtNum(s.p1[0])} ${fmtNum(s.p1[1])}`)
    .join("");
}

/** Compact token count for axis labels (same semantics as the heatmap). */
export function formatTokensShort(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1000) return (n / 1000).toFixed(2) + "k";
  return n.toLocaleString();
}
