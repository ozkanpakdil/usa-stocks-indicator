// Market trend dashboard: SMA50/SMA200 position + 1w/1m/3m performance for a
// 15-ETF watchlist (broad indices + all 11 SPDR sectors), benchmarked vs SPY.
// Request budget: 15 chart fetches + 15 performance fetches + 1 shared SPY
// benchmark ≈ 31 Yahoo requests per run (cap ~45); 500ms pacing between calls.

import { fetchDailyCloses, getPerformanceWindows, type PerfReport } from "./utils";
import { writeIndicatorPost } from "./hugohelpers";

interface WatchItem {
  tick: string;
  segment: string;
}

const WATCHLIST: WatchItem[] = [
  { tick: "SPY", segment: "US Large Caps" },
  { tick: "QQQ", segment: "Nasdaq 100" },
  { tick: "IWM", segment: "Small Caps" },
  { tick: "DIA", segment: "Dow 30" },
  { tick: "XLK", segment: "Technology" },
  { tick: "XLF", segment: "Financials" },
  { tick: "XLE", segment: "Energy" },
  { tick: "XLV", segment: "Health Care" },
  { tick: "XLI", segment: "Industrials" },
  { tick: "XLY", segment: "Consumer Discretionary" },
  { tick: "XLP", segment: "Staples" },
  { tick: "XLU", segment: "Utilities" },
  { tick: "XLB", segment: "Materials" },
  { tick: "XLRE", segment: "Real Estate" },
  { tick: "XLC", segment: "Communication Svcs" },
];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Yahoo pacing: keep 500ms between consecutive requests. */
const pace = () => sleep(500);

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Signed percent with 1 decimal, e.g. "+2.3%"; "n/a" when missing. */
function pct(v: number | null | undefined): string {
  if (typeof v !== "number" || !isFinite(v)) return "n/a";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

interface BreadthRow {
  tick: string;
  segment: string;
  price: number | null;
  vsSma50: number | null;
  vsSma200: number | null;
  perf: PerfReport | null;
}

/** Position vs an SMA in percent: ((price / sma) - 1) * 100. */
function vsSma(price: number, sma: number): number | null {
  if (!isFinite(price) || !isFinite(sma) || sma === 0) return null;
  return (price / sma - 1) * 100;
}

function buildRow(item: WatchItem, bars: { close: number }[], perf: PerfReport | null): BreadthRow {
  const closes = bars.map(b => b.close).filter(c => isFinite(c));
  const price = closes.length ? closes[closes.length - 1] : null;
  const sma50 = closes.length >= 50 ? mean(closes.slice(-50)) : null;
  const sma200 = closes.length >= 200 ? mean(closes.slice(-200)) : null;
  return {
    tick: item.tick,
    segment: item.segment,
    price,
    vsSma50: price !== null && sma50 !== null ? vsSma(price, sma50) : null,
    vsSma200: price !== null && sma200 !== null ? vsSma(price, sma200) : null,
    perf,
  };
}

function runIntro(rows: BreadthRow[]): string {
  const above50 = rows.filter(r => r.vsSma50 !== null && r.vsSma50 > 0).length;
  const above200 = rows.filter(r => r.vsSma200 !== null && r.vsSma200 > 0).length;
  const sma200Note = rows.some(r => r.vsSma200 !== null)
    ? ""
    : " (SMA200 comparisons are n/a: 6 months of daily bars is below the 200-bar minimum)";
  return (
    `Cross-asset trend check for the major index ETFs and the 11 SPDR sector funds. ` +
    `**${above50} of ${rows.length}** ETFs trade above their 50-day average and ` +
    `**${above200} of ${rows.length}** above their 200-day average${sma200Note}. ` +
    `Returns are versus SPY over the same window in the last column. ` +
    `This data is current market context, not event-driven.`
  );
}

async function run(): Promise<void> {
  console.log(`Fetching daily closes for ${WATCHLIST.length} ETFs...`);
  const rows: BreadthRow[] = [];
  const failed: string[] = [];

  for (const item of WATCHLIST) {
    try {
      const bars = await fetchDailyCloses(item.tick);
      await pace();
      const perf = await getPerformanceWindows(item.tick);
      rows.push(buildRow(item, bars, perf));
      console.log(
        `${item.tick}: ${bars.length} bars, price ${bars[bars.length - 1]?.close ?? "?"}`
      );
    } catch (e) {
      failed.push(item.tick);
      console.error(`Skipping ${item.tick}: ${(e as Error).message}`);
    }
    await pace();
  }

  if (failed.length === WATCHLIST.length) {
    throw new Error("Every watchlist ETF failed to fetch; Yahoo Finance is unreachable.");
  }

  if (!rows.length) {
    // Zero data rows: still publish a post noting it, exit 0.
    writeIndicatorPost({
      slug: "market-dashboard",
      title: "Market Trend Dashboard",
      tag: "dashboard",
      intro:
        "No ETF price history could be retrieved from Yahoo Finance this run, " +
        "so the market trend dashboard is empty. This data is current market context, not event-driven.",
      table: {
        columns: ["ETF", "Segment", "Price", "vs SMA50", "vs SMA200", "1w", "1m", "3m", "3m vs SPY"],
        rows: [],
      },
      dataSource: { name: "Yahoo Finance", url: "https://finance.yahoo.com/" },
      footnote: "All watchlist chart requests failed; check the next scheduled run.",
    });
    return;
  }

  // Most sensible ordering for a trend dashboard: leaders first — sort by
  // 3-month return, descending; ETFs without 3m data sink to the bottom.
  const threeMonth = (r: BreadthRow): number => r.perf?.windows["3m"]?.changePercent ?? -Infinity;
  const sorted = [...rows].sort((a, b) => threeMonth(b) - threeMonth(a));

  const tableRows = sorted.map(r => [
    r.tick,
    r.segment,
    r.price !== null ? r.price.toFixed(2) : "n/a",
    pct(r.vsSma50),
    pct(r.vsSma200),
    pct(r.perf?.windows["1w"]?.changePercent),
    pct(r.perf?.windows["1m"]?.changePercent),
    pct(r.perf?.windows["3m"]?.changePercent),
    pct(r.perf?.excess["3m"]),
  ]);

  writeIndicatorPost({
    slug: "market-dashboard",
    title: "Market Trend Dashboard",
    tag: "dashboard",
    intro: runIntro(rows),
    table: {
      columns: ["ETF", "Segment", "Price", "vs SMA50", "vs SMA200", "1w", "1m", "3m", "3m vs SPY"],
      rows: tableRows,
    },
    dataSource: { name: "Yahoo Finance", url: "https://finance.yahoo.com/" },
    footnote:
      "*Price is the latest daily close. SMA50/SMA200 are simple moving averages of the last 50/200 daily closes " +
      "(each shown only when at least that many bars are available; the 6-month history used here is ~130 bars, " +
      "so vs SMA200 can be n/a). '3m vs SPY' is the ETF's 3-month return minus SPY's over the same window, in points.*",
  });

  if (failed.length) {
    console.warn(`Warning: ${failed.length} ETFs skipped (${failed.join(", ")})`);
  }
  console.log(`Market dashboard done: ${rows.length} rows, ${failed.length} failures.`);
}

run().catch(err => {
  console.error("breadth.ts failed:", err);
  process.exit(1);
});