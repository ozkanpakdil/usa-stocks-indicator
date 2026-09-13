// Insider stock purchases scraped from OpenInsider's public
// "latest-insider-trading" page. The page is plain HTML (~125KB), so a plain
// fetch() with a browser User-Agent is enough — no headless browser needed.
//
// Page shape (verified 2026-09): many <tr> rows; data rows have 17 <td> cells:
//   [0] filer flag, [1] filing datetime, [2] transaction date, [3] ticker
//   (anchor href="/TICKER", wrapped in a chart-tooltip with an <img> inside an
//   attribute — so the ticker must be read from href, not from tag-stripped
//   text), [4] company name, [5] industry, [6] number of filers, [7]
//   transaction code ("P - Purchase", "S - Sale", ...), [8] price, [9] shares
//   traded, [10] shares owned, [11] % change, [12] traded value ("+$9,166,870").
//
// Output: purchases (code P) valued at $100,000 or more, newest filing first,
// max 100 rows, written as a Hugo post.

import { writeIndicatorPost } from "./hugohelpers";

const OPENINSIDER_URL = "http://openinsider.com/latest-insider-trading";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MIN_VALUE_USD = 100_000;
const MAX_ROWS = 100;

interface InsiderBuy {
  filed: string;   // filing datetime, "2026-09-11 17:14:08"
  traded: string;  // transaction date
  company: string;
  ticker: string;  // "" when unknown
  code: string;    // "P - Purchase"
  price: string;   // "$3.25"
  value: string;   // "+$9,166,870" (as shown on the page)
  valueNum: number;
}

/** Strip tags + decode common entities, collapse whitespace. */
function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Ticker from the first relative href="/X" inside the raw ticker cell. */
function tickerFromCell(raw: string): string {
  const m = raw.match(/href\s*=\s*"([^"]*)"/);
  const href = m?.[1];
  if (!href) return "";
  const t = (href.replace(/^\//, "").split("?", 1)[0] ?? "").trim();
  // Only keep plain symbol paths ("/GLOO"), not links to other sections.
  if (!t || t.includes("/") || !/^[A-Za-z0-9._-]+$/.test(t)) return "";
  return t.toUpperCase();
}

function parseMoney(s: string): number {
  const digits = s.replace(/[^0-9]/g, "");
  return digits ? parseInt(digits, 10) : 0;
}

function saTickerCell(ticker: string): string {
  return ticker
    ? `[${ticker}](https://seekingalpha.com/symbol/${encodeURIComponent(ticker)})`
    : "";
}

async function run() {
  const response = await fetch(OPENINSIDER_URL, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(
      `OpenInsider fetch failed: HTTP ${response.status} for ${OPENINSIDER_URL}`,
    );
  }
  const html = await response.text();
  console.log(
    `Fetched ${OPENINSIDER_URL} (HTTP ${response.status}, ${html.length} bytes)`,
  );

  const purchases: InsiderBuy[] = [];
  let purchaseRowCount = 0;
  for (const rowMatch of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...(rowMatch[1] ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(
      (c) => c[1] ?? "",
    );
    if (cells.length < 12) continue; // header/footer rows have fewer cells
    const code = text(cells[7]!);
    if (!code.startsWith("P")) continue;
    purchaseRowCount++;
    const ticker = tickerFromCell(cells[3] ?? "");
    purchases.push({
      filed: text(cells[1]!),
      traded: text(cells[2]!),
      company: text(cells[4]!),
      ticker,
      code,
      price: text(cells[8]!),
      value: text(cells[12]!),
      valueNum: parseMoney(text(cells[12]!)),
    });
  }

  if (purchaseRowCount === 0) {
    throw new Error(
      "No purchase (P) rows parsed from the OpenInsider page — page structure may have changed",
    );
  }
  console.log(
    `Parsed ${purchaseRowCount} purchase rows from ${html.match(/<tr[^>]*>/g)?.length ?? 0} table rows`,
  );

  const selected = purchases
    .filter((p) => p.valueNum >= MIN_VALUE_USD)
    .sort((a, b) => b.filed.localeCompare(a.filed)) // "YYYY-MM-DD HH:MM:SS" sorts lexically
    .slice(0, MAX_ROWS);
  console.log(
    `${selected.length} purchases >= $${MIN_VALUE_USD.toLocaleString("en-US")}`,
  );

  writeIndicatorPost({
    slug: "insiders",
    title: "Insider Stock Purchases",
    tag: "insiders",
    intro: selected.length
      ? `Largest insider purchases reported to the SEC in the latest filings window, valued at $100,000 or more, newest filing first. ${selected.length} purchase${selected.length === 1 ? "" : "s"} shown.`
      : "No insider purchases of $100,000 or more were found in the latest OpenInsider feed (purchases below the threshold were filtered out).",
    table: {
      columns: ["Filed", "Traded", "Company", "Ticker", "Code", "Price", "Value"],
      rows: selected.map((p) => [
        p.filed,
        p.traded,
        p.company,
        saTickerCell(p.ticker),
        p.code,
        p.price,
        p.value,
      ]),
    },
    dataSource: { name: "OpenInsider", url: "http://openinsider.com/" },
    footnote:
      "*Purchases only (transaction code P), traded value at or above $100,000, ordered by filing time. Value and price are as reported on Form 4. Tickers link to Seeking Alpha.*",
  });
}

run().catch((err: unknown) => {
  console.error("insiders.ts failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});