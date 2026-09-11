// Deribit's public API as the reference market: the listed ETH option
// surface (mark IV per instrument), the DVOL index and the ETH index price.
// No key, server-side only (the copilot route), cached for 60 s. "Cheap" on
// Smile only means something against the venue everyone else prices off.

interface BookRow {
  instrument_name: string; // ETH-25SEP26-5800-C
  mark_iv: number | null; // percent
  mark_price: number | null; // in ETH
  open_interest: number;
  underlying_price: number;
}

export interface RefInstrument {
  name: string;
  strike: number;
  expiry: number; // unix seconds
  isCall: boolean;
  iv: number; // fraction, 0.62 = 62%
  markUsd: number;
  openInterest: number;
}

export interface ReferenceSurface {
  fetchedAt: number;
  indexPrice: number;
  dvol: number | null; // fraction
  instruments: RefInstrument[];
}

const MONTHS: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

function parseName(name: string): { strike: number; expiry: number; isCall: boolean } | null {
  const m = name.match(/^ETH-(\d{1,2})([A-Z]{3})(\d{2})-(\d+)-([CP])$/);
  if (!m) return null;
  const expiry = Date.UTC(2000 + Number(m[3]), MONTHS[m[2]], Number(m[1]), 8, 0, 0) / 1000; // Deribit expires 08:00 UTC
  return { strike: Number(m[4]), expiry, isCall: m[5] === "C" };
}

let cache: ReferenceSurface | null = null;

export async function referenceSurface(): Promise<ReferenceSurface> {
  if (cache && Date.now() - cache.fetchedAt < 60_000) return cache;
  const [book, index, dvol] = await Promise.all([
    fetch("https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=ETH&kind=option").then((r) => r.json()),
    fetch("https://www.deribit.com/api/v2/public/get_index_price?index_name=eth_usd").then((r) => r.json()),
    fetch(
      `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=ETH&resolution=3600&start_timestamp=${Date.now() - 3 * 3600_000}&end_timestamp=${Date.now()}`
    )
      .then((r) => r.json())
      .catch(() => null),
  ]);
  const indexPrice = Number(index?.result?.index_price ?? 0);
  const rows = (book?.result ?? []) as BookRow[];
  const instruments: RefInstrument[] = [];
  for (const r of rows) {
    const p = parseName(r.instrument_name);
    if (!p || !r.mark_iv) continue;
    instruments.push({
      name: r.instrument_name,
      ...p,
      iv: r.mark_iv / 100,
      markUsd: (r.mark_price ?? 0) * (r.underlying_price || indexPrice),
      openInterest: r.open_interest,
    });
  }
  const dvolRows = (dvol?.result?.data ?? []) as number[][];
  const last = dvolRows[dvolRows.length - 1];
  cache = { fetchedAt: Date.now(), indexPrice, dvol: last ? last[4] / 100 : null, instruments };
  return cache;
}

/** The listed instrument closest to (expiry, strike) on the same side, or null. */
export function nearestReference(
  s: ReferenceSurface,
  strike: number,
  expiry: number,
  isCall: boolean
): RefInstrument | null {
  let best: RefInstrument | null = null;
  let bestScore = Infinity;
  for (const i of s.instruments) {
    if (i.isCall !== isCall) continue;
    // Expiry distance in days weighs more than strike distance in %: a
    // week-off expiry is a different vol regime, 2% off in strike is not.
    const score = Math.abs(i.expiry - expiry) / 86400 + Math.abs(Math.log(i.strike / strike)) * 100;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/** ATM IV at the listed expiry nearest to `expiry` (average of the nearest call and put). */
export function atmReferenceIv(s: ReferenceSurface, expiry: number): { iv: number; expiry: number } | null {
  const c = nearestReference(s, s.indexPrice, expiry, true);
  const p = nearestReference(s, s.indexPrice, expiry, false);
  if (!c && !p) return null;
  const ivs = [c?.iv, p?.iv].filter((v): v is number => typeof v === "number");
  return { iv: ivs.reduce((a, b) => a + b, 0) / ivs.length, expiry: (c ?? p)!.expiry };
}
