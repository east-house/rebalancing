import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import './AssetChart.css'

export type AssetChartPeriod = '1M' | '3M' | '6M' | '1Y'

export interface AssetChartDataPoint {
  date: string
  totalValue: number
}

export interface AssetChartProps {
  data: AssetChartDataPoint[]
  currency?: string
  locale?: string
  title?: string
  initialPeriod?: AssetChartPeriod
  className?: string
}

interface NormalizedDataPoint extends AssetChartDataPoint {
  timestamp: number
}

interface ChartPoint extends NormalizedDataPoint {
  x: number
  y: number
}

const PERIODS: ReadonlyArray<{
  value: AssetChartPeriod
  label: string
  months: number
}> = [
  { value: '1M', label: '1개월', months: 1 },
  { value: '3M', label: '3개월', months: 3 },
  { value: '6M', label: '6개월', months: 6 },
  { value: '1Y', label: '1년', months: 12 },
]

const DESKTOP_SIZE = {
  width: 800,
  height: 320,
  left: 76,
  right: 20,
  top: 20,
  bottom: 42,
}

const COMPACT_SIZE = {
  width: 360,
  height: 258,
  left: 58,
  right: 12,
  top: 18,
  bottom: 38,
}

function subtractUtcMonths(timestamp: number, months: number) {
  const source = new Date(timestamp)
  const targetMonth = source.getUTCMonth() - months
  const target = new Date(
    Date.UTC(
      source.getUTCFullYear(),
      targetMonth,
      1,
      source.getUTCHours(),
      source.getUTCMinutes(),
      source.getUTCSeconds(),
      source.getUTCMilliseconds(),
    ),
  )

  const lastDayOfTargetMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate()

  target.setUTCDate(Math.min(source.getUTCDate(), lastDayOfTargetMonth))
  return target.getTime()
}

