// The ridge math shared by the standings chart and the movie pages.
// A ridge's height each night is how high the movie ranked (#1 tallest, off the list
// flat; squared so the top spots stand out, with a floor so every ranked night
// shows), smoothed over about two weeks so nightly wobbles don't show.
import { area, bisector, curveBasis, line, randomLcg, range, sum } from "d3"
import { LIST_SIZE as MAX_RANK } from "@/consts"
import type { Catalog, RankDay } from "@/lib/types"

const SMOOTH_DAYS = 15
// A missed night takes the night before; a longer gap shows as no data
const MAX_GAP_DAYS = 3
// The height of the lowest rank, as a share of #1's
const FLOOR = 0.08
export const DAY = 86400000
// Days after the last night where a ridge eases down to flat, so a movie still
// ranked doesn't run off the chart's edge at full height
export const RUNOUT_DAYS = 14

const height = (rank: number | undefined) =>
  rank ? FLOOR + (1 - FLOOR) * ((MAX_RANK + 1 - rank) / MAX_RANK) ** 2 : 0

// Each line wobbles a little, like it was inked by hand. The wobble is fixed per
// movie and follows its place across the chart, not the pixel, so it stretches
// with the page instead of shifting when the width changes.
const WOBBLE_PX = 0.9
function wobble(id: string) {
  const rand = randomLcg(sum(id, (c) => c.charCodeAt(0)) / 997)
  const [a, b] = [rand() * 2 * Math.PI, rand() * 2 * Math.PI]
  return (u: number) =>
    WOBBLE_PX * (0.6 * Math.sin(u * 50 + a) + 0.4 * Math.sin(u * 130 + b))
}

/** A point of a drawn ridge: [x, y, baseline y], in pixels from its row's baseline. */
export type RidgePoint = [x: number, y: number, base: number]

/**
 * A ridge as drawn, edge to edge: flat from 0 in to its first point, then its
 * shape ([x, height] in pixels, up from the baseline), then flat out to `to`.
 * The wobble is baked into the line and its baseline, so a fill has a
 * hand-inked bottom edge too. Shared by the standings chart and the movie pages.
 */
export function handInked(
  id: string,
  shape: [number, number][],
  to: number
): RidgePoint[] {
  const shake = wobble(id)
  const first = shape[0]?.[0] ?? to
  const last = shape.at(-1)?.[0] ?? to
  return [
    ...range(0, first, 20).map((px): [number, number] => [px, 0]),
    ...shape,
    ...(last < to ? [...range(last + 20, to, 20), to] : []).map(
      (px): [number, number] => [px, 0]
    ),
  ].map(([px, h]) => {
    const dy = shake(px / to)
    return [px, dy - h, dy]
  })
}
export const ridgeLine = line<RidgePoint>()
  .y((p) => p[1])
  .curve(curveBasis)
export const ridgeArea = area<RidgePoint>()
  .y0((p) => p[2])
  .y1((p) => p[1])
  .curve(curveBasis)

/** What a chart draws: some nights' standings and the movies in them. */
export interface ChartData {
  /** The year shown: a calendar year, a release year, or for the last 365 days
   * the latest night's. */
  year: number
  days: RankDay[]
  movies: Catalog
  /** A year's list (best-pictures-YYYY.json ids, best first), if given: only
   * these movies, ranked in this order. */
  list?: number[]
}

export interface Ridge {
  id: string
  title: string
  release_date: string | null
  /** The first night it was ranked (YYYY-MM-DD). */
  joined: string
  row: number
  best: number
  nights: number
  /** Rank on the latest night, or null if it wasn't ranked then. */
  last: number | null
  /** Its place in the chart's list if it has one, otherwise by points every
   * night it was ranked (#1 scores MAX_RANK, the last spot 1), totalled,
   * roughly the area under its ridge. */
  rank: number
  points: [number, number][]
}

export const utc = (date: string) => Date.parse(date + "T00:00:00Z")
export const formatDate = (date: string) =>
  new Date(utc(date)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  })

const nightTime = bisector((night: RankDay) => utc(night.date))

