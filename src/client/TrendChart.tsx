import * as React from "react";
import type { DayAgg } from "../aggregation.ts";
import { toDayKey } from "../date-bucket.ts";
import { recentDayKeys, pickTrendModels, buildSeries, buildOtherSeries, OTHER_KEY, seriesPathFixed, formatTokensShort } from "./trend.ts";

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

/** "z-ai/glm-5.3" -> "glm-5.3": display only the part after the last "/". */
function shortName(model: string): string {
  const i = model.lastIndexOf("/");
  return i >= 0 ? model.slice(i + 1) : model;
}

const W = 720;
const H = 280;
const PAD = { top: 10, right: 28, bottom: 34, left: 76 }; // right: 给最右日期标签留出空间，避免贴边裁字
/** chart container horizontal padding (must match the div below) */
const CX_PAD = 8;
const LS_TYPE_KEY = "dsh-token-pulse:trendChartType";
/** transition/animation duration for the value/axis morphs (one tempo everywhere) */
const DUR = ".55s";
const T_POS = `x ${DUR} ease, y ${DUR} ease, width ${DUR} ease, height ${DUR} ease`;
const T_D = `d ${DUR} ease`;
const T_POINT = `cx ${DUR} ease, cy ${DUR} ease, r .2s ease`;
const T_FADE = `opacity ${DUR} ease`;
const T_SHIFT = `transform ${DUR} ease`;
const GHOST_MS = 650;

/**
 * Stable color assignment per MODEL (not per rank): the same model keeps its
 * color across range switches and legend toggles, so the animation never
 * repaints a series. First-seen order locks the palette slot for good.
 * Module-level so the assignment survives closing/reopening the panel.
 */
const modelColorSlot = new Map<string, number>();
function colorFor(model: string): string {
  let slot = modelColorSlot.get(model);
  if (slot === undefined) {
    slot = modelColorSlot.size % COLORS.length;
    modelColorSlot.set(model, slot);
  }
  return COLORS[slot];
}

/**
 * Animation styles. Elements that ENTER on a range/type switch (CSS transitions
 * only animate elements that already existed) play a keyframe in the same 0.55s
 * tempo as the gliding elements, and elements that LEAVE stay mounted for one
 * beat as a "ghost" layer that collapses/fades — so the whole chart moves
 * together instead of mixing instant pops with in-flight marks.
 * The enter classes self-remove on animationend so live styles (hover opacity,
 * legend toggles) keep working afterwards.
 */
const ANIM_CSS = `
@keyframes dtp-grow { from { transform: scaleY(.02); opacity: .3; } }
@keyframes dtp-fadein { from { opacity: 0; } }
@keyframes dtp-shrink { to { transform: scaleY(.02); opacity: 0; } }
@keyframes dtp-fadeout { to { opacity: 0; } }
.dtp-growin { transform-box: fill-box; transform-origin: bottom; animation: dtp-grow ${DUR} ease; }
.dtp-fadein { animation: dtp-fadein ${DUR} ease; }
.dtp-ghost-bars { transform-box: fill-box; transform-origin: bottom; animation: dtp-shrink ${DUR} ease forwards; }
.dtp-ghost-lines { animation: dtp-fadeout ${DUR} ease forwards; }
`;

