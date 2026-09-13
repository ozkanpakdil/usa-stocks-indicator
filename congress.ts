// congress.ts — scraper for US congressional stock trades (STOCK Act disclosures)
// from capitoltrades.com. The site returns HTTP 403 to plain HTTP clients
// (Cloudflare), so we render it in headless Chromium via Playwright, exactly
// like layoffs.ts does for layoffs.fyi.
//
// Page structure (verified against the live DOM):
//   table tbody tr            -> one row per trade (12 rows per page)
//   ?page=N                   -> paginates (page 2, 3, ...)
// Per row:
//   .politician-name a        -> politician name
//   .politician-info .party   -> party (Democrat/Republican/Independent)
//   .politician-info .chamber -> chamber (House/Senate)
//   .politician-info .us-state-compact -> state (CA, TX, ...)
//   .issuer-name a            -> issuer (company) name
//   .issuer-ticker            -> "AMD:US" or "N/A"
//   [class*="tx-type--"]      -> buy / sell / exchange (uppercased via CSS)
//   td[7]                     -> trade size range, e.g. "1K–15K"
//   date tds                  -> two stacked divs: "11 Sept" + "2026"

import { chromium } from "playwright";
import { writeIndicatorPost } from "./hugohelpers";
import { searchTicker } from "./utils";

const BASE_URL = "https://www.capitoltrades.com/trades";
const TARGET_ROWS = 50;
const ROWS_PER_PAGE = 12; // site default ("Show 12")
const MAX_PAGES = Math.ceil(TARGET_ROWS / ROWS_PER_PAGE) + 1; // 6 pages -> headroom
const MAX_TICKER_LOOKUPS = 15;
const TICKER_LOOKUP_DELAY_MS = 500;

interface RawTrade {
  politician: string;
  party: string;
  chamber: string;
  state: string;
  issuer: string;
  rawTicker: string;
  type: string;
  size: string;
  href: string;
  pubDay: string;
  pubYear: string;
  traDay: string;
  traYear: string;
}

