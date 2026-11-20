import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from "react";
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
const M = { l: 8, r: 8, t: 14, b: 30 };
/** 한 화면에 보이는 기간(일). 나머지는 좌우로 스크롤한다. */
const VIEW_DAYS = 14;
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

interface Hover { x: number; content: ReactNode }

function ChartFrame({ plotRef, scrollRef, W, label, legend, now, hover, onMove, onLeave, children }: {
  plotRef: RefObject<HTMLDivElement | null>; scrollRef: RefObject<HTMLDivElement | null>; W: number; label: string; legend: ReactNode; now: ReactNode; hover: Hover | null;
  onMove: (svgX: number) => void; onLeave: () => void; children: ReactNode;
}) {
  function move(event: PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width > 0) onMove(((event.clientX - rect.left) / rect.width) * W);
  }
  // 마우스는 그래프를 벗어나면, 손가락은 떼거나 밀어서 스크롤이 시작되면 금액 상자를 지운다.
  function leave(event: PointerEvent<SVGSVGElement>) { if (event.pointerType === "mouse") onLeave(); }
  function release(event: PointerEvent<SVGSVGElement>) { if (event.pointerType !== "mouse") onLeave(); }
  const view = scrollRef.current;
  const tipLeft = hover != null && view != null && hover.x - view.scrollLeft > view.clientWidth / 2;
  return <figure className="vr-chart" role="img" aria-label={label}>
    <div className="vr-chart-legend">{legend}</div>
    {now}
    <div className="vr-chart-plot" ref={plotRef}>
      <div className="vr-chart-scroll" ref={scrollRef}>
        <div className="vr-chart-canvas" style={{ width: W }}>
          <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" onPointerMove={move} onPointerDown={move} onPointerLeave={leave} onPointerUp={release} onPointerCancel={release}>
            {children}
            {hover && <line className="vr-chart-cross" x1={hover.x} x2={hover.x} y1={M.t} y2={H - M.b} />}
          </svg>
        </div>
      </div>
      {hover && <div className="vr-chart-tip" data-side={tipLeft ? "left" : "right"}>{hover.content}</div>}
    </div>
  </figure>;
}

/** 가로 눈금선(값 글자 없음)과 날짜 */
function Axes({ W, yTicks, y, xTicks, x }: { W: number; yTicks: number[]; y: (v: number) => number; xTicks: number[]; x: (t: number) => number }) {
  return <g className="vr-chart-axes">
    {yTicks.map((v) => <line key={v} x1={0} x2={W} y1={y(v)} y2={y(v)} />)}
    {xTicks.map((t) => <text key={t} x={x(t)} y={H - M.b + 18} textAnchor="middle">{dateLabel(t, false)}</text>)}
  </g>;
}

const Swatch = ({ kind }: { kind: string }) => <i className={`vr-swatch vr-swatch--${kind}`} aria-hidden="true" />;

interface BandPoint { t: number; date: string; close: number | null; shares: number; target: number; min: number; max: number; cycle: VrCycle }

const triangle = (x: number, y: number, up: boolean, r = 6) => up
  ? `M${x},${y - r} L${x + r},${y + r * 0.8} L${x - r},${y + r * 0.8} Z`
  : `M${x},${y + r} L${x + r},${y - r * 0.8} L${x - r},${y - r * 0.8} Z`;

/**
 * 종가 위에 V·V 최소·V 최대를 1주 가격(금액 ÷ 보유 수량)으로 바꿔 겹치고, 체결을 매수 ▲·매도 ▼ 지점으로 표시한다.
 * 종가가 최소가 아래로 내려가면 평가금이 V 최소 아래(매수 구간), 최대가 위로 올라가면 V 최대 위(매도 구간)이다.
 */