/**
 * Usage chart at the bottom of the settings section, two switchable forms:
 * - "line": one smoothed (monotone cubic) line per model over the days
 * - "bar":  one stacked bar per day, visible models layered bottom-up
 * Both share the legend (top-10 + week's top-3, chips toggle models), the
 * 7 / 30 / 90-day ranges and a compact translucent hover tooltip BESIDE the
 * cursor (date, day total, per-model totals sorted desc, zero rows hidden).
 *
 * Range/type switches animate as ONE coordinated beat: retained marks glide
 * by date identity (the last 7 days of a 30-day view sit in the rightmost
 * slots, so 7→30 slides the week's bars right+down), entering marks grow from
 * the baseline / fade in, and leaving marks collapse in a ghost overlay.
 * Model colors are locked to model identity, never to rank position.
 *
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
  const [chartType, setChartType] = React.useState<"line" | "bar">(() => {
    try { return localStorage.getItem(LS_TYPE_KEY) === "line" ? "line" : "bar"; } catch { return "bar"; }
  });
  const [hidden, setHidden] = React.useState<ReadonlySet<string>>(new Set());
  /** hovered column index + pointer position in wrapper px (for side placement) */
  const [hover, setHover] = React.useState<{ idx: number; px: number; py: number } | null>(null);
  /** one-beat overlay of the PREVIOUS layout's marks, collapsing out on switches */
  const [ghost, setGhost] = React.useState<{ marks: React.ReactNode; labels: React.ReactNode; type: "line" | "bar" } | null>(null);

  const endKey = toDayKey(Date.now());
  const dayKeys = React.useMemo(() => recentDayKeys(endKey, rangeDays), [endKey, rangeDays]);
  const weekKeys = React.useMemo(() => recentDayKeys(endKey, 7), [endKey]);
  // 范围前 9 + 近一周前 3 必进列表（本周冒头的模型在 30/90 天视图里也可见）；
  // 第 10 位固定为「其它」——聚合剩余所有模型，柱子总量即全天真实用量
  const topModels = React.useMemo(() => pickTrendModels(days, dayKeys, weekKeys, 9, 3), [days, dayKeys, weekKeys]);
  const series = React.useMemo(() => {
    const base = buildSeries(days, dayKeys, topModels);
    const other = buildOtherSeries(days, dayKeys, new Set(topModels));
    return other.points.some((v) => v > 0) ? [...base, other] : base;
  }, [days, dayKeys, topModels]);

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

  // previous-render identity sets (for enter animations) + last-render mark
  // nodes (reused as the ghost overlay on switches)
  const prevDaysRef = React.useRef<string[] | null>(null);
  const prevModelsRef = React.useRef<string[] | null>(null);
  const prevTickRef = React.useRef<string[] | null>(null);
  const prevTypeRef = React.useRef<"line" | "bar" | null>(null);
  const marksRef = React.useRef<React.ReactNode>(null);
  const labelsRef = React.useRef<React.ReactNode>(null);

  const toggle = (model: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(model)) next.delete(model);
      else next.add(model);
      return next;
    });
  };

  const colorOf = (model: string) => (model === OTHER_KEY ? "#8b949e" : colorFor(model));
  /** 其它 series 用固定中性灰；显示名：其它系列显示「其它/Other」，模型只显示 "/" 后半段 */
  const dispName = (model: string) => (model === OTHER_KEY ? t("model.others") : shortName(model));
  const isHidden = (model: string) => hidden.has(model);
  const visible = series.filter((s) => !isHidden(s.model));

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  // line mode: points spread edge-to-edge; bar mode: one slot per day
  const step = dayKeys.length > 1 ? plotW / (dayKeys.length - 1) : plotW;
  const xOf = (i: number) => PAD.left + (dayKeys.length > 1 ? i * step : plotW / 2);
  const slot = plotW / dayKeys.length;
  const barW = Math.max(2, slot * 0.6);
  const cxOf = (i: number) => PAD.left + slot * (i + 0.5);
  const anchorX = (i: number) => (chartType === "bar" ? cxOf(i) : xOf(i));
  // bars stack every visible model per day, so their axis max is the largest
  // daily stack total; lines scale by the largest single point
  const dayTotals = dayKeys.map((_, i) => visible.reduce((a, s) => a + s.points[i], 0));
  const yMax = chartType === "bar"
    ? niceCeil(Math.max(1, ...dayTotals))
    : niceCeil(Math.max(1, ...visible.map((s) => Math.max(0, ...s.points))));
  const yOf = (v: number) => PAD.top + (1 - v / yMax) * plotH;

  const fmtDay = (k: string) => `${Number(k.slice(5, 7))}/${Number(k.slice(8, 10))}`;
  const fmtDayLong = (k: string) =>
    isEn
      ? `${Number(k.slice(5, 7))}/${Number(k.slice(8, 10))}`
      : `${Number(k.slice(5, 7))}月${Number(k.slice(8, 10))}日`;
  // x tick indices: every day for a week, sparse ticks for month/quarter ranges
  const tickEvery = rangeDays === 7 ? 1 : rangeDays === 30 ? 5 : 10;
  const tickIdx = dayKeys.map((_, i) => i).filter((i) => i % tickEvery === 0 || i === dayKeys.length - 1);

  // enter-anim eligibility: element identities that did not exist last render
  const typeChanged = prevTypeRef.current !== null && prevTypeRef.current !== chartType;
  const isNewDay = (k: string) =>
    prevDaysRef.current !== null && (typeChanged || !prevDaysRef.current.includes(k));
  const isNewModel = (m: string) =>
    prevModelsRef.current !== null && (typeChanged || !prevModelsRef.current.includes(m));
  const isNewTick = (k: string) =>
    prevTickRef.current !== null && (typeChanged || !prevTickRef.current.includes(k));
  const enterCls = (isNew: boolean, grow: boolean) => (isNew ? (grow ? "dtp-growin" : "dtp-fadein") : undefined);
  const onAnimEnd = (e: React.AnimationEvent<SVGElement>) => {
    e.currentTarget.classList.remove("dtp-growin", "dtp-fadein");
  };

  React.useEffect(() => {
    marksRef.current = marksNode;
    labelsRef.current = labelsNode;
    prevDaysRef.current = dayKeys;
    // 按实际系列列表记身份（含「其它」），否则「其它」每次切换都被误判为新模型而重复长出
    prevModelsRef.current = series.map((s) => s.model);
    prevTickRef.current = tickIdx.map((i) => dayKeys[i]);
    prevTypeRef.current = chartType;
  });

  React.useEffect(() => {
    if (!ghost) return;
    const timer = setTimeout(() => setGhost(null), GHOST_MS);
    return () => clearTimeout(timer);
  }, [ghost]);

  const switchTo = (patch: { range?: 7 | 30 | 90; type?: "line" | "bar" }) => {
    // capture the CURRENT layout's mark nodes as the exiting ghost overlay
    setGhost({ marks: marksRef.current, labels: labelsRef.current, type: chartType });
    if (patch.range !== undefined) setRangeDays(patch.range);
    if (patch.type !== undefined) {
      setChartType(patch.type);
      try { localStorage.setItem(LS_TYPE_KEY, patch.type); } catch {}
    }
    setHover(null);
  };

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const wrapEl = wrapRef.current;
    if (!wrapEl) return;
    const wrapRect = wrapEl.getBoundingClientRect();
    const svgRect = e.currentTarget.getBoundingClientRect();
    const scale = svgRect.width / W || 1;
    const xvb = (e.clientX - svgRect.left) / scale;
    const i = chartType === "bar"
      ? Math.floor((xvb - PAD.left) / slot)
      : Math.round((xvb - PAD.left) / step);
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
  // vertically centered on the pointer, so the hovered mark is never covered
  const tipW = 200;
  const tipH = 56 + hoverRows.length * 19;
  const gap = 14;
  const svgW = Math.max(0, wrap.w - CX_PAD * 2);
  const colPx = hover == null ? 0 : CX_PAD + (anchorX(hover.idx) / W) * svgW;
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
  const segBtn = (active: boolean): React.CSSProperties => ({
    ...segStyle,
    background: active ? "var(--dsw-alias-label-primary)" : "transparent",
    color: active ? "var(--dsw-alias-bg-layer-3)" : "var(--dsw-alias-label-secondary)",
    transition: "background .25s ease, color .25s ease",
  });

  // ---- mark nodes (also captured as the ghost overlay on switches) ----
  const labelsNode = (
    <>
      {tickIdx.map((i) => (
        <text
          key={dayKeys[i]}
          x={0}
          y={0}
          textAnchor="middle"
          fontSize={14}
          fill="var(--dsw-alias-label-tertiary)"
          className={enterCls(isNewTick(dayKeys[i]), false)}
          onAnimationEnd={onAnimEnd}
          style={{ transform: `translate(${anchorX(i)}px, ${H - 10}px)`, transition: T_SHIFT }}
        >
          {fmtDay(dayKeys[i])}
        </text>
      ))}
    </>
  );

  const marksNode = chartType === "bar" ? (
    <>
      {dayKeys.map((k, i) => {
        const dayNew = isNewDay(k);
        let cum = 0;
        const segs = series.map((s) => {
          const v = isHidden(s.model) ? 0 : s.points[i];
          const yTop = yOf(cum + v);
          const h = v > 0 ? Math.max(0.5, yOf(cum) - yTop) : 0;
          cum += v;
          return (
            <rect
              key={s.model}
              x={cxOf(i) - barW / 2}
              y={yTop}
              width={barW}
              height={h}
              fill={colorOf(s.model)}
              className={enterCls(!dayNew && isNewModel(s.model), true)}
              onAnimationEnd={onAnimEnd}
              style={{ transition: T_POS }}
            />
          );
        });
        return (
          <g key={k} opacity={hover?.idx === i ? 1 : 0.8} className={enterCls(dayNew, true)} onAnimationEnd={onAnimEnd} style={{ transition: T_FADE }}>
            {segs}
          </g>
        );
      })}
    </>
  ) : (
    <>
      {series.map((s) => {
        const color = colorOf(s.model);
        const off = isHidden(s.model);
        const modelNew = isNewModel(s.model);
        const pts: Array<[number, number]> = s.points.map((v, i) => [xOf(i), yOf(v)]);
        return (
          <g key={s.model} opacity={off ? 0 : 0.8} className={enterCls(modelNew, false)} onAnimationEnd={onAnimEnd} style={{ transition: T_FADE }}>
            <path d={seriesPathFixed(pts)} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ transition: T_D }} />
            {/* 用量为 0 的日期不显示点；点按日期键控，跨范围切换时沿 x 轴滑动 */}
            {pts.map(([x, y], i) => (s.points[i] > 0 ? (
              <circle
                key={dayKeys[i]}
                cx={x}
                cy={y}
                r={hover?.idx === i ? 4 : 2}
                fill={color}
                className={enterCls(!modelNew && isNewDay(dayKeys[i]), false)}
                onAnimationEnd={onAnimEnd}
                style={{ transition: T_POINT }}
              />
            ) : null))}
          </g>
        );
      })}
    </>
  );

  return (
    <div
      style={{
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-layer-3)",
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      <style>{ANIM_CSS}</style>
      {/* header: title + chart-type switch (line/bar) + range switch */}
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
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ display: "inline-flex", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 6, overflow: "hidden" }}>
            {(["line", "bar"] as const).map((ty) => (
              <button key={ty} onClick={() => switchTo({ type: ty })} style={segBtn(chartType === ty)}>
                {ty === "line" ? t("trend.type.line") : t("trend.type.bar")}
              </button>
            ))}
          </div>
          <div style={{ display: "inline-flex", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 6, overflow: "hidden" }}>
            {([7, 30, 90] as const).map((n) => (
              <button
                key={n}
                onClick={() => switchTo({ range: n })}
                style={segBtn(rangeDays === n)}
              >
                {n === 7 ? t("trend.range7") : n === 30 ? t("trend.range30") : t("trend.range90")}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* legend chips: top-10 models of the range, 5 per row, click to toggle.
          Shows the short name (after "/") only — usage reads off the chart. */}
      <div style={{ padding: "10px 16px 4px" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 6 }}>
          {series.map((s) => {
            const off = isHidden(s.model);
            return (
              <button
                key={s.model}
                onClick={() => toggle(s.model)}
                title={s.model === OTHER_KEY ? dispName(s.model) : s.model}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "2px 8px",
                  borderRadius: 999,
                  border: "1px solid var(--dsw-alias-border-l2)",
                  background: "transparent",
                  cursor: "pointer",
                  opacity: off ? 0.35 : 1,
                  transition: T_FADE,
                  fontSize: 12,
                  color: "var(--dsw-alias-label-primary)",
                  minWidth: 0,
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: 4, background: colorOf(s.model), flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left", textDecoration: off ? "line-through" : "none" }}>
                  {dispName(s.model)}
                </span>
              </button>
            );
          })}
        </div>
        {series.length === 0 ? null : (
          <div style={{ fontSize: 11, color: "var(--dsw-alias-label-tertiary)", marginTop: 4 }}>{t("trend.legend.hint")}</div>
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
            {/* y grid + labels (path/transform so axis rescaling morphs smoothly) */}
            {[0, 0.25, 0.5, 0.75, 1].map((f) => {
              const y = PAD.top + (1 - f) * plotH;
              return (
                <g key={f}>
                  <path
                    d={`M ${PAD.left} ${y} L ${W - PAD.right} ${y}`}
                    fill="none"
                    stroke="var(--dsw-alias-border-l2)"
                    strokeWidth={1}
                    strokeDasharray={f === 0 ? undefined : "3 3"}
                    style={{ transition: T_D }}
                  />
                  <text
                    x={0}
                    y={0}
                    textAnchor="end"
                    fontSize={14}
                    fill="var(--dsw-alias-label-tertiary)"
                    style={{ transform: `translate(${PAD.left - 8}px, ${y + 5}px)`, transition: T_SHIFT }}
                  >
                    {formatTokensShort(yMax * f)}
                  </text>
                </g>
              );
            })}

            {/* ghost overlay: the previous layout's marks, collapsing out */}
            {ghost ? (
              <>
                <g className={ghost.type === "bar" ? "dtp-ghost-bars" : "dtp-ghost-lines"}>{ghost.marks}</g>
                <g className="dtp-ghost-lines">{ghost.labels}</g>
              </>
            ) : null}

            {labelsNode}
            {marksNode}

            {/* hovered column guide */}
            {hover != null ? (
              <path
                d={`M ${anchorX(hover.idx)} ${PAD.top} L ${anchorX(hover.idx)} ${PAD.top + plotH}`}
                fill="none"
                stroke="var(--dsw-alias-label-tertiary)"
                strokeWidth={1}
                strokeDasharray="4 3"
                opacity={0.6}
                style={{ transition: T_D }}
              />
            ) : null}

            {/* all models hidden hint */}
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
                    {dispName(r.model)}
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