function parseDate(date: string) {
  const timestamp = Date.parse(
    /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00Z` : date,
  )
  return Number.isFinite(timestamp) ? timestamp : null
}

function getChangeLabel(changeRate: number) {
  if (!Number.isFinite(changeRate) || changeRate === 0) return '변동 없음'
  return `${changeRate > 0 ? '+' : ''}${changeRate.toFixed(1)}%`
}

export function AssetChart({
  data,
  currency = 'KRW',
  locale,
  title = '총자산 추이',
  initialPeriod = '6M',
  className = '',
}: AssetChartProps) {
  const [period, setPeriod] = useState<AssetChartPeriod>(initialPeriod)
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const [isCompact, setIsCompact] = useState(false)
  const chartContainerRef = useRef<HTMLDivElement>(null)
  const rawId = useId()
  const id = rawId.replace(/:/g, '')
  const descriptionId = `asset-chart-description-${id}`
  const gradientId = `asset-chart-gradient-${id}`

  const effectiveLocale = locale ?? (currency.toUpperCase() === 'KRW' ? 'ko-KR' : undefined)

  const currencyFormatter = useMemo(() => {
    try {
      return new Intl.NumberFormat(effectiveLocale, {
        style: 'currency',
        currency: currency.toUpperCase(),
        maximumFractionDigits: 0,
      })
    } catch {
      return new Intl.NumberFormat('ko-KR', {
        style: 'currency',
        currency: 'KRW',
        maximumFractionDigits: 0,
      })
    }
  }, [currency, effectiveLocale])

  const compactCurrencyFormatter = useMemo(() => {
    try {
      return new Intl.NumberFormat(effectiveLocale, {
        style: 'currency',
        currency: currency.toUpperCase(),
        notation: 'compact',
        maximumFractionDigits: 1,
      })
    } catch {
      return new Intl.NumberFormat('ko-KR', {
        style: 'currency',
        currency: 'KRW',
        notation: 'compact',
        maximumFractionDigits: 1,
      })
    }
  }, [currency, effectiveLocale])

  const shortDateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(effectiveLocale, {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      }),
    [effectiveLocale],
  )

  const longDateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(effectiveLocale, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      }),
    [effectiveLocale],
  )

  const normalizedData = useMemo(() => {
    const pointsByTimestamp = new Map<number, NormalizedDataPoint>()

    data.forEach((point) => {
      if (
        typeof point?.date !== 'string' ||
        !Number.isFinite(point.totalValue) ||
        point.totalValue < 0
      ) {
        return
      }

      const timestamp = parseDate(point.date)
      if (timestamp === null) return

      pointsByTimestamp.set(timestamp, {
        date: point.date,
        totalValue: point.totalValue,
        timestamp,
      })
    })

    return Array.from(pointsByTimestamp.values()).sort(
      (first, second) => first.timestamp - second.timestamp,
    )
  }, [data])

  const filteredData = useMemo(() => {
    if (normalizedData.length === 0) return []

    const latestTimestamp = normalizedData[normalizedData.length - 1].timestamp
    const months = PERIODS.find((option) => option.value === period)?.months ?? 6
    const cutoff = subtractUtcMonths(latestTimestamp, months)
    return normalizedData.filter((point) => point.timestamp >= cutoff)
  }, [normalizedData, period])

  useEffect(() => {
    const container = chartContainerRef.current
    if (!container) return

    const updateLayout = () => setIsCompact(container.clientWidth < 560)
    updateLayout()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateLayout)
      return () => window.removeEventListener('resize', updateLayout)
    }

    const observer = new ResizeObserver(updateLayout)
    observer.observe(container)
    return () => observer.disconnect()
  }, [filteredData.length])

  useEffect(() => {
    setActiveIndex((current) => {
      if (current === null) return null
      return filteredData.length === 0
        ? null
        : Math.min(current, filteredData.length - 1)
    })
  }, [filteredData.length])

  const size = isCompact ? COMPACT_SIZE : DESKTOP_SIZE
  const plotLeft = size.left
  const plotRight = size.width - size.right
  const plotTop = size.top
  const plotBottom = size.height - size.bottom
  const plotWidth = plotRight - plotLeft
  const plotHeight = plotBottom - plotTop

  const values = filteredData.map((point) => point.totalValue)
  const rawMin = values.length > 0 ? Math.min(...values) : 0
  const rawMax = values.length > 0 ? Math.max(...values) : 0
  const rawRange = rawMax - rawMin
  const padding = rawRange > 0 ? rawRange * 0.12 : Math.max(rawMax * 0.08, 1)
  const scaleMin = Math.max(0, rawMin - padding)
  const scaleMax = rawMax + padding
  const scaleRange = Math.max(scaleMax - scaleMin, 1)
  const firstTimestamp = filteredData[0]?.timestamp ?? 0
  const lastTimestamp = filteredData[filteredData.length - 1]?.timestamp ?? 0
  const timeRange = Math.max(lastTimestamp - firstTimestamp, 1)

  const chartPoints: ChartPoint[] = filteredData.map((point) => ({
    ...point,
    x:
      filteredData.length === 1
        ? plotLeft + plotWidth / 2
        : plotLeft + ((point.timestamp - firstTimestamp) / timeRange) * plotWidth,
    y: plotTop + ((scaleMax - point.totalValue) / scaleRange) * plotHeight,
  }))

  const linePath = chartPoints
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
    .join(' ')

  const areaPath =
    chartPoints.length > 0
      ? `${linePath} L ${chartPoints[chartPoints.length - 1].x} ${plotBottom} L ${
          chartPoints[0].x
        } ${plotBottom} Z`
      : ''

  const yTicks = Array.from({ length: 4 }, (_, index) => {
    const ratio = index / 3
    return {
      y: plotTop + ratio * plotHeight,
      value: scaleMax - ratio * scaleRange,
    }
  })

  const xTickIndexes =
    chartPoints.length <= 1
      ? [0]
      : Array.from(
          new Set([
            0,
            Math.floor((chartPoints.length - 1) / 2),
            chartPoints.length - 1,
          ]),
        )

  const firstPoint = filteredData[0]
  const latestPoint = filteredData[filteredData.length - 1]
  const absoluteChange =
    firstPoint && latestPoint ? latestPoint.totalValue - firstPoint.totalValue : 0
  const changeRate =
    firstPoint && firstPoint.totalValue > 0
      ? (absoluteChange / firstPoint.totalValue) * 100
      : 0
  const changeTone =
    absoluteChange > 0 ? 'positive' : absoluteChange < 0 ? 'negative' : 'neutral'
  const activePoint = activeIndex === null ? null : chartPoints[activeIndex]

  const showPointAtClientX = (clientX: number, target: SVGSVGElement) => {
    if (chartPoints.length === 0) return

    const bounds = target.getBoundingClientRect()
    const svgX = ((clientX - bounds.left) / Math.max(bounds.width, 1)) * size.width
    let nearestIndex = 0
    let nearestDistance = Number.POSITIVE_INFINITY

    chartPoints.forEach((point, index) => {
      const distance = Math.abs(point.x - svgX)
      if (distance < nearestDistance) {
        nearestIndex = index
        nearestDistance = distance
      }
    })

    setActiveIndex(nearestIndex)
  }

  const handlePointer = (event: ReactPointerEvent<SVGSVGElement>) => {
    showPointAtClientX(event.clientX, event.currentTarget)
  }

  const handleChartKeyDown = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    if (chartPoints.length === 0) return

    if (event.key === 'Escape') {
      setActiveIndex(null)
      return
    }

    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return

    event.preventDefault()
    setActiveIndex((current) => {
      if (event.key === 'Home') return 0
      if (event.key === 'End') return chartPoints.length - 1
      const startingIndex = current ?? chartPoints.length - 1
      return event.key === 'ArrowLeft'
        ? Math.max(0, startingIndex - 1)
        : Math.min(chartPoints.length - 1, startingIndex + 1)
    })
  }

  const tooltipWidth = isCompact ? 152 : 176
  const tooltipHeight = 54
  const tooltipX = activePoint
    ? Math.min(
        Math.max(activePoint.x - tooltipWidth / 2, plotLeft),
        plotRight - tooltipWidth,
      )
    : 0
  const tooltipY = activePoint
    ? activePoint.y - tooltipHeight - 14 >= plotTop
      ? activePoint.y - tooltipHeight - 14
      : Math.min(activePoint.y + 14, plotBottom - tooltipHeight)
    : 0

  return (
    <section
      className={`asset-chart ${className}`.trim()}
      aria-labelledby={`asset-chart-title-${id}`}
    >
      <div className="asset-chart__header">
        <div>
          <p className="asset-chart__eyebrow">PORTFOLIO VALUE</p>
          <h2 className="asset-chart__title" id={`asset-chart-title-${id}`}>
            {title}
          </h2>
          {latestPoint && (
            <div className="asset-chart__headline">
              <strong>{currencyFormatter.format(latestPoint.totalValue)}</strong>
              <span className={`asset-chart__change asset-chart__change--${changeTone}`}>
                {getChangeLabel(changeRate)}
              </span>
            </div>
          )}
        </div>

        <div className="asset-chart__periods" role="group" aria-label="조회 기간">
          {PERIODS.map((option) => (
            <button
              key={option.value}
              type="button"
              className="asset-chart__period"
              aria-pressed={period === option.value}
              onClick={() => {
                setPeriod(option.value)
                setActiveIndex(null)
              }}
            >
              <span aria-hidden="true">{option.value}</span>
              <span className="asset-chart__sr-only">{option.label}</span>
            </button>
          ))}
        </div>
      </div>

      {chartPoints.length === 0 ? (
        <div className="asset-chart__empty" role="status">
          <span className="asset-chart__empty-icon" aria-hidden="true">
            ↗
          </span>
          <strong>아직 자산 기록이 없습니다</strong>
          <p>자산 데이터가 쌓이면 이곳에서 총금액의 변화를 확인할 수 있어요.</p>
        </div>
      ) : (
        <>
          <p className="asset-chart__sr-only" id={descriptionId}>
            {longDateFormatter.format(firstPoint.timestamp)}부터{' '}
            {longDateFormatter.format(latestPoint.timestamp)}까지 총 {chartPoints.length}개
            기록입니다. 현재 총자산은 {currencyFormatter.format(latestPoint.totalValue)}
            이며, 기간 동안 {currencyFormatter.format(Math.abs(absoluteChange))}
            {absoluteChange > 0 ? ' 증가' : absoluteChange < 0 ? ' 감소' : ' 변동 없음'}
            했습니다. 차트에 초점을 둔 뒤 좌우 방향키로 각 기록을 확인할 수 있습니다.
          </p>

          <div className="asset-chart__canvas" ref={chartContainerRef}>
            <svg
              className="asset-chart__svg"
              viewBox={`0 0 ${size.width} ${size.height}`}
              role="img"
              aria-labelledby={`asset-chart-title-${id}`}
              aria-describedby={descriptionId}
              tabIndex={0}
              onFocus={() => setActiveIndex((current) => current ?? chartPoints.length - 1)}
              onBlur={() => setActiveIndex(null)}
              onKeyDown={handleChartKeyDown}
              onPointerDown={handlePointer}
              onPointerMove={handlePointer}
              onPointerLeave={(event) => {
                if (event.pointerType === 'mouse') setActiveIndex(null)
              }}
              onPointerCancel={() => setActiveIndex(null)}
            >
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--asset-chart-accent)" stopOpacity="0.3" />
                  <stop offset="72%" stopColor="var(--asset-chart-accent)" stopOpacity="0.06" />
                  <stop offset="100%" stopColor="var(--asset-chart-accent)" stopOpacity="0" />
                </linearGradient>
              </defs>

              {yTicks.map((tick, index) => (
                <g key={`${tick.value}-${index}`} className="asset-chart__grid">
                  <line
                    x1={plotLeft}
                    x2={plotRight}
                    y1={tick.y}
                    y2={tick.y}
                    vectorEffect="non-scaling-stroke"
                  />
                  <text x={plotLeft - 10} y={tick.y + 4} textAnchor="end">
                    {compactCurrencyFormatter.format(Math.max(0, tick.value))}
                  </text>
                </g>
              ))}

              {xTickIndexes.map((index, tickIndex) => {
                const point = chartPoints[index]
                const anchor =
                  xTickIndexes.length === 1
                    ? 'middle'
                    : tickIndex === 0
                    ? 'start'
                    : tickIndex === xTickIndexes.length - 1
                      ? 'end'
                      : 'middle'

                return (
                  <text
                    key={`${point.timestamp}-${tickIndex}`}
                    className="asset-chart__axis-date"
                    x={point.x}
                    y={size.height - 12}
                    textAnchor={anchor}
                  >
                    {shortDateFormatter.format(point.timestamp)}
                  </text>
                )
              })}

              <path className="asset-chart__area" d={areaPath} fill={`url(#${gradientId})`} />
              <path
                className="asset-chart__line"
                d={linePath}
                vectorEffect="non-scaling-stroke"
              />

              {chartPoints.length === 1 && (
                <circle
                  className="asset-chart__single-point"
                  cx={chartPoints[0].x}
                  cy={chartPoints[0].y}
                  r="4"
                  vectorEffect="non-scaling-stroke"
                />
              )}

              {activePoint && (
                <g className="asset-chart__tooltip" aria-hidden="true">
                  <line
                    className="asset-chart__guide"
                    x1={activePoint.x}
                    x2={activePoint.x}
                    y1={plotTop}
                    y2={plotBottom}
                    vectorEffect="non-scaling-stroke"
                  />
                  <circle
                    className="asset-chart__point-halo"
                    cx={activePoint.x}
                    cy={activePoint.y}
                    r="7"
                  />
                  <circle
                    className="asset-chart__point"
                    cx={activePoint.x}
                    cy={activePoint.y}
                    r="3.5"
                    vectorEffect="non-scaling-stroke"
                  />
                  <g transform={`translate(${tooltipX} ${tooltipY})`}>
                    <rect width={tooltipWidth} height={tooltipHeight} rx="10" />
                    <text className="asset-chart__tooltip-date" x="12" y="19">
                      {longDateFormatter.format(activePoint.timestamp)}
                    </text>
                    <text className="asset-chart__tooltip-value" x="12" y="41">
                      {currencyFormatter.format(activePoint.totalValue)}
                    </text>
                  </g>
                </g>
              )}
            </svg>
          </div>

          <div className="asset-chart__sr-only">
            <table>
              <caption>{title} 상세 데이터</caption>
              <thead>
                <tr>
                  <th>날짜</th>
                  <th>총자산</th>
                </tr>
              </thead>
              <tbody>
                {filteredData.map((point) => (
                  <tr key={point.timestamp}>
                    <td>{longDateFormatter.format(point.timestamp)}</td>
                    <td>{currencyFormatter.format(point.totalValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}

export default AssetChart
