import * as React from "react";
import { levelByRank, logLevel, MIN_RANK_POINTS, type DayAgg } from "../aggregation.ts";

export type ViewKind = "week" | "month" | "quarter" | "year";

const VIEW_ORDER: ViewKind[] = ["week", "month", "quarter", "year"];

/** Thresholds (tokens/day). Day-grid only: above HIGH always level 4; below LOW
 *  always level 1; the band in between uses percentile ranking. Configurable in
 *  the ⋯ menu. Hour bars in the Week view ignore absolute thresholds entirely —
 *  they are rank-based only, so all four levels stay visible. */
export type LevelThresholds = { high: number; low: number };

export const DEFAULT_THRESHOLDS: LevelThresholds = { high: 100_000_000, low: 10_000_000 };

/**
 * Build a rank-based (percentile) level map for a day-window, keyed by dayKey.
 * Outlier-proof: a single huge day no longer flattens the rest of the window
 * to level 1. Falls back to log-scaled ratio when non-zero days are too few.
 * Absolute thresholds override ranking: >= high -> always 4, < low -> always 1.
 * (Day grids only — week-hour bars skip these, see buildHourLevels.)
 */
function buildDayLevels(days: DayAgg[], th: LevelThresholds): Map<string, number> {
  const nonZero = days
    .filter((d) => d.totalTokens > 0)
    .map((d) => d.totalTokens)
    .sort((a, b) => a - b);
  const viewMax = days.reduce((m, d) => Math.max(m, d.totalTokens), 0);
  const map = new Map<string, number>();
  for (const d of days) {
    let level: number;
    if (d.totalTokens <= 0) level = 0;
    else if (th.high > 0 && d.totalTokens >= th.high) level = 4;      // absolute deep green
    else if (th.low > 0 && d.totalTokens < th.low) level = 1;          // absolute light green
    else if (nonZero.length < MIN_RANK_POINTS) level = logLevel(d.totalTokens, viewMax);
    else level = levelByRank(d.totalTokens, nonZero);
    map.set(d.dayKey, level);
  }
  return map;
}

/**
 * Build rank-based level arrays for hour bars across a week (cross-day comparable).
 * Maps dayKey -> number[24] of levels. NO absolute thresholds here: the 37-ish
 * small hours would otherwise be pinned to level 1 and the mid band would pile
 * into 3/4, leaving level 2 empty. Pure rank keeps all four levels populated.
 */
function buildHourLevels(days: DayAgg[]): Map<string, number[]> {
  const nonZero: number[] = [];
  const raw = new Map<string, number[]>();
  for (const d of days) {
    const h = d.hourlyTokens ?? new Array(24).fill(0);
    raw.set(d.dayKey, h);
    for (const v of h) if (v > 0) nonZero.push(v);
  }
  nonZero.sort((a, b) => a - b);
  const weekMax = nonZero.length ? nonZero[nonZero.length - 1] : 1;
  const out = new Map<string, number[]>();
  for (const [k, h] of raw) {
    out.set(
      k,
      h.map((v) => {
        if (v <= 0) return 0;
        if (nonZero.length < MIN_RANK_POINTS) return logLevel(v, weekMax);
        return levelByRank(v, nonZero);
      }),
    );
  }
  return out;
}

function formatTokensShort(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1000) return (n / 1000).toFixed(2) + "k";
  return n.toLocaleString();
}

function tooltipTotal(day: DayAgg): string {
  if (day.totalTokens === 0) return `${day.dayKey}: No usage`;
  return `${day.dayKey}: ${formatTokensShort(day.totalTokens)} tokens`;
}

function HourStrip({ day, hourLevels, baseDelay = 0 }: { day: DayAgg; hourLevels: number[]; baseDelay?: number }) {
  const hourly = day.hourlyTokens ?? new Array(24).fill(0);
  const colors: Record<number, string> = {
    0: "var(--dsw-alias-bg-layer-2, #ebedf0)",
    1: "#c6e48b",
    2: "#7bc96f",
    3: "#239a3b",
    4: "#196127",
  };
  return (
    <div style={{ display: "flex", gap: 1, alignItems: "end", flex: 1, minWidth: 0 }}>
      {hourly.map((v, h) => {
        const lv = hourLevels[h] ?? 0;
        const hh = v === 0 ? `${String(h).padStart(2, "0")}:00 — No usage` : `${String(h).padStart(2, "0")}:00 — ${formatTokensShort(v)} tokens`;
        return (
          <div
            key={h}
            className="dtp-hm-bar"
            title={hh}
            aria-label={hh}
            style={{
              animationDelay: `${baseDelay + h * 12}ms`,
              flex: 1,
              height: 6 + lv * 4,
              borderRadius: 1,
              background: colors[lv],
              border: lv === 0 ? "1px solid var(--dsw-alias-border-l2)" : "none",
              boxSizing: "border-box",
              minWidth: 0,
            }}
          />
        );
      })}
    </div>
  );
}

