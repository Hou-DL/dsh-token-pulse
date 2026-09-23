import * as React from "react";
import type { DayAgg } from "../aggregation.ts";
import { toDayKey } from "../date-bucket.ts";
import { recentDayKeys, pickTrendModels, buildSeries, seriesPath, formatTokensShort } from "./trend.ts";

/** Distinct, colorblind-tolerant series colors (first matches the heatmap green). */
const COLORS = [
  "#40c463", "#4c8dff", "#f6a609", "#c956e0", "#ff7a59",
  "#26c6da", "#ff5c8a", "#9ccc65", "#7e57c2", "#ffd54f",
];

/** Round a max up to a friendly axis ceiling (steps of half a decade). */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const unit = Math.pow(10, Math.floor(Math.log10(v))) / 2;
  return Math.ceil(v / unit) * unit;
}

const W = 720;
const H = 280;
const PAD = { top: 10, right: 28, bottom: 34, left: 76 }; // right: 给最右日期标签留出空间，避免贴边裁字
/** chart container horizontal padding (must match the div below) */
const CX_PAD = 8;

/**
 * Trend line chart at the bottom of the settings section: one smoothed line
 * per model (top 10 of the selected range), legend chips toggle visibility,
 * range switch between the last 7 / 30 / 90 days. Hovering a date column shows a
 * compact translucent tooltip BESIDE the cursor (never covering the hovered
 * point): date, day total, per-model totals with color dots.
 * Pure SVG + absolutely-positioned HTML tooltip, no dependencies.
 */
