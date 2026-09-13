import { searchTicker } from "./utils";
import { writeIndicatorPost } from "./hugohelpers";

// FDA drug approvals via openFDA drugsfda.
// Probed (2026-09-13): the field values are the Drugs@FDA status CODE "AP"
// (not the word "APPROVED" - searching %22APPROVED%22 returns 404) and dates
// are stored as YYYYMMDD, so the range query must use YYYYMMDD too:
//   submission_status:"AP" AND submission_status_date:[YYYYMMDD TO YYYYMMDD]
// The brief's "APPROVED" + YYYY-MM-DD form returns HTTP 404 (no matches).

const WINDOW_DAYS = 14;
const FETCH_TIMEOUT_MS = 60_000;
const TICKER_PACING_MS = 500;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function isoDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

/** YYYYMMDD -> YYYY-MM-DD (openFDA stores dates without dashes). */
function yyyymmddToIso(s: string): string {
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : "";
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchApprovals(start: string, end: string): Promise<any[]> {
  const url = `https://api.fda.gov/drug/drugsfda.json?search=submissions.submission_status:%22AP%22+AND+submissions.submission_status_date:[${start}+TO+${end}]&limit=100`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      console.log(`openFDA approval query (attempt ${attempt}/2), window ${start}-${end}...`);
      const res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
      // openFDA answers 404 NOT_FOUND when nothing matches the window.
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`openFDA HTTP ${res.status}`);
      const data = await res.json();
      return Array.isArray(data.results) ? data.results : [];
    } catch (e: any) {
      const isTimeout = e?.name === "AbortError" || /abort/i.test(String(e?.message ?? ""));
      if (!isTimeout) throw e;
      if (attempt === 2) {
        throw new Error("openFDA date-range approval search timed out on both attempts (60s each); aborting without writing a post.");
      }
      console.log("openFDA query timed out; retrying once...");
    }
  }
  return [];
}

/** Latest in-window "AP" (approved) submission date of one application, ISO. */
function approvalDate(app: any, start: string, end: string): string | null {
  const inWindow: string[] = [];
  for (const s of app.submissions ?? []) {
    if (String(s.submission_status ?? "").trim() !== "AP") continue;
    const iso = yyyymmddToIso(String(s.submission_status_date ?? ""));
    if (iso && iso >= start && iso <= end) inWindow.push(iso);
  }
  if (!inWindow.length) return null;
  inWindow.sort();
  return inWindow[inWindow.length - 1];
}

async function run() {
  const end = isoDate(new Date());
  const start = isoDate(new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000));

  const results = await fetchApprovals(start.replaceAll("-", ""), end.replaceAll("-", ""));
  console.log(`openFDA returned ${results.length} approved applications in window.`);

  const records: { date: string; company: string; drug: string }[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const app of results) {
    const date = approvalDate(app, start, end);
    if (!date) {
      skipped++;
      continue;
    }
    // First company name only; fall back to the first product's brand name.
    const company = String(app.openfda?.manufacturer_name?.[0] ?? app.products?.[0]?.brand_name ?? "").trim();
    const drug = String(app.openfda?.brand_name?.[0] ?? app.products?.[0]?.brand_name ?? "n/a").trim();
    const key = `${date}|${company}|${drug}`;
    if (!company || seen.has(key)) continue;
    seen.add(key);
    records.push({ date, company, drug });
  }
  if (skipped) console.log(`Skipped ${skipped} applications without an in-window approval date.`);
  records.sort((a, b) => b.date.localeCompare(a.date) || a.company.localeCompare(b.company) || a.drug.localeCompare(b.drug));

  // Ticker lookup: unique companies only, paced, cached.
  const tickerCell = new Map<string, string>();
  for (const r of records) {
    if (tickerCell.has(r.company)) continue;
    await sleep(TICKER_PACING_MS);
    console.log(`Ticker lookup: ${r.company}...`);
    const info = await searchTicker(r.company);
    tickerCell.set(r.company, info ? `[${info.symbol}](https://seekingalpha.com/symbol/${info.symbol})` : "n/a");
    if (info) console.log(`  -> ${info.symbol}`);
  }

  const rows = records.map(r => [r.date, r.company, r.drug, tickerCell.get(r.company) ?? "n/a"]);
  const withTicker = rows.filter(r => r[3] !== "n/a").length;

  const intro = rows.length
    ? `FDA drug approvals recorded by openFDA between ${start} and ${end}, newest first. Company is the first listed manufacturer; tickers link to Seeking Alpha.`
    : `No FDA drug approvals were recorded by openFDA in the ${start} to ${end} window.`;

  writeIndicatorPost({
    slug: "fda",
    title: "FDA Drug Approvals",
    tag: "fda",
    intro,
    table: {
      columns: ["Approval Date", "Company", "Drug", "Ticker"],
      rows,
    },
    dataSource: { name: "openFDA", url: "https://open.fda.gov/" },
    footnote: `*Approved applications (originals and supplements) in this window: ${results.length}; rows shown: ${rows.length}; tickers matched via Yahoo Finance (${withTicker} identified).*\n`,
  });

  console.log(`fda: ${rows.length} rows, ${withTicker} with ticker.`);
}

run().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});