function ViewSwitcher({
  t,
  value,
  onChange,
}: {
  t: (k: string, p?: any) => string;
  value: ViewKind;
  onChange: (v: ViewKind) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="view switcher"
      style={{
        display: "inline-flex",
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 8,
        overflow: "hidden",
        background: "var(--dsw-alias-bg-layer-3)",
      }}
    >
      {VIEW_ORDER.map((v) => (
        <button
          key={v}
          role="tab"
          aria-selected={value === v}
          onClick={() => onChange(v)}
          style={{
            padding: "6px 14px",
            fontSize: 13,
            lineHeight: "20px",
            border: "none",
            cursor: "pointer",
            background: value === v ? "var(--dsw-alias-label-primary)" : "transparent",
            color: value === v ? "var(--dsw-alias-bg-layer-3)" : "var(--dsw-alias-label-primary)",
            fontWeight: value === v ? 600 : 400,
          }}
        >
          {t(`view.${v}`)}
        </button>
      ))}
    </div>
  );
}

function GitHubGrid({ days, t, cellSize, twoRows, isEn, dayLevels }: { days: DayAgg[]; t: (k: string, p?: any) => string; cellSize: number; twoRows?: boolean; isEn?: boolean; dayLevels: Map<string, number> }) {
  const weeks: DayAgg[][] = [];
  let cur: DayAgg[] = [];
  for (const d of days) {
    const rawDow = new Date(d.dayKey + "T12:00:00+08:00").getDay();
    const dow = isEn ? rawDow : (rawDow + 6) % 7;
    if (cur.length === 0 && weeks.length === 0 && dow !== 0) {
      for (let i = 0; i < dow; i++) {
        cur.push({ dayKey: `pad-${i}`, totalTokens: -1, uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, count: 0, byModel: new Map(), byProvider: new Map(), hourlyTokens: new Array(24).fill(0), winnerModel: null, winnerProvider: null });
      }
    }
    cur.push(d);
    if (cur.length === 7) {
      weeks.push(cur);
      cur = [];
    }
  }
  if (cur.length > 0) {
    while (cur.length < 7) cur.push({ dayKey: `pad-end-${cur.length}`, totalTokens: -1, uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, count: 0, byModel: new Map(), byProvider: new Map(), hourlyTokens: new Array(24).fill(0), winnerModel: null, winnerProvider: null });
    weeks.push(cur);
  }

  const specHistoryRef = React.useRef(new Map<string, { x: number; y: number }>());
  const labelHistoryRef = React.useRef(new Set<string>());
  const gap = 3;
  const colGap = cellSize >= 22 ? 10 : 5;
  const headerH = 16;
  const blockH = 7 * cellSize + 6 * gap;
  const rowGap = 34;
  const twoRowsSplit = !!(twoRows && weeks.length > 26);
  const labelW = cellSize + 24;

  const dayByKey = new Map(days.map((d) => [d.dayKey, d]));
  const specs = new Map<string, { x: number; y: number }>();
  const monthLabels: { key: string; x: number; y: number }[] = [];
  const colX = (wi: number) => labelW + wi * (cellSize + colGap);
  const place = (ws: DayAgg[][], yBase: number) => {
    const seen = new Set<string>();
    ws.forEach((week, wi) => {
      const m = week.find((d) => d.totalTokens !== -1)?.dayKey.slice(0, 7) ?? "";
      if (m && !seen.has(m)) {
        seen.add(m);
        monthLabels.push({ key: m, x: colX(wi), y: yBase - 14 });
      }
      week.forEach((d, r) => {
        if (d.totalTokens === -1) return;
        specs.set(d.dayKey, { x: colX(wi), y: yBase + r * (cellSize + gap) });
      });
    });
  };

  let ncols: number;
  if (twoRowsSplit) {
    const mid = Math.ceil(weeks.length / 2);
    const top = weeks.slice(0, mid);
    const bot = weeks.slice(mid);
    place(top, headerH);
    place(bot, headerH + blockH + rowGap);
    ncols = Math.max(top.length, bot.length);
  } else {
    place(weeks, headerH);
    ncols = weeks.length;
  }
  const width = labelW + ncols * cellSize + Math.max(0, ncols - 1) * colGap;
  const height = twoRowsSplit ? headerH * 2 + blockH * 2 + rowGap : headerH + blockH;

  // morph bookkeeping (refs survive quarter<->year switches because the grid
  // stays mounted; on fresh mount history is empty so everything fades in)
  const prevSpecs = specHistoryRef.current;
  const items = [...specs.entries()].map(([k, s]) => ({ k, s, isNew: !prevSpecs.has(k) }));
  specHistoryRef.current = new Map(specs);
  const prevLabelKeys = labelHistoryRef.current;
  const labelIsNew = (k: string) => !prevLabelKeys.has(k);
  labelHistoryRef.current = new Set(monthLabels.map((m) => m.key));

  const [ghosts, setGhosts] = React.useState<{ k: string; x: number; y: number }[]>([]);
  React.useEffect(() => {
    const removed: { k: string; x: number; y: number }[] = [];
    for (const [k, s] of prevSpecs) if (!specs.has(k)) removed.push({ k, x: s.x, y: s.y });
    if (removed.length) {
      setGhosts(removed);
      const id = setTimeout(() => setGhosts([]), 300);
      return () => clearTimeout(id);
    }
  });

  const colors: Record<number, string> = {
    0: "var(--dsw-alias-bg-layer-2, #ebedf0)",
    1: "#c6e48b",
    2: "#7bc96f",
    3: "#239a3b",
    4: "#196127",
  };
  const dayNames = isEn ? ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"] : ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  const wdIdx = twoRowsSplit ? [0, 2, 4] : [0, 1, 2, 3, 4, 5, 6];
  const wdFontSize = cellSize >= 22 ? 13 : 10;
  const monthName = (m: string) => ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][Number(m.slice(5, 7)) - 1];

  return (
    <div className="dtp-hm-scroll" style={{ overflowX: "auto", scrollbarWidth: "none", paddingBottom: 4, display: "flex" }}>
      <div style={{ position: "relative", width, height, flexShrink: 0, margin: "0 auto" }}>
        {monthLabels.map((m) => (
          <span
            key={m.key}
            className={`dtp-hm-label${labelIsNew(m.key) ? " dtp-hm-new" : ""}`}
            style={{ transform: `translate(${m.x}px, ${m.y}px)`, fontSize: 10, color: "var(--dsw-alias-label-tertiary)", lineHeight: "12px" }}
          >
            {monthName(m.key)}
          </span>
        ))}
        {wdIdx.map((i) => ([
          { y: headerH + i * (cellSize + gap), k: `top-${i}` },
          ...(twoRowsSplit ? [{ y: headerH + blockH + rowGap + i * (cellSize + gap), k: `bot-${i}` }] : []),
        ].map(({ y, k }) => (
          <span
            key={k}
            className="dtp-hm-label"
            style={{ transform: `translate(0px, ${y}px)`, fontSize: wdFontSize, width: labelW - 6, textAlign: "right", paddingRight: 4, color: "var(--dsw-alias-label-tertiary)", lineHeight: `${cellSize}px`, fontWeight: 500 }}
          >
            {dayNames[i]}
          </span>
        ))))}
        {items.map(({ k, s, isNew }) => {
          const d = dayByKey.get(k)!;
          const lv = dayLevels.get(k) ?? 0;
          return (
            <div
              key={k}
              title={tooltipTotal(d)}
              aria-label={tooltipTotal(d)}
              className={`dtp-hm-cell${isNew ? " dtp-hm-new" : ""}`}
              style={{ transform: `translate(${s.x}px, ${s.y}px)`, width: cellSize, height: cellSize, borderRadius: 3, background: colors[lv], border: lv === 0 ? "1px solid var(--dsw-alias-border-l2, #e5e7eb)" : "1px solid transparent" }}
            />
          );
        })}
        {ghosts.map((g) => {
          const d = dayByKey.get(g.k);
          const lv = d ? dayLevels.get(g.k) ?? 0 : 0;
          return (
            <div
              key={g.k}
              className="dtp-hm-cell dtp-hm-ghost"
              style={{ transform: `translate(${g.x}px, ${g.y}px)`, width: cellSize, height: cellSize, borderRadius: 3, background: colors[lv] }}
            />
          );
        })}
      </div>
    </div>
  );
}