export function TrendChart({
  t,
  days,
  isEn = false,
}: {
  t: (k: string, p?: any) => string;
  days: DayAgg[];
  isEn?: boolean;
}) {
  const [rangeDays, setRangeDays] = React.useState<7 | 30 | 90>(7);
  const [hidden, setHidden] = React.useState<ReadonlySet<string>>(new Set());
  /** hovered column index + pointer position in wrapper px (for side placement) */
  const [hover, setHover] = React.useState<{ idx: number; px: number; py: number } | null>(null);

  const endKey = toDayKey(Date.now());
  const dayKeys = React.useMemo(() => recentDayKeys(endKey, rangeDays), [endKey, rangeDays]);
  const weekKeys = React.useMemo(() => recentDayKeys(endKey, 7), [endKey]);
  // 范围前 10 + 近一周前 3 必进列表（本周冒头的模型在 30/90 天视图里也可见）
  const topModels = React.useMemo(() => pickTrendModels(days, dayKeys, weekKeys, 10, 3), [days, dayKeys, weekKeys]);
  const series = React.useMemo(() => buildSeries(days, dayKeys, topModels), [days, dayKeys, topModels]);

  const totalsByModel = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const s of series) m.set(s.model, s.points.reduce((a, b) => a + b, 0));
    return m;
  }, [series]);

  // wrapper size for pixel-accurate tooltip positioning under the scaled SVG
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const [wrap, setWrap] = React.useState({ w: 0, h: 0 });
  React.useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setWrap({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const toggle = (model: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(model)) next.delete(model);
      else next.add(model);
      return next;
    });
  };

  const colorOf = (model: string) => COLORS[Math.max(0, topModels.indexOf(model)) % COLORS.length];
  const visible = series.filter((s) => !hidden.has(s.model));

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const yMax = niceCeil(Math.max(1, ...visible.map((s) => Math.max(0, ...s.points))));
  const step = dayKeys.length > 1 ? plotW / (dayKeys.length - 1) : plotW;
  const xOf = (i: number) => PAD.left + (dayKeys.length > 1 ? i * step : plotW / 2);
  const yOf = (v: number) => PAD.top + (1 - v / yMax) * plotH;

  const fmtDay = (k: string) => `${Number(k.slice(5, 7))}/${Number(k.slice(8, 10))}`;
  const fmtDayLong = (k: string) =>
    isEn
      ? `${Number(k.slice(5, 7))}/${Number(k.slice(8, 10))}`
      : `${Number(k.slice(5, 7))}月${Number(k.slice(8, 10))}日`;
  // x tick indices: every day for a week, sparse ticks for month/quarter ranges
  const tickEvery = rangeDays === 7 ? 1 : rangeDays === 30 ? 5 : 10;
  const tickIdx = dayKeys.map((_, i) => i).filter((i) => i % tickEvery === 0 || i === dayKeys.length - 1);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const wrapEl = wrapRef.current;
    if (!wrapEl) return;
    const wrapRect = wrapEl.getBoundingClientRect();
    const svgRect = e.currentTarget.getBoundingClientRect();
    const scale = svgRect.width / W || 1;
    const xvb = (e.clientX - svgRect.left) / scale;
    const i = Math.round((xvb - PAD.left) / step);
    setHover({
      idx: Math.max(0, Math.min(dayKeys.length - 1, i)),
      px: e.clientX - wrapRect.left,
      py: e.clientY - wrapRect.top,
    });
  };

  // hovered column: date, day total and one row per visible model —
  // sorted by that day's usage desc, zero-usage models hidden
  const hoverRows = hover == null ? [] : visible
    .map((s) => ({
      model: s.model,
      color: colorOf(s.model),
      value: s.points[hover.idx],
    }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);
  const hoverTotal = hoverRows.reduce((a, r) => a + r.value, 0);

  // tooltip placement: to the SIDE of the hovered column (flips near edges),
  // vertically centered on the pointer, so the hovered point is never covered
  const tipW = 200;
  const tipH = 56 + hoverRows.length * 19;
  const gap = 14;
  const svgW = Math.max(0, wrap.w - CX_PAD * 2);
  const colPx = hover == null ? 0 : CX_PAD + (xOf(hover.idx) / W) * svgW;
  let tipLeft = hover == null ? 0 : colPx + gap;
  if (hover != null && tipLeft + tipW > wrap.w - 4) tipLeft = colPx - gap - tipW;
  tipLeft = Math.max(4, tipLeft);
  const tipTop = hover == null ? 0 : Math.max(4, Math.min(hover.py - tipH / 2, Math.max(4, wrap.h - tipH - 4)));

  const segStyle: React.CSSProperties = {
    padding: "2px 8px",
    fontSize: 12,
    border: "none",
    cursor: "pointer",
    borderRadius: 5,
    background: "var(--dsw-alias-bg-layer-3)",
    color: "var(--dsw-alias-label-secondary)",
  };

  return (
    <div
      style={{
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-layer-3)",
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      {/* header: title + range switch */}
      <div
        style={{
          padding: "12px 16px 8px",
          borderBottom: "1px solid var(--dsw-alias-border-l2)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" }}>{t("trend.title")}</span>
          <span style={{ fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }}>{t("trend.hint")}</span>
        </div>
        <div style={{ display: "inline-flex", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 6, overflow: "hidden" }}>
          {([7, 30, 90] as const).map((n) => (
            <button
              key={n}
              onClick={() => { setRangeDays(n); setHover(null); }}
              style={{
                ...segStyle,
                background: rangeDays === n ? "var(--dsw-alias-label-primary)" : "transparent",
                color: rangeDays === n ? "var(--dsw-alias-bg-layer-3)" : "var(--dsw-alias-label-secondary)",
              }}
            >
              {n === 7 ? t("trend.range7") : n === 30 ? t("trend.range30") : t("trend.range90")}
            </button>
          ))}
        </div>
      </div>

      {/* legend chips: top-10 models of the range, 5 per row, click to toggle a line */}
      <div style={{ padding: "10px 16px 4px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 6 }}>
          {series.map((s) => {
            const off = hidden.has(s.model);
            return (
              <button
                key={s.model}
                onClick={() => toggle(s.model)}
                title={s.model}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "1px 6px",
                  borderRadius: 999,
                  border: "1px solid var(--dsw-alias-border-l2)",
                  background: "transparent",
                  cursor: "pointer",
                  opacity: off ? 0.35 : 1,
                  fontSize: 11,
                  color: "var(--dsw-alias-label-primary)",
                  minWidth: 0,
                }}
              >
                <span style={{ width: 6, height: 6, borderRadius: 3, background: colorOf(s.model), flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left", textDecoration: off ? "line-through" : "none" }}>
                  {s.model}
                </span>
                <span style={{ fontSize: 10, color: "var(--dsw-alias-label-tertiary)", flexShrink: 0 }}>{formatTokensShort(totalsByModel.get(s.model) ?? 0)}</span>
              </button>
            );
          })}
        </div>
        {series.length === 0 ? null : (
          <div style={{ fontSize: 10, color: "var(--dsw-alias-label-tertiary)", marginTop: 4 }}>{t("trend.legend.hint")}</div>
        )}
      </div>

      {/* chart + hover tooltip */}
      <div ref={wrapRef} style={{ position: "relative", padding: `4px ${CX_PAD}px 12px` }}>
        {topModels.length === 0 ? (
          <div style={{ padding: 24, textAlign: "center", fontSize: 14, color: "var(--dsw-alias-label-tertiary)" }}>{t("trend.empty")}</div>
        ) : (
          <svg
            viewBox={`0 0 ${W} ${H}`}
            width="100%"
            style={{ display: "block" }}
            role="img"
            aria-label={t("trend.title")}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
          >
            {/* y grid + labels */}
            {[0, 0.25, 0.5, 0.75, 1].map((f) => {
              const y = PAD.top + (1 - f) * plotH;
              return (
                <g key={f}>
                  <line x1={PAD.left} y1={y} x2={W - PAD.right} y2={y} stroke="var(--dsw-alias-border-l2)" strokeWidth={1} strokeDasharray={f === 0 ? undefined : "3 3"} />
                  <text x={PAD.left - 8} y={y + 5} textAnchor="end" fontSize={14} fill="var(--dsw-alias-label-tertiary)">
                    {formatTokensShort(yMax * f)}
                  </text>
                </g>
              );
            })}
            {/* x labels */}
            {tickIdx.map((i) => (
              <text key={i} x={xOf(i)} y={H - 10} textAnchor="middle" fontSize={14} fill="var(--dsw-alias-label-tertiary)">
                {fmtDay(dayKeys[i])}
              </text>
            ))}
            {/* hovered column guide */}
            {hover != null ? (
              <line x1={xOf(hover.idx)} y1={PAD.top} x2={xOf(hover.idx)} y2={PAD.top + plotH} stroke="var(--dsw-alias-label-tertiary)" strokeWidth={1} strokeDasharray="4 3" opacity={0.6} />
            ) : null}
            {/* smoothed lines + points */}
            {visible.map((s) => {
              const color = colorOf(s.model);
              const pts: Array<[number, number]> = s.points.map((v, i) => [xOf(i), yOf(v)]);
              return (
                <g key={s.model} opacity={0.8}>
                  <path d={seriesPath(pts)} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                  {/* 用量为 0 的日期不显示点 */}
                  {pts.map(([x, y], i) => (s.points[i] > 0 ? (
                    <circle key={i} cx={x} cy={y} r={hover?.idx === i ? 4 : 2} fill={color} />
                  ) : null))}
                </g>
              );
            })}
            {/* all lines hidden hint */}
            {visible.length === 0 ? (
              <text x={W / 2} y={PAD.top + plotH / 2} textAnchor="middle" fontSize={13} fill="var(--dsw-alias-label-tertiary)">
                {t("trend.legend.hint")}
              </text>
            ) : null}
          </svg>
        )}

        {/* compact translucent tooltip: date / day total / per-model totals, beside the cursor */}
        {hover != null && topModels.length > 0 ? (
          <div
            style={{
              position: "absolute",
              left: tipLeft,
              top: tipTop,
              width: tipW,
              opacity: 0.7,
              pointerEvents: "none",
              background: "var(--dsw-alias-bg-layer-3)",
              border: "1px solid var(--dsw-alias-border-l2)",
              borderRadius: 8,
              boxShadow: "0 6px 18px rgba(0,0,0,0.25)",
              padding: "6px 10px",
              fontSize: 11,
              lineHeight: 1.5,
              color: "var(--dsw-alias-label-primary)",
              zIndex: 5,
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>{fmtDayLong(dayKeys[hover.idx])}</div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontWeight: 600 }}>
              <span>{isEn ? "Total" : "消耗总量"}</span>
              <span>{formatTokensShort(hoverTotal)} tokens</span>
            </div>
            <div style={{ borderTop: "1px solid var(--dsw-alias-border-l2)", margin: "4px 0" }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {hoverRows.map((r) => (
                <div key={r.model} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 7, height: 7, borderRadius: 4, background: r.color, flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.model}>
                    {r.model}
                  </span>
                  <span style={{ fontWeight: 500, whiteSpace: "nowrap" }}>{formatTokensShort(r.value)} tokens</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default TrendChart;
