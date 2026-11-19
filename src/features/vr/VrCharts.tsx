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

interface ValuePoint { t: number; date: string; close: number; shares: number; value: number; cycle: VrCycle }

/** 사이클별 V 밴드와 평가금(사이클 시작 수량 × 일별 종가) */
export function VrBandChart({ cycles, prices }: { cycles: VrCycle[]; prices: ReferenceClose[] }) {
  const shown = cycles.slice(-26);
  const [plotRef, W] = useWidth();
  const [hover, setHover] = useState<Hover | null>(null);
  const model = useMemo(() => {
    const t0 = time(shown[0].startDate);
    const t1 = time(shown[shown.length - 1].endDate) + DAY;
    const points: ValuePoint[] = [];
    for (const c of shown) {
      for (const p of prices) {
        if (p.date >= c.startDate && p.date <= c.endDate) { const shares = fillTotals(c, p.date).shares; points.push({ t: time(p.date), date: p.date, close: p.close, shares, value: shares * p.close, cycle: c }); }
      }
    }
    const closes = shown.filter((c) => c.close).map((c) => ({ t: time(c.endDate), value: c.close!.shares * c.close!.price, cycle: c }));
    const [y0, y1] = domain([...shown.flatMap((c) => [c.lower, c.upper]), ...points.map((p) => p.value), ...closes.map((p) => p.value)]);
    return { t0, t1, points, closes, x: linear(t0, t1, M.l, W - M.r), y: linear(y0, y1, H - M.b, M.t), y0, y1 };
  }, [shown, prices, W]);
  const { x, y, points, closes } = model;
  const vPath = shown.map((c, i) => `${i ? "L" : "M"}${x(time(c.startDate))},${y(c.v)} H${x(time(c.endDate) + DAY)}`).join(" ");
  const edge = (key: "lower" | "upper") => shown.map((c, i) => `${i ? "L" : "M"}${x(time(c.startDate))},${y(c[key])} H${x(time(c.endDate) + DAY)}`).join(" ");
  const last = shown[shown.length - 1];
  const lastPoint = points.filter((p) => p.cycle === last).at(-1);
  const labels = placeLabels([
    { key: "upper", y: y(last.upper), text: `V 최대 ${usd(last.upper, 0)}` },
    { key: "v", y: y(last.v), text: `V ${usd(last.v, 0)}` },
    { key: "lower", y: y(last.lower), text: `V 최소 ${usd(last.lower, 0)}` },
    ...(lastPoint ? [{ key: "value", y: y(lastPoint.value), text: `평가금 ${usd(lastPoint.value, 0)}` }] : []),
  ]);

  function move(svgX: number) {
    if (points.length === 0) return;
    const nearest = points.reduce((best, p) => Math.abs(x(p.t) - svgX) < Math.abs(x(best.t) - svgX) ? p : best);
    const c = nearest.cycle;
    const zone = nearest.value < c.lower ? "V 최소 아래 · 매수 구간" : nearest.value > c.upper ? "V 최대 위 · 매도 구간" : "밴드 안";
    setHover({ x: x(nearest.t), content: <>
      <strong>{nearest.date} · {c.week}주차</strong>
      <span>종가 {usd(nearest.close)} × {nearest.shares}주</span>
      <span><Swatch kind="value" />평가금 {usd(nearest.value)}</span>
      <span><Swatch kind="v" />V {usd(c.v)}</span>
      <span><Swatch kind="band" />최소~최대 {usd(c.lower)} ~ {usd(c.upper)}</span>
      <em>{zone}</em>
    </> });
  }

  const long = model.t1 - model.t0 > 200 * DAY;
  return <ChartFrame plotRef={plotRef} W={W}
    label={`V 밴드와 평가금 추이, ${shown[0].week}주차부터 ${last.week}주차까지`}
    legend={<><span><Swatch kind="v" />V (목표 평가금)</span><span><Swatch kind="band" />V 최소~최대 밴드</span><span><Swatch kind="value" />평가금 = 보유 수량 × 종가</span>{closes.length > 0 && <span><Swatch kind="dot" />사이클 마감 평가금</span>}</>}
    hover={hover} onMove={move} onLeave={() => setHover(null)}>
    <Axes W={W} yTicks={niceTicks(model.y0, model.y1)} y={y} xTicks={dateTicks(model.t0, model.t1, W < 560 ? 3 : long ? 6 : 4)} x={x} long={long} />
    {shown.map((c) => <rect key={c.index} className="vr-chart-band" x={x(time(c.startDate))} width={Math.max(1, x(time(c.endDate) + DAY) - x(time(c.startDate)) - 2)} y={y(c.upper)} height={Math.max(1, y(c.lower) - y(c.upper))} />)}
    <path className="vr-chart-edge" d={edge("upper")} />
    <path className="vr-chart-edge" d={edge("lower")} />
    <path className="vr-chart-v" d={vPath} />
    {shown.map((c) => {
      const ps = points.filter((p) => p.cycle === c);
      return ps.length > 0 && <path key={c.index} className="vr-chart-value" d={ps.map((p, i) => `${i ? "L" : "M"}${x(p.t)},${y(p.value)}`).join(" ")} />;
    })}
    {points.length === 1 && <circle className="vr-chart-dot" cx={x(points[0].t)} cy={y(points[0].value)} r={4} />}
    {closes.map((p) => <circle key={p.cycle.index} className="vr-chart-dot" cx={x(p.t)} cy={y(p.value)} r={4} />)}
    {labels.map((l) => <text key={l.key} className="vr-chart-label" x={W - M.r + 8} y={l.ly} dy="0.32em">{l.text}</text>)}
  </ChartFrame>;
}