/** The night whose standings cover time t (a missed night takes the night before), or null. */
function nightOn(nights: RankDay[], t: number): string | null {
  const night = nights[nightTime.right(nights, t) - 1]
  return night && t - utc(night.date) <= MAX_GAP_DAYS * DAY ? night.date : null
}

// One movie's ridge: [time, height 0-1] for every day of the year, smoothed.
// Days with no standings are flat, and so are any run-out days after the end.
export function ridgeline(
  byDate: Record<string, number>,
  nights: RankDay[],
  start: number,
  end: number,
  runout = 0
): [number, number][] {
  const heights: number[] = []
  for (let t = start; t < end + runout * DAY; t += DAY) {
    const night = t < end && nightOn(nights, t)
    heights.push(night ? height(byDate[night]) : 0)
  }

  // A triangle-weighted average, so a jump rises with rounded shoulders. The
  // window narrows toward either end, so without a run-out the latest night
  // shows as it is; with one, the ridge rounds off into it.
  const half = Math.floor(SMOOTH_DAYS / 2)
  return heights.map((_, i) => {
    const h = Math.min(half, i, heights.length - 1 - i)
    let sum = 0
    for (let j = -h; j <= h; j++) sum += (h + 1 - Math.abs(j)) * heights[i + j]!
    return [start + i * DAY, sum / (h + 1) ** 2]
  })
}

// Rows in the order movies joined the standings
export function ridges(
  data: ChartData,
  start: number,
  end: number,
  runout = 0
): Ridge[] {
  const latest = data.days.at(-1)?.ids ?? []
  const ranks: Record<string, Record<string, number>> = {}
  const order: string[] = []
  const joined: Record<string, string> = {}
  for (const night of data.days) {
    night.ids.forEach((id, i) => {
      if (data.list && !data.list.includes(id)) return
      if (!ranks[id]) {
        ranks[id] = {}
        joined[id] = night.date
        order.push(String(id))
      }
      ranks[id][night.date] = i + 1
    })
  }
  const points = (id: string) =>
    Object.values(ranks[id]!).reduce((sum, r) => sum + MAX_RANK + 1 - r, 0)
  const standing = data.list
    ? data.list.map(String)
    : order.toSorted((a, b) => points(b) - points(a))
  return order.map((id, row) => {
    const nightRanks = Object.values(ranks[id]!)
    const movie = data.movies[id]
    return {
      id,
      title: movie?.title ?? "Unknown",
      release_date: movie?.release_date ?? null,
      joined: joined[id]!,
      row,
      best: Math.min(...nightRanks),
      nights: nightRanks.length,
      last: latest.includes(Number(id)) ? latest.indexOf(Number(id)) + 1 : null,
      rank: standing.indexOf(id) + 1,
      points: ridgeline(ranks[id]!, data.days, start, end, runout),
    }
  })
}

/** A year's list (best-pictures-YYYY.json), over every night its movies were
 * ranked, which can run into the next year. */
export function yearListOf(
  rankings: RankDay[],
  movies: Catalog,
  list: number[],
  year: number
): ChartData {
  const listed = rankings.filter((night) =>
    night.ids.some((id) => list.includes(id))
  )
  const [first, last] = [listed[0]?.date ?? "", listed.at(-1)?.date ?? ""]
  return {
    year,
    days: rankings.filter((night) => night.date >= first && night.date <= last),
    movies,
    list,
  }
}

/** The last 365 days of nights, up to the latest. */
export function pastYear(rankings: RankDay[], movies: Catalog): ChartData {
  const latest = rankings.at(-1)
  const from = latest
    ? new Date(utc(latest.date) - 364 * DAY).toISOString().slice(0, 10)
    : ""
  return {
    year: Number(latest?.date.slice(0, 4)) || new Date().getUTCFullYear(),
    days: rankings.filter((day) => day.date >= from),
    movies,
  }
}

/** First and last day the chart shows: from the start of the year up to the last night. */
export function yearSpan(data: { year: number; days: RankDay[] }) {
  const start = Date.UTC(data.year, 0, 1)
  const latest = data.days.at(-1)
  return { start, end: latest ? utc(latest.date) + DAY : start + DAY }
}
