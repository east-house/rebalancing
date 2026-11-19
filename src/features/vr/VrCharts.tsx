import { useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from "react";
import { fillTotals, type VrCycle, type VrOrders } from "./vrModel";
import type { ReferenceClose } from "./vrPrices";

const H = 300;

/** 차트 컨테이너의 실제 폭(px). 좁은 화면에서도 글자가 줄어들지 않게 viewBox를 폭에 맞춘다. */
function useWidth(fallback = 760): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.clientWidth > 0) setWidth(Math.max(320, el.clientWidth));
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => { const w = Math.round(entry.contentRect.width); if (w > 0) setWidth(Math.max(320, w)); });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}
const M = { l: 64, r: 104, t: 14, b: 30 };
const DAY = 86_400_000;
const time = (date: string) => Date.parse(`${date}T00:00:00Z`);
const usd = (value: number, digits = 2) => `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

function linear(d0: number, d1: number, r0: number, r1: number) {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  return (v: number) => r0 + (v - d0) * k;
}

function niceTicks(min: number, max: number, count = 5): number[] {
  const raw = (max - min) / count || 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(v);
  return out;
}

function dateTicks(t0: number, t1: number, count = 5): number[] {
  const out: number[] = [];
  for (let i = 0; i <= count; i += 1) out.push(t0 + ((t1 - t0) * i) / count);
  return out;
}

const dateLabel = (t: number, long: boolean) => {
  const iso = new Date(t).toISOString();
  return long ? iso.slice(2, 7).replace("-", ".") : iso.slice(5, 10).replace("-", "/");
};

function domain(values: number[], pad = 0.06): [number, number] {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || Math.abs(hi) * 0.1 || 1;
  return [lo - span * pad, hi + span * pad];
}

/** 오른쪽 직접 라벨: 서로 12px 이상 떨어지도록 아래로 민다. */
function placeLabels<T extends { y: number }>(items: T[], gap = 13): (T & { ly: number })[] {
  const sorted = [...items].sort((a, b) => a.y - b.y);
  let last = -Infinity;
  return sorted.map((item) => {
    const ly = Math.max(item.y, last + gap);
    last = ly;
    return { ...item, ly };
  });
}

interface Hover { x: number; content: ReactNode }

function ChartFrame({ plotRef, W, label, legend, hover, onMove, onLeave, children }: {
  plotRef: RefObject<HTMLDivElement | null>; W: number; label: string; legend: ReactNode; hover: Hover | null;
  onMove: (svgX: number) => void; onLeave: () => void; children: ReactNode;
}) {
  function move(event: PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width > 0) onMove(((event.clientX - rect.left) / rect.width) * W);
  }
  return <figure className="vr-chart">
    <div className="vr-chart-legend">{legend}</div>
    <div className="vr-chart-plot" ref={plotRef}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} onPointerMove={move} onPointerLeave={onLeave}>
        {children}
        {hover && <line className="vr-chart-cross" x1={hover.x} x2={hover.x} y1={M.t} y2={H - M.b} />}
      </svg>
      {hover && <div className="vr-chart-tip" style={{ left: `${(hover.x / W) * 100}%` }} data-side={hover.x > W / 2 ? "left" : "right"}>{hover.content}</div>}
    </div>
  </figure>;
}

function Axes({ W, yTicks, y, xTicks, x, long }: { W: number; yTicks: number[]; y: (v: number) => number; xTicks: number[]; x: (t: number) => number; long: boolean }) {
  return <g className="vr-chart-axes">
    {yTicks.map((v) => <g key={v}><line x1={M.l} x2={W - M.r} y1={y(v)} y2={y(v)} /><text x={M.l - 8} y={y(v)} dy="0.32em" textAnchor="end">{usd(v, v >= 1000 ? 0 : 2)}</text></g>)}
    {xTicks.map((t) => <text key={t} x={x(t)} y={H - M.b + 18} textAnchor="middle">{dateLabel(t, long)}</text>)}
  </g>;
}

const Swatch = ({ kind }: { kind: string }) => <i className={`vr-swatch vr-swatch--${kind}`} aria-hidden="true" />;

interface BandPoint { t: number; date: string; close: number | null; shares: number; target: number; min: number; max: number; cycle: VrCycle }

const triangle = (x: number, y: number, up: boolean, r = 6) => up
  ? `M${x},${y - r} L${x + r},${y + r * 0.8} L${x - r},${y + r * 0.8} Z`
  : `M${x},${y + r} L${x + r},${y - r * 0.8} L${x - r},${y - r * 0.8} Z`;

/**
 * 종가 위에 목표가(V ÷ 보유 수량)와 최소가·최대가(V 최소·최대 ÷ 보유 수량)를 겹치고, 체결을 매수 ▲·매도 ▼ 지점으로 표시한다.
 * 종가가 최소가 아래로 내려가면 평가금이 V 최소 아래(매수 구간), 최대가 위로 올라가면 V 최대 위(매도 구간)이다.
 */
export function VrPriceBandChart({ cycles, prices, simulatedBeforeWeek }: { cycles: VrCycle[]; prices: ReferenceClose[]; simulatedBeforeWeek?: number }) {
  const [plotRef, W] = useWidth();
  const [hover, setHover] = useState<Hover | null>(null);
  const isSim = (c: VrCycle) => simulatedBeforeWeek != null && c.week < simulatedBeforeWeek;

  const model = useMemo(() => {
    const byCycle = cycles.map((c) => {
      const pts: BandPoint[] = [];
      const make = (date: string, close: number | null): BandPoint | null => {
        const shares = fillTotals(c, date).shares;
        if (shares <= 0) return null;
        return { t: time(date), date, close, shares, target: c.v / shares, min: c.lower / shares, max: c.upper / shares, cycle: c };
      };
      for (const p of prices) if (p.date >= c.startDate && p.date <= c.endDate) { const pt = make(p.date, p.close); if (pt) pts.push(pt); }
      if (pts.length === 0 || pts[pts.length - 1].date < c.endDate) { const pt = make(pts.length ? c.endDate : c.startDate, null); if (pt) pts.push(pt); }
      return { cycle: c, pts };
    }).filter((g) => g.pts.length > 0);
    if (byCycle.length === 0) return null;
    const t0 = time(byCycle[0].cycle.startDate);
    const t1 = time(byCycle[byCycle.length - 1].cycle.endDate) + DAY;
    const closes = prices.filter((p) => time(p.date) >= t0 && time(p.date) < t1);
    const fills = byCycle.flatMap((g) => (g.cycle.fills ?? []).map((f) => ({ ...f, sim: isSim(g.cycle) })));
    const values = [...closes.map((p) => p.close), ...byCycle.flatMap((g) => g.pts.flatMap((p) => [p.min, p.max])), ...fills.map((f) => f.price)];
    const [y0, y1] = domain(values);
    return { byCycle, t0, t1, closes, fills, y0, y1 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycles, prices, simulatedBeforeWeek]);

  if (!model) return <p className="vr-hint">표시할 데이터가 없습니다.</p>;
  const { byCycle, t0, t1, closes, fills, y0, y1 } = model;
  const x = linear(t0, t1, M.l, W - M.r);
  const y = linear(y0, y1, H - M.b, M.t);
  const xEnd = (g: { cycle: VrCycle; pts: BandPoint[] }, i: number) => i + 1 < g.pts.length ? x(g.pts[i + 1].t) : x(time(g.cycle.endDate) + DAY);
  const step = (g: { cycle: VrCycle; pts: BandPoint[] }, key: "target" | "min" | "max") =>
    g.pts.map((p, i) => `${i ? "L" : "M"}${x(p.t)},${y(p[key])} H${xEnd(g, i)}`).join(" ");
  const area = (g: { cycle: VrCycle; pts: BandPoint[] }) => {
    const top = g.pts.flatMap((p, i) => [`${x(p.t)},${y(p.max)}`, `${xEnd(g, i)},${y(p.max)}`]);
    const bottom = g.pts.flatMap((p, i) => [`${x(p.t)},${y(p.min)}`, `${xEnd(g, i)},${y(p.min)}`]).reverse();
    return `M${[...top, ...bottom].join(" L")} Z`;
  };
  const allPts = byCycle.flatMap((g) => g.pts);
  const lastPt = allPts[allPts.length - 1];
  const lastClose = closes[closes.length - 1];
  const labels = placeLabels([
    { key: "max", y: y(lastPt.max), text: `최대가 ${usd(lastPt.max)}` },
    { key: "target", y: y(lastPt.target), text: `목표가 ${usd(lastPt.target)}` },
    { key: "min", y: y(lastPt.min), text: `최소가 ${usd(lastPt.min)}` },
    ...(lastClose ? [{ key: "close", y: y(lastClose.close), text: `종가 ${usd(lastClose.close)}` }] : []),
  ]);
  const realStart = simulatedBeforeWeek != null ? byCycle.find((g) => !isSim(g.cycle)) : undefined;
  const hasSim = byCycle.some((g) => isSim(g.cycle));

  function move(svgX: number) {
    const candidates = allPts.filter((p) => p.close != null);
    if (candidates.length === 0) return;
    const nearest = candidates.reduce((best, p) => Math.abs(x(p.t) - svgX) < Math.abs(x(best.t) - svgX) ? p : best);
    const dayFills = fills.filter((f) => f.date === nearest.date);
    const close = nearest.close!;
    const zone = close < nearest.min ? "최소가 아래 · 매수 구간" : close > nearest.max ? "최대가 위 · 매도 구간" : "밴드 안";
    setHover({ x: x(nearest.t), content: <>
      <strong>{nearest.date} · {nearest.cycle.week}주차{isSim(nearest.cycle) ? " (백테스트)" : ""}</strong>
      <span><Swatch kind="price" />종가 {usd(close)}</span>
      <span><Swatch kind="v" />목표가 {usd(nearest.target)}</span>
      <span><Swatch kind="band" />최소~최대가 {usd(nearest.min)} ~ {usd(nearest.max)}</span>
      <span>보유 {nearest.shares}주 기준</span>
      {dayFills.map((f) => <span key={f.id}><Swatch kind={f.side} />{f.side === "buy" ? "매수" : "매도"} {f.quantity}주 × {usd(f.price)}</span>)}
      <em>{zone}</em>
    </> });
  }

  const long = t1 - t0 > 200 * DAY;
  return <ChartFrame plotRef={plotRef} W={W}
    label={`종가와 목표가·최소가·최대가, ${byCycle[0].cycle.week}주차부터 ${byCycle[byCycle.length - 1].cycle.week}주차까지`}
    legend={<><span><Swatch kind="price" />종가</span><span><Swatch kind="v" />목표가 (V ÷ 보유 수량)</span><span><Swatch kind="band" />최소가~최대가</span><span><Swatch kind="buy-pt" />매수 체결</span><span><Swatch kind="sell-pt" />매도 체결</span>{hasSim && <span><Swatch kind="sim" />백테스트 구간</span>}</>}
    hover={hover} onMove={move} onLeave={() => setHover(null)}>
    <Axes W={W} yTicks={niceTicks(y0, y1)} y={y} xTicks={dateTicks(t0, t1, W < 560 ? 3 : long ? 6 : 4)} x={x} long={long} />
    {byCycle.map((g) => <g key={g.cycle.index} className={isSim(g.cycle) ? "vr-chart-sim" : undefined}>
      <path className="vr-chart-band" d={area(g)} />
      <path className="vr-chart-edge" d={step(g, "max")} />
      <path className="vr-chart-edge" d={step(g, "min")} />
      <path className="vr-chart-v vr-chart-v--dash" d={step(g, "target")} />
      <line className="vr-chart-cycle-line" x1={x(time(g.cycle.startDate))} x2={x(time(g.cycle.startDate))} y1={M.t} y2={H - M.b} />
    </g>)}
    {realStart && hasSim && <text className="vr-chart-note" x={x(time(realStart.cycle.startDate)) + 4} y={M.t + 10}>실제 기록 →</text>}
    {closes.length > 0 && <path className="vr-chart-price" d={closes.map((p, i) => `${i ? "L" : "M"}${x(time(p.date))},${y(p.close)}`).join(" ")} />}
    {fills.map((f) => <path key={f.id} className={`vr-chart-fill vr-chart-fill--${f.side}${f.sim ? " is-sim" : ""}`} d={triangle(x(time(f.date)), y(f.price), f.side === "buy")}>
      <title>{`${f.date} ${f.side === "buy" ? "매수" : "매도"} ${f.quantity}주 × ${usd(f.price)}${f.sim ? " (백테스트)" : ""}`}</title>
    </path>)}
    {labels.map((l) => <text key={l.key} className="vr-chart-label" x={W - M.r + 8} y={l.ly} dy="0.32em">{l.text}</text>)}
  </ChartFrame>;
}

/** 종가가 지정가에 닿은 줄 수: 매수는 종가 ≤ 지정가, 매도는 종가 ≥ 지정가 */
export function countFills(orders: VrOrders, price: number) {
  return { buys: orders.buys.filter((r) => price <= r.price).length, sells: orders.sells.filter((r) => price >= r.price).length };
}
