// Scheduled macro events and the event-vol heuristics the macro-context
// skill teaches. Dates are hardcoded for 2026 (no key, no feed): FOMC from
// the Fed's published calendar; CPI release days from the BLS schedule —
// verify against bls.gov if a date matters. Monthly and quarterly option
// expiries are computed (last Friday; Deribit settles 08:00 UTC).
// ponytail: a static table, swap for an economic-calendar API when one with
// a free tier is worth a key.

export interface MacroEvent {
  date: string; // YYYY-MM-DD (UTC)
  kind: "FOMC" | "CPI" | "NFP" | "monthly-expiry" | "quarterly-expiry";
  label: string;
  /** How ETH options usually behave around it — a heuristic, not a forecast. */
  heuristic: string;
}

const FOMC_2026 = ["2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29", "2026-09-17", "2026-10-28", "2026-12-09"];
const CPI_2026 = ["2026-01-13", "2026-02-11", "2026-03-11", "2026-04-10", "2026-05-12", "2026-06-10", "2026-07-14", "2026-08-12", "2026-09-11", "2026-10-14", "2026-11-10", "2026-12-10"];

function lastFriday(year: number, month0: number): string {
  const d = new Date(Date.UTC(year, month0 + 1, 0)); // last day of month
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 2) % 7));
  return d.toISOString().slice(0, 10);
}

export const HEURISTICS = [
  "Implied vol tends to rise into FOMC/CPI and drop right after (event-vol crush): short-dated straddles bought the day before usually need a move bigger than the expected move to pay.",
  "ETH's beta to BTC is roughly 1.2–1.5 and its beta to the Nasdaq-100 on macro days is positive: risk-off prints hit ETH harder than BTC.",
  "Weekend theta: Friday-to-Monday decay is priced by Friday afternoon; selling Friday premium is cheaper than it looks.",
  "Monthly and quarterly expiries concentrate open interest at round strikes (max-pain effect): expect spot to be pinned near the largest OI strike into the expiry hour, then free.",
  "Front-month IV above DVOL means the market is paying up for the near event; a calendar (sell front, buy back) is the structure that harvests it.",
];

export function upcomingEvents(daysAhead = 30, now = new Date()): MacroEvent[] {
  const year = now.getUTCFullYear();
  const out: MacroEvent[] = [];
  for (const date of FOMC_2026) out.push({ date, kind: "FOMC", label: "FOMC rate decision (statement 18:00 UTC)", heuristic: "IV builds for 2–3 days before and crushes within an hour after; skew steepens if a hawkish surprise is feared." });
  for (const date of CPI_2026) out.push({ date, kind: "CPI", label: "US CPI release (12:30 UTC)", heuristic: "The single biggest scheduled one-hour move of most months; front-week IV is bid the day before." });
  for (let m = 0; m < 12; m++) {
    const date = lastFriday(year, m);
    const quarterly = m % 3 === 2;
    out.push({
      date,
      kind: quarterly ? "quarterly-expiry" : "monthly-expiry",
      label: `${quarterly ? "Quarterly" : "Monthly"} listed-options expiry (Deribit 08:00 UTC)`,
      heuristic: quarterly ? "Largest OI roll of the quarter — pinning into 08:00 UTC, then realised vol often picks up." : "Pinning near the max-OI strike into expiry; theta-heavy weeks before.",
    });
  }
  const t0 = now.getTime();
  const t1 = t0 + daysAhead * 86400_000;
  return out
    .filter((e) => {
      const t = Date.parse(e.date + "T12:00:00Z");
      return t >= t0 - 86400_000 && t <= t1;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}
