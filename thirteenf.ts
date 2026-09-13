// 13F holdings of famous "superinvestor" funds, aggregated by Dataroma.
// Primary EDGAR source (www.sec.gov/Archives) is bot-blocked from both this
// machine and GitHub Actions runners (HTTP 403), and efts.sec.gov only serves
// search metadata, not document content. Dataroma mirrors the same quarterly
// 13F holdings in plain HTML tables, so it is the reliable source here.
// Standalone weekly indicator; writes a Hugo post via hugohelpers.
import { writeIndicatorPost } from "./hugohelpers";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const PACING_MS = 700;
const TOP_N_PER_FUND = 8;

/** Dataroma manager codes (from https://www.dataroma.com/m/home.php). */
const FUNDS: { code: string; name: string }[] = [
  { code: "BRK", name: "Warren Buffett - Berkshire Hathaway" },
  { code: "BAUPOST", name: "Seth Klarman - Baupost Group" },
  { code: "AM", name: "David Tepper - Appaloosa Management" },
  { code: "GLRE", name: "David Einhorn - Greenlight Capital" },
  { code: "AC", name: "Chuck Akre - Akre Capital Management" },
  { code: "psc", name: "Bill Ackman - Pershing Square Capital" },
  { code: "tp", name: "Daniel Loeb - Third Point" },
  { code: "TGM", name: "Chase Coleman - Tiger Global Management" },
  { code: "vg", name: "Viking Global Investors" },
  { code: "LPC", name: "Stephen Mandel - Lone Pine Capital" },
  { code: "MKL", name: "Thomas Gayner - Markel Group" },
  { code: "SE", name: "Mason Hawkins - Southeastern Asset Management" },
];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Holding {
  fund: string;
  symbol: string;
  name: string;
  pctPortfolio: string;
  value: string;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&[#\w]+;/g, " ").replace(/\s+/g, " ").trim();
}

function parseHoldings(fund: string, html: string): Holding[] {
  const out: Holding[] = [];
  for (const row of html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const cells = Array.from(row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)).map(m => stripTags(m[1]));
    if (cells.length < 7) continue;
    // data cells: [1] "SYMBOL - Name", [2] "% of portfolio", [6] "Value"
    const stock = cells[1] ?? "";
    const m = stock.match(/^([A-Z0-9.]+)\s+-\s+(.+)$/);
    if (!m) continue;
    const [, symbol, name] = m;
    const pct = cells[2] ?? "";
    const value = cells[6] ?? "";
    if (!symbol || !pct || !/^[0-9.]+$/.test(pct)) continue;
    out.push({ fund, symbol: symbol!, name: name!, pctPortfolio: pct, value });
  }
  // rows are ordered by portfolio weight; keep the biggest positions
  return out.slice(0, TOP_N_PER_FUND);
}

async function run() {
  console.log(`13f: fetching Dataroma holdings for ${FUNDS.length} funds...`);
  const all: Holding[] = [];
  let succeeded = 0;

  for (const fund of FUNDS) {
    const url = `https://www.dataroma.com/m/holdings.php?m=${fund.code}`;
    try {
      const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const holdings = parseHoldings(fund.name, await res.text());
      console.log(`${fund.name}: ${holdings.length} holdings`);
      if (holdings.length > 0) succeeded++;
      all.push(...holdings);
    } catch (e) {
      console.error(`${fund.name}: fetch failed - ${(e as Error).message}`);
    }
    await sleep(PACING_MS);
  }

  if (succeeded === 0) {
    throw new Error("All Dataroma fund fetches failed; no 13F data available.");
  }

  const rows = all.map(h => [
    h.fund,
    h.symbol,
    `[${h.name}](https://seekingalpha.com/symbol/${h.symbol})`,
    `${h.pctPortfolio}%`,
    h.value,
  ]);

  writeIndicatorPost({
    slug: "thirteenf",
    title: "Famous Fund 13F Holdings",
    tag: "13f",
    intro:
      `Top holdings of ${succeeded} famous "superinvestor" funds based on their latest quarterly 13F ` +
      `filings with the SEC, aggregated by Dataroma. Positions are as of each fund's most recent 13F ` +
      `filing (filed within 45 days of quarter end).`,
    table: { columns: ["Fund", "Symbol", "Company", "% of Portfolio", "Value"], rows },
    dataSource: { name: "Dataroma (SEC 13F filings)", url: "https://www.dataroma.com/m/home.php" },
  });

  console.log(`13f: done (${rows.length} rows from ${succeeded} funds).`);
}

run().catch(err => {
  console.error("thirteenf failed:", err?.message ?? err);
  process.exit(1);
});