export function VrPriceBandChart({ cycles, prices }: { cycles: VrCycle[]; prices: ReferenceClose[] }) {
  const [plotRef, boxW] = useWidth();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const isSim = (c: VrCycle) => Boolean(c.estimated);

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
    return { byCycle, t0, t1, closes, fills };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycles, prices]);

  // 보이는 폭에 2주(VIEW_DAYS)가 들어가도록 전체 폭을 늘리고, 처음에는 가장 최근(오른쪽 끝)을 보여 준다.
  const viewW = Math.max(200, boxW);
  const days = model ? (model.t1 - model.t0) / DAY : VIEW_DAYS;
  const W = Math.max(viewW, Math.round((viewW * days) / VIEW_DAYS));
  const [scrollLeft, setScrollLeft] = useState(0);
  useEffect(() => { const el = scrollRef.current; if (el) { el.scrollLeft = el.scrollWidth; setScrollLeft(el.scrollLeft); } }, [W, model]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => { setScrollLeft(el.scrollLeft); setHover(null); };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [model]);

  if (!model) return <p className="vr-hint">표시할 데이터가 없습니다.</p>;
  const { byCycle, t0, t1, closes, fills } = model;
  const x = linear(t0, t1, M.l, W - M.r);
  // 세로 범위와 오른쪽 라벨은 지금 화면에 보이는 기간에 맞춘다(왼쪽 가격 눈금이 없으므로).
  const tAt = (px: number) => t0 + ((px - M.l) / Math.max(1, W - M.l - M.r)) * (t1 - t0);
  const tA = tAt(scrollLeft) - DAY;
  const tB = tAt(scrollLeft + viewW) + DAY;
  const allPts = byCycle.flatMap((g) => g.pts);
  const inView = (t: number) => t >= tA && t <= tB;
  const visValues = [
    ...closes.filter((p) => inView(time(p.date))).map((p) => p.close),
    ...allPts.filter((p) => inView(p.t)).flatMap((p) => [p.min, p.max]),
    ...fills.filter((f) => inView(time(f.date))).map((f) => f.price),
  ];
  const [y0, y1] = domain(visValues.length ? visValues : [...closes.map((p) => p.close), ...allPts.flatMap((p) => [p.min, p.max])]);
  const y = linear(y0, y1, H - M.b, M.t);
  const xEnd = (g: { cycle: VrCycle; pts: BandPoint[] }, i: number) => i + 1 < g.pts.length ? x(g.pts[i + 1].t) : x(time(g.cycle.endDate) + DAY);
  const step = (g: { cycle: VrCycle; pts: BandPoint[] }, key: "target" | "min" | "max") =>
    g.pts.map((p, i) => `${i ? "L" : "M"}${x(p.t)},${y(p[key])} H${xEnd(g, i)}`).join(" ");
  const area = (g: { cycle: VrCycle; pts: BandPoint[] }) => {
    const top = g.pts.flatMap((p, i) => [`${x(p.t)},${y(p.max)}`, `${xEnd(g, i)},${y(p.max)}`]);
    const bottom = g.pts.flatMap((p, i) => [`${x(p.t)},${y(p.min)}`, `${xEnd(g, i)},${y(p.min)}`]).reverse();
    return `M${[...top, ...bottom].join(" L")} Z`;
  };
  // 범례 아래 한 줄: 현재 주차 값(금액, 괄호는 1주 가격)
  const lastPt = allPts[allPts.length - 1];
  const lastClose = closes[closes.length - 1];
  const lastShares = (lastClose && allPts.find((p) => p.date === lastClose.date)?.shares) ?? lastPt.shares;
  const nowRow = <dl className="vr-chart-now">
    <div><dt>{lastPt.cycle.week}주차</dt><dd>보유 {lastShares}주</dd></div>
    <div><dt>V 최대</dt><dd>{usd(lastPt.cycle.upper, 0)} <small>({usd(lastPt.max)})</small></dd></div>
    <div><dt>V</dt><dd>{usd(lastPt.cycle.v, 0)} <small>({usd(lastPt.target)})</small></dd></div>
    <div><dt>V 최소</dt><dd>{usd(lastPt.cycle.lower, 0)} <small>({usd(lastPt.min)})</small></dd></div>
    {lastClose && <div><dt>평가금</dt><dd>{usd(lastClose.close * lastShares, 0)} <small>(종가 {usd(lastClose.close)})</small></dd></div>}
  </dl>;
  const realStart = byCycle.find((g) => !isSim(g.cycle));
  const hasSim = byCycle.some((g) => isSim(g.cycle));

  function move(svgX: number) {
    const candidates = allPts.filter((p) => p.close != null);
    if (candidates.length === 0) return;
    const nearest = candidates.reduce((best, p) => Math.abs(x(p.t) - svgX) < Math.abs(x(best.t) - svgX) ? p : best);
    const dayFills = fills.filter((f) => f.date === nearest.date);
    const close = nearest.close!;
    const zone = close < nearest.min ? "V 최소 아래 · 매수 구간" : close > nearest.max ? "V 최대 위 · 매도 구간" : "밴드 안";
    setHover({ x: x(nearest.t), content: <>
      <strong>{nearest.date} · {nearest.cycle.week}주차{isSim(nearest.cycle) ? " (추정)" : ""}</strong>
      <span><Swatch kind="price" />평가금 {usd(close * nearest.shares, 0)} (종가 {usd(close)})</span>
      <span><Swatch kind="v" />V {usd(nearest.cycle.v, 0)} ({usd(nearest.target)})</span>
      <span><Swatch kind="band" />V 최소~최대 {usd(nearest.cycle.lower, 0)} ~ {usd(nearest.cycle.upper, 0)} ({usd(nearest.min)} ~ {usd(nearest.max)})</span>
      <span>괄호는 1주 가격 = 금액 ÷ 보유 {nearest.shares}주</span>
      {dayFills.map((f) => <span key={f.id}><Swatch kind={f.side} />{f.side === "buy" ? "매수" : "매도"} {f.quantity}주 × {usd(f.price)}</span>)}
      <em>{zone}</em>
    </> });
  }

  // 날짜 눈금: 7일마다(주차 시작일과 그 중간)
  const xTicks: number[] = [];
  for (let t = t0; t < t1; t += 7 * DAY) xTicks.push(t);
  return <ChartFrame plotRef={plotRef} scrollRef={scrollRef} W={W}
    label={`평가금과 V·V 최소·V 최대(1주 가격), ${byCycle[0].cycle.week}주차부터 ${byCycle[byCycle.length - 1].cycle.week}주차까지`}
    legend={<><span><Swatch kind="price" />평가금 (보유 수량 × 종가)</span><span><Swatch kind="v" />V 목표</span><span><Swatch kind="band" />V 최소~최대</span><span><Swatch kind="buy-pt" />매수 체결</span><span><Swatch kind="sell-pt" />매도 체결</span>{hasSim && <span><Swatch kind="sim" />추정 지난 기록</span>}{W > viewW && <span className="vr-chart-legend-note">← 좌우로 밀어 지난 기간 보기</span>}</>}
    now={nowRow} hover={hover} onMove={move} onLeave={() => setHover(null)}>
    <Axes W={W} yTicks={niceTicks(y0, y1)} y={y} xTicks={xTicks} x={x} />
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
      <title>{`${f.date} ${f.side === "buy" ? "매수" : "매도"} ${f.quantity}주 × ${usd(f.price)}${f.sim ? " (추정)" : ""}`}</title>
    </path>)}
  </ChartFrame>;
}

/** 종가가 지정가에 닿은 줄 수: 매수는 종가 ≤ 지정가, 매도는 종가 ≥ 지정가 */
export function countFills(orders: VrOrders, price: number) {
  return { buys: orders.buys.filter((r) => price <= r.price).length, sells: orders.sells.filter((r) => price >= r.price).length };
}