interface Trade {
  published: string; // ISO date the STOCK Act disclosure was published
  traded: string; // ISO date of the transaction
  politician: string;
  chamberParty: string;
  type: string; // BUY / SELL / EXCHANGE
  issuer: string;
  ticker?: string;
  size: string;
  /** on-page ticker in "AMD:US" form, or "N/A" (stripped before posting) */
  rawTicker?: string;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/** Parse "11 Sept" + "2026" (two stacked divs) into "2026-09-11". */
function parseDate(dayMon: string, year: string): string {
  const m = dayMon.trim().match(/^(\d{1,2})\s+([A-Za-z]+)\.?$/);
  const y = year.trim();
  if (!m || !/^\d{4}$/.test(y)) return "0000-00-00";
  const month = MONTHS[m[2].toLowerCase()] ?? MONTHS[m[2].toLowerCase().slice(0, 3)];
  if (!month) return "0000-00-00";
  return `${y}-${String(month).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Extract raw trade rows from the currently loaded trades page. */
async function extractRows(page: import("playwright").Page): Promise<RawTrade[]> {
  return page.evaluate(() => {
    const text = (el: Element | null | undefined) =>
      (el?.textContent || "").replace(/\s+/g, " ").trim();

    const out: RawTrade[] = [];
    for (const tr of Array.from(document.querySelectorAll("table tbody tr"))) {
      const tds = Array.from(tr.querySelectorAll("td"));
      if (tds.length < 9) continue;

      // Date cells hold two stacked leaf divs: day+month, then year.
      const dateParts = (td: Element) =>
        Array.from(td.querySelectorAll("div"))
          .filter(d => !d.querySelector("div"))
          .map(d => text(d));
      const pub = dateParts(tds[2]);
      const tra = dateParts(tds[3]);

      const txEl = tr.querySelector('[class*="tx-type--"]');
      const tickerEl = tr.querySelector(".issuer-ticker");

      out.push({
        politician: text(tr.querySelector(".politician-name a")),
        party: text(tr.querySelector(".politician-info .party")),
        chamber: text(tr.querySelector(".politician-info .chamber")),
        state: text(tr.querySelector(".politician-info .us-state-compact")),
        issuer: text(tr.querySelector(".issuer-name a")),
        rawTicker: text(tickerEl),
        type: text(txEl ?? tds[6]).toUpperCase(),
        size: text(tds[7]),
        href: tr.querySelector('a[href*="/trades/"]')?.getAttribute("href") || "",
        pubDay: pub[0] ?? "",
        pubYear: pub[1] ?? "",
        traDay: tra[0] ?? "",
        traYear: tra[1] ?? "",
      });
    }
    return out;
  });
}

async function scrapeTrades(): Promise<Trade[]> {
  console.log(`Starting scraper for capitoltrades.com...`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: "en-US",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  try {
    const seen = new Set<string>();
    const trades: Trade[] = [];

    for (let pageNum = 1; pageNum <= MAX_PAGES && trades.length < TARGET_ROWS; pageNum++) {
      const url = pageNum === 1 ? BASE_URL : `${BASE_URL}?page=${pageNum}`;
      console.log(`Navigating to ${url} ...`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForSelector("table tbody tr", { timeout: 30000 });
      // Small settle delay so hydrated rows are complete and stable.
      await sleep(1500);

      const pageTitle = await page.title();
      const raw = await extractRows(page);
      if (!raw.length) {
        // 0 rows after a successful load is a real failure: include the page
        // title so a block/consent page is distinguishable from a layout change.
        throw new Error(
          `capitoltrades.com page ${pageNum} loaded (title: "${pageTitle}") but the trades table has 0 rows after waiting - layout may have changed or the page is blocked`
        );
      }

      let fresh = 0;
      for (const r of raw) {
        if (!r.href || seen.has(r.href)) continue;
        seen.add(r.href);
        fresh++;
        trades.push({
          published: parseDate(r.pubDay, r.pubYear),
          traded: parseDate(r.traDay, r.traYear),
          politician: r.politician,
          chamberParty: [r.chamber, r.party, r.state].filter(Boolean).join(" · "),
          type: r.type || "UNKNOWN",
          issuer: r.issuer,
          size: r.size || "N/A",
          rawTicker: r.rawTicker,
        });
      }
      console.log(`Page ${pageNum}: ${raw.length} rows, ${fresh} new (total ${trades.length})`);
      if (fresh === 0) break; // repeated page -> nothing new to gain
      if (trades.length < TARGET_ROWS) await sleep(1500);
    }

    if (!trades.length) {
      throw new Error(
        `capitoltrades.com produced 0 trades after loading (title: "${await page.title()}")`
      );
    }

    // Newest first: by publication date, then transaction date.
    trades.sort((a, b) => {
      if (a.published !== b.published) return b.published.localeCompare(a.published);
      return b.traded.localeCompare(a.traded);
    });
    return trades.slice(0, TARGET_ROWS);
  } finally {
    await browser.close();
  }
}

/** Prefer the on-page ticker ("AMD:US" -> AMD); fall back to Yahoo search. */
async function resolveTickers(trades: Trade[], rawTickers: Map<string, string>) {
  let lookups = 0;
  for (const t of trades) {
    const raw = rawTickers.get(t.issuer + "|" + t.politician) || "";
    let symbol = "";
    const m = raw.match(/^([A-Z0-9.\-]+):[A-Z]{2}$/);
    if (m) {
      symbol = m[1];
    } else if (lookups < MAX_TICKER_LOOKUPS && t.issuer) {
      await sleep(TICKER_LOOKUP_DELAY_MS);
      const info = await searchTicker(t.issuer);
      lookups++;
      if (info) symbol = info.symbol;
    }
    if (symbol) t.ticker = symbol;
  }
  console.log(`Ticker resolution done (searchTicker lookups used: ${lookups})`);
}

async function run() {
  const trades = await scrapeTrades();

  // Keep the on-page ticker before it is overwritten by the search fallback.
  const rawTickers = new Map<string, string>();
  for (const t of trades) {
    if (t.rawTicker) rawTickers.set(t.issuer + "|" + t.politician, t.rawTicker);
    delete t.rawTicker;
  }
  await resolveTickers(trades, rawTickers);

  const rows = trades.map(t => [
    t.published,
    t.politician,
    t.chamberParty,
    t.type,
    t.issuer,
    t.ticker ? `[${t.ticker}](https://seekingalpha.com/symbol/${t.ticker})` : "N/A",
    t.size,
  ]);

  writeIndicatorPost({
    slug: "congress",
    tag: "congress",
    title: "US Congressional Stock Trades",
    intro:
      "The most recent US congressional stock trades disclosed under the STOCK Act, as tracked by Capitol Trades. " +
      "Rows are sorted by disclosure publication date, newest first.",
    table: {
      columns: ["Published", "Politician", "Chamber & Party", "Trade", "Issuer", "Ticker", "Amount"],
      rows,
    },
    dataSource: { name: "Capitol Trades", url: "https://www.capitoltrades.com/" },
    footnote:
      "*Published* is the date the STOCK Act periodic transaction report was made public; " +
      "*Amount* is the disclosed trade size range (e.g. 1K–15K, 100K–250K). " +
      "Tickers are taken from Capitol Trades when available, otherwise matched via Yahoo Finance; issuers without a listed ticker are shown as N/A.",
  });
}

run().catch(err => {
  console.error("Congress trades scraper failed:", err.message);
  process.exit(1);
});