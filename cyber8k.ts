// Cybersecurity incident disclosures: SEC Form 8-K filings referencing
// Item 1.05 ("Material Cybersecurity Incidents"), last 90 days.
// Covers official Item 1.05 filings AND follow-up materiality-assessment
// updates filed under Item 8.01 (e.g. Nutex "materiality_assessment"
// update) - both show in the Item column.
// Standalone weekly indicator; writes a Hugo post via hugohelpers.
import { eftsSearch, daysAgoISO, todayISO, type EftsHit } from "./edgar";
import { writeIndicatorPost } from "./hugohelpers";

const WINDOW_DAYS = 90;
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
  console.log(`cyber8k: searching SEC EDGAR for 8-K Item 1.05 filings ${startdt}..${enddt} ...`);

  const all = await eftsSearch({ q: '"Item 1.05"', forms: ["8-K"], startdt, enddt });
  console.log(`cyber8k: ${all.length} hits from EDGAR full-text search.`);

  // Keep every text match: the "Item 1.05" phrase IS the signal. Follow-up
  // filings (materiality-assessment updates) legitimately arrive under Item
  // 8.01, so the official items tag must not filter them away - it is shown
  // in the Item column instead.
  const rows = dedupeByAdsh(all)
    .sort((a, b) => b.fileDate.localeCompare(a.fileDate))
    .map(h => [
      h.fileDate,
      cleanCompanyName(h.displayName),
      tickerCell(h),
      h.items.length ? h.items.join(", ") : "n/a",
      filingCell(h),
    ]);

  const intro = rows.length
    ? `Companies that disclosed cybersecurity incidents in SEC Form 8-K filings referencing Item 1.05 (Material Cybersecurity Incidents) in the last ${WINDOW_DAYS} days, newest first. The Item column shows the official filing items: 1.05 is the initial material-incident disclosure, 8.01 entries are follow-up materiality-assessment updates. Registrants must report a material cyber incident within four business days of determining it is material.`
    : `Companies that disclose material cybersecurity incidents under Item 1.05 of SEC Form 8-K in the last ${WINDOW_DAYS} days (no matching filings in the last ${WINDOW_DAYS} days).`;

  writeIndicatorPost({
    slug: "cyber8k",
    title: "Cybersecurity Incident Disclosures (SEC 8-K)",
    tag: "cyber",
    intro,
    table: { columns: ["Date", "Company", "Ticker", "Item", "Filing"], rows },
    dataSource: DATA_SOURCE,
  });

  console.log(`cyber8k: done (${rows.length} rows).`);
}

run().catch((err) => {
  console.error("cyber8k failed:", err);
  process.exit(1);
});