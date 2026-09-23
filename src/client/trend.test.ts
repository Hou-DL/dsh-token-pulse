import { describe, it, expect } from "vitest";
import type { DayAgg } from "../aggregation.ts";
import {
  recentDayKeys,
  pickTopModels,
  pickTrendModels,
  buildSeries,
  monotoneSegments,
  seriesPath,
  formatTokensShort,
} from "./trend.ts";

function mkDay(dayKey: string, byModel: Record<string, number>): DayAgg {
  let totalTokens = 0;
  for (const v of Object.values(byModel)) totalTokens += v;
  return {
    dayKey,
    totalTokens,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    count: 0,
    byModel: new Map(Object.entries(byModel)),
    byProvider: new Map(),
    hourlyTokens: new Array(24).fill(0),
    winnerModel: null,
    winnerProvider: null,
  };
}

describe("recentDayKeys", () => {
  it("returns N consecutive day keys ending at endKey (inclusive)", () => {
    expect(recentDayKeys("2026-08-27", 7)).toEqual([
      "2026-08-21", "2026-08-22", "2026-08-23", "2026-08-24",
      "2026-08-25", "2026-08-26", "2026-08-27",
    ]);
  });

  it("crosses month boundaries correctly", () => {
    expect(recentDayKeys("2026-09-02", 3)).toEqual(["2026-08-31", "2026-09-01", "2026-09-02"]);
  });
});

describe("pickTopModels", () => {
  const days = [
    mkDay("2026-08-20", { Z: 999 }),        // outside the window — must be ignored
    mkDay("2026-08-26", { A: 50, B: 100 }),
    mkDay("2026-08-27", { A: 60, C: 10 }),
  ];

  it("ranks models by total tokens summed over the window only", () => {
    const keys = ["2026-08-26", "2026-08-27"];
    expect(pickTopModels(days, keys, 5)).toEqual(["A", "B", "C"]); // A=110, B=100, C=10, Z excluded
  });

  it("respects the limit k", () => {
    const keys = ["2026-08-26", "2026-08-27"];
    expect(pickTopModels(days, keys, 2)).toEqual(["A", "B"]);
  });
});

describe("pickTrendModels", () => {
  // 30-day range where A..J have big usage early on and K/L/M are new this week:
  // range ranks are A..J then K(500) L(400) M(300); week top-3 is K, L, M.
  const mk = () => {
    const days: DayAgg[] = [];
    const weekKeys = ["2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28", "2026-08-29", "2026-08-30"];
    const rangeKeys = recentDayKeys("2026-08-30", 30);
    const early = rangeKeys.filter((k) => !weekKeys.includes(k));
    const named = "ABCDEFGHIJ".split("");
    named.forEach((m, i) => days.push(mkDay(early[0], { [m]: 10000 - i * 1000 })));
    days.push(mkDay("2026-08-25", { K: 500 }), mkDay("2026-08-26", { L: 400 }), mkDay("2026-08-27", { M: 300 }));
    return { days, rangeKeys, weekKeys };
  };

  it("guarantees the week's top-3 even when they rank below the range top-k", () => {
    const { days, rangeKeys, weekKeys } = mk();
    const out = pickTrendModels(days, rangeKeys, weekKeys, 10, 3);
    expect(out).toContain("K");
    expect(out).toContain("L");
    expect(out).toContain("M");
  });

  it("keeps the list at k by dropping the weakest range-ranked models", () => {
    const { days, rangeKeys, weekKeys } = mk();
    const out = pickTrendModels(days, rangeKeys, weekKeys, 10, 3);
    expect(out.length).toBe(10);
    // fill order follows range rank: A..G join K/L/M; H..J fall out
    expect(out).toEqual(["A", "B", "C", "D", "E", "F", "G", "K", "L", "M"]);
  });

  it("dedupes when the week's top-3 are already inside the range top-k", () => {
    const days = [
      mkDay("2026-08-30", { X: 100, Y: 90, Z: 80, W: 70, V: 60, U: 50, T: 40, S: 30, R: 20, Q: 10, P: 5 }),
    ];
    const keys = ["2026-08-30"];
    const out = pickTrendModels(days, keys, keys, 10, 3);
    expect(out).toEqual(pickTopModels(days, keys, 10));
    expect(new Set(out).size).toBe(out.length);
  });
});

describe("buildSeries", () => {
  const days = [
    mkDay("2026-08-26", { A: 50, B: 100 }),
    mkDay("2026-08-27", { A: 60 }),
  ];

  it("builds one aligned series per model, zero-filling missing days", () => {
    const keys = ["2026-08-25", "2026-08-26", "2026-08-27"];
    const series = buildSeries(days, keys, ["A", "B"]);
    expect(series).toEqual([
      { model: "A", points: [0, 50, 60] },
      { model: "B", points: [0, 100, 0] },
    ]);
  });
});

/** Evaluate a cubic bezier y at parameter t (for overshoot assertions). */
function bezY(seg: ReturnType<typeof monotoneSegments>[number], t: number): number {
  const mt = 1 - t;
  return mt * mt * mt * seg.p0[1] + 3 * mt * mt * t * seg.c1[1] + 3 * mt * t * t * seg.c2[1] + t * t * t * seg.p1[1];
}

describe("monotoneSegments", () => {
  it("emits one cubic segment per consecutive point pair", () => {
    const pts: Array<[number, number]> = [[0, 0], [1, 5], [2, 3]];
    const segs = monotoneSegments(pts);
    expect(segs.length).toBe(2);
    expect(segs[0].p0).toEqual([0, 0]);
    expect(segs[1].p1).toEqual([2, 3]);
  });

  it("does not overshoot on a spike (stay within [0,10])", () => {
    const pts: Array<[number, number]> = [[0, 0], [1, 10], [2, 0]];
    for (const seg of monotoneSegments(pts)) {
      for (let i = 0; i <= 32; i++) {
        const y = bezY(seg, i / 32);
        expect(y).toBeGreaterThanOrEqual(-1e-9);
        expect(y).toBeLessThanOrEqual(10 + 1e-9);
      }
    }
  });

  it("does not overshoot on a step (stay within [0,10])", () => {
    const pts: Array<[number, number]> = [[0, 0], [1, 0], [2, 10], [3, 10]];
    for (const seg of monotoneSegments(pts)) {
      for (let i = 0; i <= 32; i++) {
        const y = bezY(seg, i / 32);
        expect(y).toBeGreaterThanOrEqual(-1e-9);
        expect(y).toBeLessThanOrEqual(10 + 1e-9);
      }
    }
  });
});

describe("seriesPath", () => {
  it("single point renders a moveto only", () => {
    const d = seriesPath([[5, 5]]);
    expect(d.startsWith("M")).toBe(true);
    expect(d).not.toContain("C");
    expect(d).not.toContain("NaN");
  });

  it("multi-point path has curves and no NaN", () => {
    const d = seriesPath([[0, 30], [10, 10], [20, 25]]);
    expect(d.startsWith("M")).toBe(true);
    expect(d).toContain("C");
    expect(d).not.toContain("NaN");
  });
});

describe("formatTokensShort", () => {
  it("scales B/M/k with 2 decimals", () => {
    expect(formatTokensShort(1_234_567_890)).toBe("1.23B");
    expect(formatTokensShort(1_500_000)).toBe("1.50M");
    expect(formatTokensShort(1_500)).toBe("1.50k");
    expect(formatTokensShort(500)).toBe("500");
  });
});
