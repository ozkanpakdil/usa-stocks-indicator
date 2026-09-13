// Bankruptcy & distress filings: SEC Form 8-K filings mentioning
// "Chapter 11" and/or "going concern" over the last 30 days.
// Runs two EDGAR full-text searches and merges them (dedupe by accession
// number); the Match column shows which phrase(s) each filing hit.
// Standalone weekly indicator; writes a Hugo post via hugohelpers.
import { eftsSearch, daysAgoISO, todayISO, type EftsHit } from "./edgar";
import { writeIndicatorPost } from "./hugohelpers";

const WINDOW_DAYS = 30;
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

interface DistressEntry {
  hit: EftsHit;
  ch11: boolean;
  goingConcern: boolean;
}

function matchLabel(entry: DistressEntry): string {
  if (entry.ch11 && entry.goingConcern) return "Both";
  if (entry.ch11) return "Ch. 11";
  return "Going concern";
}

async function run() {
  const startdt = daysAgoISO(WINDOW_DAYS - 1); // today minus 29
  const enddt = todayISO();
  console.log(`bankrupt: searching SEC EDGAR 8-Ks ${startdt}..${enddt} ...`);

  console.log('bankrupt: query 1/2: "Chapter 11" ...');
  const ch11Hits = await eftsSearch({ q: '"Chapter 11"', forms: ["8-K"], startdt, enddt });
  console.log(`bankrupt: ${ch11Hits.length} hits for "Chapter 11".`);

  console.log('bankrupt: query 2/2: "going concern" ...');
  const gcHits = await eftsSearch({ q: '"going concern"', forms: ["8-K"], startdt, enddt });
  console.log(`bankrupt: ${gcHits.length} hits for "going concern".`);

  // Merge both result sets, dedupe by accession number.
  const byAdsh = new Map<string, DistressEntry>();
  for (const hit of ch11Hits) {
    if (!hit.adsh || byAdsh.has(hit.adsh)) continue;
    byAdsh.set(hit.adsh, { hit, ch11: true, goingConcern: false });
  }
  for (const hit of gcHits) {
    if (!hit.adsh) continue;
    const existing = byAdsh.get(hit.adsh);
    if (existing) existing.goingConcern = true;
    else byAdsh.set(hit.adsh, { hit, ch11: false, goingConcern: true });
  }

  const entries = Array.from(byAdsh.values());
  console.log(`bankrupt: ${entries.length} unique filings after merging both queries.`);

  const rows = entries
    .sort((a, b) => b.hit.fileDate.localeCompare(a.hit.fileDate))
    .map(e => [
      e.hit.fileDate,
      cleanCompanyName(e.hit.displayName),
      tickerCell(e.hit),
      matchLabel(e),
      filingCell(e.hit),
    ]);

  const intro = rows.length
    ? `Bankruptcy and distress signals from SEC Form 8-K filings in the last ${WINDOW_DAYS} days: filings mentioning "Chapter 11" (bankruptcy petitions) and/or "going concern" (substantial doubt about the company's ability to continue operating).`
    : `Bankruptcy and distress signals from SEC Form 8-K filings mentioning "Chapter 11" and/or "going concern" in the last ${WINDOW_DAYS} days (no matching filings in the last ${WINDOW_DAYS} days).`;

  writeIndicatorPost({
    slug: "bankrupt",
    title: "Bankruptcy & Distress Filings (SEC 8-K)",
    tag: "bankruptcy",
    intro,
    table: { columns: ["Date", "Company", "Ticker", "Match", "Filing"], rows },
    dataSource: DATA_SOURCE,
    footnote: 'Match shows whether the filing text mentioned "Chapter 11", "going concern", or both. Full-text matches may also include references such as emerging from Chapter 11 or auditor going-concern notes.',
  });

  console.log(`bankrupt: done (${rows.length} rows).`);
}

run().catch((err) => {
  console.error("bankrupt failed:", err);
  process.exit(1);
});