// M&A announcements: SEC Form 8-K and 425 filings mentioning a
// "merger agreement", last 14 days.
// Standalone weekly indicator; writes a Hugo post via hugohelpers.
import { eftsSearch, daysAgoISO, todayISO, type EftsHit } from "./edgar";
import { writeIndicatorPost } from "./hugohelpers";

const WINDOW_DAYS = 14;
const DATA_SOURCE = { name: "SEC EDGAR", url: "https://efts.sec.gov/LATEST/search-index" };

/** "Name, Inc.  (PARK)  (CIK 0002069604)" -> "Name, Inc.  (PARK)" */
function cleanCompanyName(displayName?: string): string {
  if (!displayName) return "Unknown";
  const cleaned = displayName.replace(/\s*\(CIK\s+\d+\)\s*$/, "").trim();
  return cleaned || "Unknown";
}

/** [TICKER](seekingalpha) when known, else the plain company name. */
function tickerCell(hit: EftsHit): string {
  if (hit.ticker) return `[${hit.ticker}](https://seekingalpha.com/symbol/${hit.ticker})`;
  return cleanCompanyName(hit.displayName);
}

function filingCell(hit: EftsHit): string {
  return hit.filingUrl ? `[filing](${hit.filingUrl})` : "n/a";
}

/** Drop duplicate filings (same accession number), keep the first hit. */
function dedupeByAdsh(hits: EftsHit[]): EftsHit[] {
  const seen = new Set<string>();
  return hits.filter(h => {
    if (!h.adsh || seen.has(h.adsh)) return false;
    seen.add(h.adsh);
    return true;
  });
}

async function run() {
  const startdt = daysAgoISO(WINDOW_DAYS - 1); // today minus 13
  const enddt = todayISO();
  console.log(`mna: searching SEC EDGAR for 8-K/425 "merger agreement" filings ${startdt}..${enddt} ...`);

  const hits = await eftsSearch({ q: '"merger agreement"', forms: ["8-K", "425"], startdt, enddt });
  console.log(`mna: ${hits.length} hits from EDGAR full-text search.`);

  const rows = dedupeByAdsh(hits)
    .sort((a, b) => b.fileDate.localeCompare(a.fileDate))
    .map(h => [h.fileDate, cleanCompanyName(h.displayName), h.form || "N/A", tickerCell(h), filingCell(h)]);

  const intro = rows.length
    ? `Companies announcing merger agreements via SEC Form 8-K (material definitive agreements) and Form 425 (communications about business combinations) in the last ${WINDOW_DAYS} days. Full-text matches may also include amendments or terminations of earlier merger agreements.`
    : `Companies announcing merger agreements via SEC Form 8-K and Form 425 in the last ${WINDOW_DAYS} days (no matching filings in the last ${WINDOW_DAYS} days).`;

  writeIndicatorPost({
    slug: "mna",
    title: "M&A Announcements (SEC 8-K/425)",
    tag: "mna",
    intro,
    table: { columns: ["Date", "Company", "Form", "Ticker", "Filing"], rows },
    dataSource: DATA_SOURCE,
  });

  console.log(`mna: done (${rows.length} rows).`);
}

run().catch((err) => {
  console.error("mna failed:", err);
  process.exit(1);
});