function CalendarGrid({ days, t, dayLevels, selectedKey, onSelect, isEn }: { days: DayAgg[]; t: (k:string,p?:any)=>string; dayLevels: Map<string, number>; selectedKey: string | null; onSelect: (k: string | null) => void; isEn?: boolean }) {
  const weekdaysZh = ["一","二","三","四","五","六","日"];
  const weekdaysEn = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  const isZh = (t("heatmap.title") || "").includes("Token") ? false : false;
  // Use locale-aware: check if nav is Chinese
  const header = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  const headerZh = ["一","二","三","四","五","六","日"];
  // Simple: show Mon-Sun always (github style), but tint weekend header
  const firstDow = firstDowOf(days);
  const pad = firstDow;
  const cells: (DayAgg | null)[] = [];
  for (let i = 0; i < pad; i++) cells.push(null);
  for (const d of days) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  function firstDowOf(ds: DayAgg[]): number {
    if (ds.length === 0) return 0;
    const raw = new Date(ds[0].dayKey + "T12:00:00+08:00").getDay();
    return isEn ? raw : (raw + 6) % 7;
  }

  return (
    <div style={{ border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 12, overflow: "hidden", background: "var(--dsw-alias-bg-layer-3)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6, padding: "8px 6px 6px" }}>
        {(isEn ? ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"] : header).map((w) => (
          <div key={w} style={{ textAlign: "center", fontSize: 10, fontWeight: 500, color: "var(--dsw-alias-label-tertiary)" }}>
            {w}
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6, padding: "0 6px" }}>
        {cells.map((d, idx) => {
          if (!d) return <div key={`pad-${idx}`} style={{ minHeight: 50 }} />;
          const selected = d.dayKey === selectedKey;
          const level = dayLevels.get(d.dayKey) ?? 0;
          const bgMap: Record<number,string> = { 0: "var(--dsw-alias-bg-layer-3)", 1: "#c6e48b", 2: "#7bc96f", 3: "#239a3b", 4: "#196127" };
          return (
            <button
              key={d.dayKey}
              onClick={() => onSelect(selected ? null : d.dayKey)}
              title={tooltipTotal(d)}
              aria-label={tooltipTotal(d)}
              style={{
                minHeight: 50,
                padding: "6px 6px 4px",
                textAlign: "left",
                border: selected ? "1.5px solid var(--dsw-alias-brand-primary, #1677ff)" : "1px solid var(--dsw-alias-border-l2, #e5e7eb)",
                borderRadius: 8,
                background: selected ? "var(--dsw-alias-brand-primary, #1677ff)" : bgMap[level],
                color: selected ? "#fff" : level === 0 ? "var(--dsw-alias-label-primary)" : level <= 2 ? "#1a1a1a" : "#fff",
                cursor: "pointer",
                display: "flex",
                flexDirection: "column",
                gap: 1,
                alignItems: "flex-start",
              }}
            >
              <span style={{ fontSize: 12, fontWeight: 600, lineHeight: "16px" }}>{d.dayKey.slice(8, 10).replace(/^0/, "")}</span>
              <span style={{ fontSize: 10, lineHeight: "12px", opacity: 0.8, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>{d.totalTokens > 0 ? formatTokensShort(d.totalTokens) : ""}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

const HM_ANIM_CSS = `
@keyframes dtp-hm-in { from { opacity: 0; transform: translateY(8px); } }
@keyframes dtp-hm-row { from { opacity: 0; transform: translateX(-14px); } }
@keyframes dtp-hm-grow { from { transform: scaleY(0); } }
@keyframes dtp-hm-fade { from { opacity: 0; } }
@keyframes dtp-hm-fadeout { to { opacity: 0; } }
.dtp-hm-view { animation: dtp-hm-in 0.4s ease; }
.dtp-hm-row { animation: dtp-hm-row 0.4s ease both; }
.dtp-hm-bar { transform-origin: bottom; animation: dtp-hm-grow 0.45s ease both; }
.dtp-hm-cell { position: absolute; box-sizing: border-box; transition: transform 0.45s ease, width 0.45s ease, height 0.45s ease, opacity 0.45s ease; }
.dtp-hm-new { animation: dtp-hm-fade 0.45s ease both; }
.dtp-hm-ghost { animation: dtp-hm-fadeout 0.25s ease forwards; }
.dtp-hm-scroll { scrollbar-width: none; }
.dtp-hm-scroll::-webkit-scrollbar { display: none; }
.dtp-hm-label { position: absolute; white-space: nowrap; transition: transform 0.45s ease, opacity 0.45s ease; }
`;

export function HeatmapGrid({
  t,
  days,
  view,
  onViewChange,
  selectedKey,
  onSelect,
  isEn,
  thresholds = DEFAULT_THRESHOLDS,
}: {
  t: (k: string, p?: any) => string;
  days: DayAgg[];
  view: ViewKind;
  onViewChange: (v: ViewKind) => void;
  selectedKey?: string | null;
  onSelect?: (k: string | null) => void;
  isEn?: boolean;
  thresholds?: LevelThresholds;
}) {
  const isWeek = view === "week";
  const hasAny = days.some((d) => d.totalTokens > 0);
  const dayLevels = buildDayLevels(days, thresholds);
  const hourLevels = buildHourLevels(days);
  const cellSize = isWeek ? 16 : view === "quarter" ? 23 : (view === "year" ? 14 : 14);

  const handleViewChange = (v: ViewKind) => {
    onSelect?.(null);
    onViewChange(v);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <style>{HM_ANIM_CSS}</style>
      <ViewSwitcher t={t} value={view} onChange={handleViewChange} />

      {!hasAny ? (
        <div
          style={{
            border: "1px solid var(--dsw-alias-border-l2)",
            background: "var(--dsw-alias-bg-layer-3)",
            borderRadius: 12,
            padding: 24,
            color: "var(--dsw-alias-label-tertiary)",
            fontSize: 13,
          }}
        >
          {t("heatmap.empty")}
        </div>
      ) : null}

      {isWeek ? (
        <div key="week" style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {days.map((d, di) => {
            const wd = new Date(d.dayKey + "T12:00:00+08:00").getDay();
            const weekday = isEn
              ? ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][wd]
              : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][(wd + 6) % 7];
            const sel = d.dayKey === selectedKey;
            return (
              <button
                key={d.dayKey}
                className="dtp-hm-row"
                onClick={() => onSelect?.(sel ? null : d.dayKey)}
                title={tooltipTotal(d)}
                style={{
                  animationDelay: `${di * 45}ms`,
                  display: "flex", alignItems: "center", gap: 10, minWidth: 0, width: "100%",
                  padding: "6px 8px", borderRadius: 8,
                  border: sel ? "1px solid var(--dsw-alias-brand-primary)" : "1px solid transparent",
                  background: sel ? "var(--dsw-alias-bg-layer-2)" : "transparent",
                  cursor: "pointer", textAlign: "left",
                }}
              >
                <div style={{ width: 52, flexShrink: 0, display: "flex", flexDirection: "column", gap: 1 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: "var(--dsw-alias-label-primary)", lineHeight: "16px" }}>{weekday}</span>
                  <span style={{ fontSize: 10, color: "var(--dsw-alias-label-tertiary)", lineHeight: "12px" }}>{d.dayKey.slice(5)}</span>
                </div>
                <HourStrip day={d} hourLevels={hourLevels.get(d.dayKey) ?? new Array(24).fill(0)} baseDelay={di * 45 + 140} />
                <span style={{ fontSize: 11, color: "var(--dsw-alias-label-tertiary)", whiteSpace: "nowrap", width: 80, textAlign: "right" }}>
                  {d.totalTokens === 0 ? "No usage" : `${formatTokensShort(d.totalTokens)} tokens`}
                </span>
              </button>
            );
          })}
        </div>
      ) : view === "month" ? (
        <div key="month" className="dtp-hm-view">
          <CalendarGrid days={days} t={t} dayLevels={dayLevels} selectedKey={selectedKey ?? null} onSelect={onSelect ?? (() => {})} isEn={isEn} />
        </div>
      ) : (
        <div key="github" className="dtp-hm-view">
          <GitHubGrid days={days} t={t} cellSize={cellSize} twoRows={view === "year"} isEn={isEn} dayLevels={dayLevels} />
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end", fontSize: 12, color: "var(--dsw-alias-label-tertiary)" }}>
        <span>{t("heatmap.legend.less")}</span>
        <span style={{ width: 12, height: 12, borderRadius: 2, background: "var(--dsw-alias-bg-layer-2, #ebedf0)", border: "1px solid var(--dsw-alias-border-l2)" }} />
        <span style={{ width: 12, height: 12, borderRadius: 2, background: "#c6e48b" }} />
        <span style={{ width: 12, height: 12, borderRadius: 2, background: "#7bc96f" }} />
        <span style={{ width: 12, height: 12, borderRadius: 2, background: "#239a3b" }} />
        <span style={{ width: 12, height: 12, borderRadius: 2, background: "#196127" }} />
        <span>{t("heatmap.legend.more")}</span>
      </div>
    </div>
  );
}

export default HeatmapGrid;
