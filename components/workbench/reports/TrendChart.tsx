'use client'

// The trend line: clicks a day, free listings against paid ads.
//
// Inline SVG, and no charting library. This repo has never carried one, a
// dependency is the owner's decision rather than a convenience, and a two
// series line over a hundred points is about forty lines of geometry. Nothing
// here needs a canvas, a tooltip engine or a layout pass.
//
// Three things it is careful about:
//
//   - A DAY WITH NOTHING IMPORTED IS A GAP, NOT A ZERO. Google's figures run a
//     day behind and a backfill arrives oldest first, so "no row" is a normal
//     state and drawing it on the floor would show a crash that never happened.
//     The line breaks, and the caption says how many days are missing.
//   - Colour is never the only difference. Free is a solid line in the primary
//     colour, paid is a dashed line in the information colour, and both are
//     named in the legend - so it reads on a monochrome screen and to anyone
//     who does not separate green from blue.
//   - The numbers exist for a screen reader too. The same figures are in a
//     visually hidden table underneath, because a path element says nothing
//     out loud.
import { useId } from 'react'
import { formatCount } from '@/modules/google-shopping-for-shop/components/workbench/format'
import type { TrendDay } from '@/modules/google-shopping-for-shop/lib/performance/report'

/** The drawing is done in these units and scaled by CSS, so one component
 *  works at any width without measuring anything. */
const WIDTH = 720
const HEIGHT = 200
const PAD = { top: 12, right: 12, bottom: 26, left: 44 }

const PLOT_W = WIDTH - PAD.left - PAD.right
const PLOT_H = HEIGHT - PAD.top - PAD.bottom

export type TrendMetric = 'clicks' | 'impressions'

type Props = {
  days: readonly TrendDay[]
  metric: TrendMetric
}

function valueOf(day: TrendDay, metric: TrendMetric, series: 'organic' | 'ads'): number {
  if (series === 'organic') return metric === 'clicks' ? day.organicClicks : day.organicImpressions
  return metric === 'clicks' ? day.adsClicks : day.adsImpressions
}

/** A sensible top to the axis: the largest value rounded up to something with
 *  one significant figure, so the gridline labels are readable numbers rather
 *  than 8,143. Never zero - an axis from 0 to 0 has no scale at all. */
export function axisTop(max: number): number {
  if (max <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(max))
  return Math.ceil(max / magnitude) * magnitude
}

/**
 * The line for one series, as SVG path data.
 *
 * A day that was never imported starts a new sub-path (M rather than L), which
 * is what puts a real gap in the line instead of a straight run across the
 * missing week.
 */
export function pathFor(
  days: readonly TrendDay[],
  metric: TrendMetric,
  series: 'organic' | 'ads',
  top: number,
): string {
  const step = days.length > 1 ? PLOT_W / (days.length - 1) : 0
  const parts: string[] = []
  let penDown = false
  days.forEach((day, index) => {
    if (!day.imported) {
      penDown = false
      return
    }
    const x = PAD.left + index * step
    const y = PAD.top + PLOT_H - (valueOf(day, metric, series) / top) * PLOT_H
    parts.push(`${penDown ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`)
    penDown = true
  })
  return parts.join(' ')
}

/** A single imported day between two gaps draws no line at all - a path with
 *  one point has no length - so it gets a dot of its own. */
function lonePoints(days: readonly TrendDay[], metric: TrendMetric, series: 'organic' | 'ads', top: number) {
  const step = days.length > 1 ? PLOT_W / (days.length - 1) : 0
  return days.flatMap((day, index) => {
    if (!day.imported) return []
    const before = days[index - 1]
    const after = days[index + 1]
    if (before?.imported || after?.imported) return []
    return [{
      key: day.day,
      cx: PAD.left + index * step,
      cy: PAD.top + PLOT_H - (valueOf(day, metric, series) / top) * PLOT_H,
    }]
  })
}

function shortDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

export function TrendChart({ days, metric }: Props) {
  const titleId = useId()
  const label = metric === 'clicks' ? 'clicks' : 'times shown'

  const max = days.reduce(
    (highest, day) => Math.max(highest, valueOf(day, metric, 'organic'), valueOf(day, metric, 'ads')),
    0,
  )
  const top = axisTop(max)
  const missing = days.filter((day) => !day.imported).length

  // Four gridlines plus the floor. Enough to read a value off, few enough not
  // to become a grid.
  const gridlines = [0, 0.25, 0.5, 0.75, 1]
  const step = days.length > 1 ? PLOT_W / (days.length - 1) : 0

  // At most six date labels, evenly spread, whatever the range - ninety of
  // them would be an unreadable smear.
  const labelEvery = Math.max(1, Math.ceil(days.length / 6))

  return (
    <div className="gsr-chart">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="gsr-chart-svg"
        role="img"
        aria-labelledby={titleId}
        preserveAspectRatio="xMidYMid meet"
      >
        <title id={titleId}>
          {`Daily ${label} from Google, free listings against paid ads, ${days.length > 0 ? `${shortDay(days[0]?.day ?? '')} to ${shortDay(days[days.length - 1]?.day ?? '')}` : 'no days'}`}
        </title>

        {gridlines.map((fraction) => {
          const y = PAD.top + PLOT_H - fraction * PLOT_H
          return (
            <g key={fraction}>
              <line x1={PAD.left} y1={y} x2={WIDTH - PAD.right} y2={y} className="gsr-grid" />
              <text x={PAD.left - 6} y={y + 4} className="gsr-axis" textAnchor="end">
                {formatCount(Math.round(top * fraction))}
              </text>
            </g>
          )
        })}

        {days.map((day, index) => (
          index % labelEvery === 0 ? (
            <text
              key={day.day}
              x={PAD.left + index * step}
              y={HEIGHT - 8}
              className="gsr-axis"
              textAnchor={index === 0 ? 'start' : 'middle'}
            >
              {shortDay(day.day)}
            </text>
          ) : null
        ))}

        <path d={pathFor(days, metric, 'organic', top)} className="gsr-line is-organic" />
        <path d={pathFor(days, metric, 'ads', top)} className="gsr-line is-ads" />

        {lonePoints(days, metric, 'organic', top).map((point) => (
          <circle key={`o-${point.key}`} cx={point.cx} cy={point.cy} r={2.5} className="gsr-dot is-organic" />
        ))}
        {lonePoints(days, metric, 'ads', top).map((point) => (
          <circle key={`a-${point.key}`} cx={point.cx} cy={point.cy} r={2.5} className="gsr-dot is-ads" />
        ))}
      </svg>

      <div className="gsr-legend">
        <span className="gsr-key is-organic">Free listings</span>
        <span className="gsr-key is-ads">Paid ads</span>
        {missing > 0 && (
          <span className="gsw-small gsw-muted">
            {missing === days.length
              ? 'Nothing has been brought in for any of these days yet, so the chart is empty rather than flat.'
              : `${formatCount(missing)} of these days have nothing brought in yet, so the line breaks rather than dropping to nought.`}
          </span>
        )}
      </div>

      {/* The same figures, for anything that cannot read a line. */}
      <table className="gsw-sr">
        <caption>{`Daily ${label} from Google`}</caption>
        <thead>
          <tr><th scope="col">Day</th><th scope="col">Free listings</th><th scope="col">Paid ads</th></tr>
        </thead>
        <tbody>
          {days.map((day) => (
            <tr key={day.day}>
              <th scope="row">{day.day}</th>
              <td>{day.imported ? formatCount(valueOf(day, metric, 'organic')) : 'not brought in yet'}</td>
              <td>{day.imported ? formatCount(valueOf(day, metric, 'ads')) : 'not brought in yet'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
