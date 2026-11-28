// Build-time data for the pages. Reads the files `pnpm build:data` writes to
// public/; without them (local dev, CI) uses the live site's files instead.
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { FIRST_YEAR, SITE } from "@/consts"
import { moviePath } from "@/lib/links"
import { RUNOUT_DAYS, type Ridge, ridges, yearSpan } from "@/lib/ridgeline"
import type { Catalog, CatalogMovie, ListMovie, RankDay } from "@/lib/types"

/** A published file, or null if neither public/ nor the live site has it. */
async function load<T>(name: string): Promise<T | null> {
  try {
    return JSON.parse(
      await readFile(join(process.cwd(), "public", name), "utf8")
    )
  } catch {
    const resp = await fetch(`${SITE.url}/${name}`)
    if ([403, 404].includes(resp.status)) return null
    if (!resp.ok) throw new Error(`${name}: live site answered ${resp.status}`)
    return resp.json() as Promise<T>
  }
}

let standings: Promise<ListMovie[]> | undefined
/** The current standings, best first. */
export function getStandings(): Promise<ListMovie[]> {
  standings ??= load<ListMovie[]>("best-pictures.json").then((list) => {
    if (!list) throw new Error("best-pictures.json not found")
    return list
  })
  return standings
}

let history: Promise<{ rankings: RankDay[]; catalog: Catalog }> | undefined
/** Every night's standings, oldest first, and the movies in them (empty before the first history). */
export function getHistory() {
  history ??= Promise.all([
    load<RankDay[]>("data/rankings.json"),
    load<Catalog>("data/movies.json"),
  ]).then(([rankings, catalog]) => ({
    rankings: rankings ?? [],
    catalog: catalog ?? {},
  }))
  return history
}

const spans = new Map<string, Promise<SpanRidges>>()
export interface SpanRidges {
  start: number
  end: number
  /** Every movie ranked in the span, in the order they joined, each ridge
   * running RUNOUT_DAYS past the end. */
  ridges: Ridge[]
}
/** The ridges from the start of `first` up to the last night of `last`, worked
 * out once for every movie page that spans those years. */
export function getSpan(first: number, last: number): Promise<SpanRidges> {
  const key = `${first}-${last}`
  if (!spans.has(key)) {
    spans.set(
      key,
      getHistory().then(({ rankings, catalog }) => {
        const days = rankings.filter((night) => {
          const year = Number(night.date.slice(0, 4))
          return year >= first && year <= last
        })
        const data = { year: first, days, movies: catalog }
        const { start, end } = yearSpan(data)
        return { start, end, ridges: ridges(data, start, end, RUNOUT_DAYS) }
      })
    )
  }
  return spans.get(key)!
}

/** Every year with a page, newest first. */
export function getYears(): number[] {
  const thisYear = new Date().getUTCFullYear()
  return Array.from(
    { length: thisYear - FIRST_YEAR + 1 },
    (_, i) => thisYear - i
  )
}

/** A year's list (best-pictures-YYYY.json), best first, as its page lists it. */
export async function getYearList(year: number) {
  const list = (await load<ListMovie[]>(`best-pictures-${year}.json`)) ?? []
  return list.map((movie) => ({
    id: movie.tmdb_id,
    title: movie.title,
    poster_url: movie.poster_url ?? null,
    genres: movie.genres,
    href: moviePath({ id: movie.tmdb_id, title: movie.title }),
  }))
}

export interface MovieSummary extends CatalogMovie {
  id: number
  /** Its current rank, or null if it isn't in the current standings. */
  current: number | null
  best: number | null
  /** The first night it reached its best rank. */
  bestNight: string | null
  nights: number
  firstNight: string | null
  lastNight: string | null
  /** The years it was in the standings. */
  years: number[]
}

/** Every movie that has been in the standings, or is now. */
export async function getMovies(): Promise<MovieSummary[]> {
  const [list, { rankings, catalog }] = await Promise.all([
    getStandings(),
    getHistory(),
  ])
  const movies = new Map<number, MovieSummary>()
  const get = (id: number, info: CatalogMovie) => {
    let movie = movies.get(id)
    if (!movie) {
      movie = {
        id,
        ...info,
        current: null,
        best: null,
        bestNight: null,
        nights: 0,
        firstNight: null,
        lastNight: null,
        years: [],
      }
      movies.set(id, movie)
    }
    return movie
  }

  for (const night of rankings) {
    const year = Number(night.date.slice(0, 4))
    night.ids.forEach((id, i) => {
      const movie = get(id, catalog[id]!)
      if (movie.years.at(-1) !== year) movie.years.push(year)
      if (i + 1 < (movie.best ?? Infinity)) {
        movie.best = i + 1
        movie.bestNight = night.date
      }
      movie.nights++
      movie.firstNight ??= night.date
      movie.lastNight = night.date
    })
  }

  list.forEach((item, i) => {
    const movie = get(item.tmdb_id, {
      ...item,
      release_date: null,
      runtime: null,
      trailer_url: null,
      ...catalog[item.tmdb_id],
    })
    movie.current = i + 1
  })

  return [...movies.values()]
}