/** 최근 종가와 이번 사이클 매수·매도 지정가 */
export function VrPriceChart({ cycle, orders, prices }: { cycle: VrCycle; orders: VrOrders; prices: ReferenceClose[] }) {
  const [plotRef, W] = useWidth();
  const [hover, setHover] = useState<Hover | null>(null);
  const from = time(cycle.startDate) - 90 * DAY;
  const data = prices.filter((p) => time(p.date) >= from);
  if (data.length === 0) return <p className="vr-hint">표시할 종가 데이터가 없습니다.</p>;
  const t0 = time(data[0].date);
  const t1 = Math.max(time(data[data.length - 1].date), time(cycle.startDate), ...(cycle.fills ?? []).map((fl) => time(fl.date))) + DAY;
  const x = linear(t0, t1, M.l, W - M.r);
  const firstSell = orders.sells[0]?.price;
  const [y0, y1] = domain([...data.map((p) => p.close), ...orders.buys.map((r) => r.price), ...(firstSell ? [firstSell] : []), ...(cycle.fills ?? []).map((fl) => fl.price)]);
  const y = linear(y0, y1, H - M.b, M.t);
  const sells = orders.sells.filter((r) => r.price <= y1);
  const last = data[data.length - 1];
  const buyFirst = orders.buys[0];
  const buyLast = orders.buys[orders.buys.length - 1];
  const labels = placeLabels([
    ...(buyFirst ? [{ key: "b1", y: y(buyFirst.price), text: `매수 1번 ${usd(buyFirst.price)}` }] : []),
    ...(buyLast && buyLast !== buyFirst ? [{ key: "bn", y: y(buyLast.price), text: `매수 ${orders.buys.length}번 ${usd(buyLast.price)}` }] : []),
    ...(sells[0] ? [{ key: "s1", y: y(sells[0].price), text: `매도 1번 ${usd(sells[0].price)}` }] : []),
    { key: "now", y: y(last.close), text: `종가 ${usd(last.close)}` },
  ]);
  const startX = x(time(cycle.startDate));

  function move(svgX: number) {
    const nearest = data.reduce((best, p) => Math.abs(x(time(p.date)) - svgX) < Math.abs(x(time(best.date)) - svgX) ? p : best);
    const fills = countFills(orders, nearest.close);
    setHover({ x: x(time(nearest.date)), content: <>
      <strong>{nearest.date}</strong>
      <span><Swatch kind="price" />종가 {usd(nearest.close)}</span>
      <em>{fills.buys > 0 ? `이 가격이면 매수 ${fills.buys}줄 체결` : fills.sells > 0 ? `이 가격이면 매도 ${fills.sells}줄 체결` : "이 가격이면 체결 없음"}</em>
    </> });
  }

  return <ChartFrame plotRef={plotRef} W={W}
    label={`${cycle.week}주차 주문 지정가와 최근 종가`}
    legend={<><span><Swatch kind="price" />종가</span><span><Swatch kind="buy" />매수 지정가 {orders.buys.length}줄</span><span><Swatch kind="sell" />매도 지정가 (화면 범위 {sells.length}줄)</span>{(cycle.fills ?? []).length > 0 && <span><Swatch kind="fill" />기록한 체결</span>}</>}
    hover={hover} onMove={move} onLeave={() => setHover(null)}>
    <Axes W={W} yTicks={niceTicks(y0, y1)} y={y} xTicks={dateTicks(t0, t1, W < 560 ? 3 : 4)} x={x} long={false} />
    <rect className="vr-chart-cycle" x={startX} width={Math.max(0, W - M.r - startX)} y={M.t} height={H - M.t - M.b} />
    <line className="vr-chart-cross" x1={startX} x2={startX} y1={M.t} y2={H - M.b} />
    <text className="vr-chart-note" x={startX - 6} y={H - M.b - 8} textAnchor="end">{cycle.week}주차 시작 →</text>
    {orders.buys.map((r) => <line key={`b${r.holdings}`} className="vr-chart-buy" x1={M.l} x2={W - M.r} y1={y(r.price)} y2={y(r.price)} />)}
    {sells.map((r) => <line key={`s${r.holdings}`} className="vr-chart-sell" x1={M.l} x2={W - M.r} y1={y(r.price)} y2={y(r.price)} />)}
    <path className="vr-chart-price" d={data.map((p, i) => `${i ? "L" : "M"}${x(time(p.date))},${y(p.close)}`).join(" ")} />
    <circle className="vr-chart-dot vr-chart-dot--price" cx={x(time(last.date))} cy={y(last.close)} r={4} />
    {(cycle.fills ?? []).filter((fl) => time(fl.date) >= t0).map((fl) => <circle key={fl.id} className={`vr-chart-fill vr-chart-fill--${fl.side}`} cx={x(time(fl.date))} cy={y(fl.price)} r={5}><title>{`${fl.date} ${fl.side === "buy" ? "매수" : "매도"} ${fl.quantity}주 × ${usd(fl.price)}`}</title></circle>)}
    {labels.map((l) => <text key={l.key} className="vr-chart-label" x={W - M.r + 8} y={l.ly} dy="0.32em">{l.text}</text>)}
  </ChartFrame>;
}

/** 종가가 지정가에 닿은 줄 수: 매수는 종가 ≤ 지정가, 매도는 종가 ≥ 지정가 */
export function countFills(orders: VrOrders, price: number) {
  return { buys: orders.buys.filter((r) => price <= r.price).length, sells: orders.sells.filter((r) => price >= r.price).length };
}
