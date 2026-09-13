// Famous fund 13F holdings, sourced from SEC EDGAR full-text search (EFTS).
//
// For each watchlist fund we search recent 13F-HR filings for the fund name,
// locate that filing's information-table document (nameOfIssuer / value per
// issuer, value = USD thousands) and publish the top 10 issuers per fund.
//
// Verified EFTS shape (2026-09): hits are per-DOCUMENT hits. A phrase like
// "RENAISSANCE TECHNOLOGIES" matches the fund's own filing almost always via
// its primary_doc.xml (the info table's text is issuer names, so EFTS does not
// return the info-table document itself for the fund's own name). The
// information table lives in the same accession directory, so when no info
// table appears directly in the hits we read the filing's index.json and pick
// the sibling info-table document. Hits for OTHER filers' info tables that
// merely mention the phrase as an issuer are only used as a last-resort
// fallback, never as the primary interpretation.
//
// WARNING: www.sec.gov/Archives is currently bot-blocked (HTTP 403 "Request
// Rate Threshold Exceeded") from this machine. Every Archives fetch is wrapped
// in try/catch; if ALL document fetches fail the script exits 1 without
// writing a stub post.

import {
  eftsSearch,
  fetchFilingDoc,
  daysAgoISO,
  todayISO,
  type EftsHit,
} from "./edgar";
import { searchTicker } from "./utils";
import { writeIndicatorPost } from "./hugohelpers";

const WATCHLIST = [
  "BERKSHIRE HATHAWAY",
  "RENAISSANCE TECHNOLOGIES",
  "BRIDGEWATER",
  "CITADEL ADVISORS",
  "POINT72",
  "MILLENNIUM MANAGEMENT",
  "D E SHAW",
  "TWO SIGMA",
];

const WINDOW_DAYS = 100;
const MAX_HITS_PER_FUND = 20;
const TOP_ISSUERS_PER_FUND = 10;
const MAX_TICKER_LOOKUPS = 30;
const TICKER_PACING_MS = 500;
const MAX_FETCH_ATTEMPTS_PER_FUND = 4;

const ARCHIVES_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

interface Holding {
  issuer: string;
  value: number; // USD thousands
}

interface FundRow {
  fund: string; // watchlist name
  issuer: string;
  value: number; // USD thousands
  ticker: string; // "" when unknown
}

interface Candidate {
  hit: EftsHit;
  origin: string; // where the candidate came from (for logs)
}

interface FundResult {
  fund: string;
  filer: string; // actual filer name of the parsed info table
  holdings: Holding[];
  fileDate: string;
}

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .trim();
}

/** 0 = definitely not an info table, >=2 = looks like one. */
function infoTableScore(fileId: string): number {
  const n = fileId.toLowerCase();
  let score = 0;
  if (/infotable|inftable/.test(n)) score += 4;
  if (/form13f|13fhr/.test(n)) score += 2;
  if (/table/.test(n)) score += 2;
  return score;
}

function isDocFile(fileId: string): boolean {
  return /\.(xml|html|htm|txt)$/i.test(fileId);
}

function isPrimaryDoc(fileId: string): boolean {
  return /primary[_-]?doc|coverpage?|signature|xsl/i.test(fileId);
}

function archivesDirUrl(adsh: string): string {
  return `https://www.sec.gov/Archives/${adsh.replace(/-/g, "")}`;
}

function archivesDocUrl(adsh: string, fileId: string): string {
  return `${archivesDirUrl(adsh)}/${fileId}`;
}

function hitLike(
  base: EftsHit,
  fileId: string,
  origin: string,
): Candidate {
  return {
    hit: {
      ...base,
      fileId,
      filingUrl: archivesDocUrl(base.adsh, fileId),
    },
    origin,
  };
}

/**
 * Sibling info-table documents of a filing, derived from the filing's
 * index.json (directory listing). EFTS does not always return the info-table
 * document itself for a fund's own name phrase.
 */
async function infoTableCandidatesFromIndex(
  base: EftsHit,
): Promise<Candidate[]> {
  const indexUrl = `${archivesDirUrl(base.adsh)}/index.json`;
  try {
    const res = await fetch(indexUrl, {
      headers: { "User-Agent": ARCHIVES_UA, Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data: any = await res.json();
    const items: any[] = data?.directory?.item ?? [];
    const scored = items
      .filter((it) => typeof it?.name === "string" && isDocFile(it.name))
      .filter((it) => !isPrimaryDoc(it.name))
      .map((it) => ({
        name: it.name as string,
        score:
          infoTableScore(it.name) + (/\.xml$/i.test(it.name) ? 1 : 0),
      }))
      .sort((a, b) => b.score - a.score); // stable; info-table-ish first
    const best = scored.filter((s) => s.score > 0).slice(0, 2);
    const rest = scored.filter((s) => s.score === 0).slice(0, 1);
    return [...best, ...rest].map((s) =>
      hitLike(base, s.name, `index.json:${base.fileId}`),
    );
  } catch (e) {
    console.log(
      `  filing index fetch failed for ${base.adsh} (${indexUrl}): ${e instanceof Error ? e.message : e}`,
    );
    return [];
  }
}

/**
 * Build an ordered list of documents to try for one watchlist fund:
 *   1. the fund's own filing whose fileId already looks like an info table
 *   2. sibling info-table docs derived from index.json of the fund's own
 *      most recent filing(s)
 *   3. last-resort fallback: any hit whose fileId looks like an info table
 *      (task-specified fallback when no XML info-table doc is in the hits)
 */
async function buildCandidates(phrase: string, hits: EftsHit[]): Promise<Candidate[]> {
  const phraseN = norm(phrase);
  const own = hits.filter(
    (h) => h.displayName && norm(h.displayName).includes(phraseN),
  );
  const pool = own.length ? own : hits;
  console.log(
    `${phrase}: ${hits.length} EFTS hits, ${own.length} from the fund's own filings` +
      (own.length ? "" : " (falling back to content matches)"),
  );

  const candidates: Candidate[] = [];

  // 1. direct info-table-looking documents among the fund's own hits
  const direct = pool
    .filter((h) => isDocFile(h.fileId) && infoTableScore(h.fileId) >= 2)
    .sort((a, b) => b.fileDate.localeCompare(a.fileDate)); // stable
  for (const h of direct.slice(0, 2)) {
    candidates.push({ hit: h, origin: `efts-direct:${h.fileId}` });
  }

  // 2. sibling info tables from the filing index of the most recent own hits
  const indexBases = pool
    .filter((h) => isDocFile(h.fileId))
    .sort((a, b) => b.fileDate.localeCompare(a.fileDate)); // stable
  for (const base of indexBases.slice(0, 2)) {
    if (candidates.length >= MAX_FETCH_ATTEMPTS_PER_FUND) break;
    candidates.push(...(await infoTableCandidatesFromIndex(base)));
  }

  // 3. task fallback: info-table-looking fileIds anywhere in the hits
  if (!candidates.length) {
    const fallback = hits
      .filter(
        (h) =>
          isDocFile(h.fileId) &&
          !isPrimaryDoc(h.fileId) &&
          infoTableScore(h.fileId) >= 2,
      )
      .sort((a, b) => b.fileDate.localeCompare(a.fileDate)); // stable
    for (const h of fallback.slice(0, 2)) {
      candidates.push({ hit: h, origin: `fallback:${h.fileId}` });
    }
  }

  return candidates.slice(0, MAX_FETCH_ATTEMPTS_PER_FUND);
}

/** Iterate <infoTable> blocks and extract issuer + value (USD thousands). */
function parseInfoTables(doc: string): Holding[] {
  const holdings: Holding[] = [];
  for (const m of doc.matchAll(/<infoTable>([\s\S]*?)<\/infoTable>/g)) {
    const block = m[1] ?? "";
    const issuer = block.match(/<nameOfIssuer>([\s\S]*?)<\/nameOfIssuer>/)?.[1];
    const valueStr = block.match(/<value>(\d+)<\/value>/)?.[1];
    if (!issuer || valueStr === undefined) continue;
    holdings.push({ issuer: decodeEntities(issuer), value: parseInt(valueStr, 10) });
  }
  return holdings;
}

/** Aggregate duplicate issuer rows (share classes) per fund, then top N. */
function topIssuers(holdings: Holding[], n: number): Holding[] {
  const byIssuer = new Map<string, number>();
  for (const h of holdings) {
    byIssuer.set(h.issuer, (byIssuer.get(h.issuer) ?? 0) + h.value);
  }
  return [...byIssuer.entries()]
    .map(([issuer, value]) => ({ issuer, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, n);
}

async function fetchOneFund(
  phrase: string,
  stats: { docsFetched: number; fetchFailures: string[] },
): Promise<FundResult | null> {
  const startdt = daysAgoISO(WINDOW_DAYS);
  const enddt = todayISO();
  const hits = await eftsSearch({
    q: `"${phrase}"`,
    forms: ["13F-HR"],
    startdt,
    enddt,
    maxHits: MAX_HITS_PER_FUND,
  });
  if (!hits.length) {
    console.log(`${phrase}: no 13F-HR EFTS hits in the last ${WINDOW_DAYS} days`);
    return null;
  }

  const candidates = await buildCandidates(phrase, hits);
  if (!candidates.length) {
    console.log(`${phrase}: no plausible info-table document among EFTS hits`);
    return null;
  }

  for (const cand of candidates) {
    let doc: string;
    try {
      doc = await fetchFilingDoc(cand.hit);
    } catch (e) {
      const reason = `Archives fetch failed for ${cand.hit.adsh}/${cand.hit.fileId} (${cand.origin}): ${e instanceof Error ? e.message : e}`;
      console.log(`  ${reason}`);
      stats.fetchFailures.push(reason);
      continue;
    }
    stats.docsFetched++;
    if (!doc.includes("<infoTable")) {
      console.log(
        `  fetched ${cand.hit.fileId} (${cand.origin}, ${doc.length} bytes) but it contains no <infoTable> — trying next candidate`,
      );
      continue;
    }
    const holdings = parseInfoTables(doc);
    if (!holdings.length) {
      console.log(
        `  fetched ${cand.hit.fileId} (${cand.origin}) but no parsable infoTable rows — trying next candidate`,
      );
      continue;
    }
    const top = topIssuers(holdings, TOP_ISSUERS_PER_FUND);
    const filer = cand.hit.displayName ?? phrase;
    console.log(
      `${phrase}: parsed ${holdings.length} infoTable rows from ${cand.hit.fileId} (filer: ${filer}, filed ${cand.hit.fileDate}); top value $${top[0]?.value.toLocaleString("en-US")}k`,
    );
    return { fund: phrase, filer, holdings: top, fileDate: cand.hit.fileDate };
  }
  console.log(`${phrase}: all ${candidates.length} document candidates failed`);
  return null;
}

async function run() {
  const stats = { docsFetched: 0, fetchFailures: [] as string[] };
  const results: FundResult[] = [];

  for (const phrase of WATCHLIST) {
    try {
      const res = await fetchOneFund(phrase, stats);
      if (res) results.push(res);
    } catch (e) {
      console.log(
        `${phrase}: fund lookup failed: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  // If every single Archives document fetch failed, www.sec.gov is
  // bot-blocking us — fail loud, do not write a stub post.
  if (stats.docsFetched === 0) {
    const sample = stats.fetchFailures[0] ?? "no fetch attempts recorded";
    console.error(
      "thirteenf.ts failed: ALL www.sec.gov/Archives document fetches failed " +
        `(${stats.fetchFailures.length} attempts). SEC EDGAR is likely bot-blocking ` +
        "this machine (HTTP 403 'Request Rate Threshold Exceeded'). No post written. " +
        `First failure: ${sample}`,
    );
    process.exit(1);
  }

  // Rows: watchlist order, value desc within each fund.
  const fundOrder = new Map(WATCHLIST.map((f, i) => [f, i]));
  const rows: FundRow[] = results
    .flatMap((r) =>
      r.holdings.map((h) => ({
        fund: r.fund,
        issuer: h.issuer,
        value: h.value,
        ticker: "",
      })),
    )
    .sort(
      (a, b) =>
        (fundOrder.get(a.fund) ?? 99) - (fundOrder.get(b.fund) ?? 99) ||
        b.value - a.value,
    );

  // Ticker lookups (Yahoo) for as many distinct issuers as the budget allows,
  // in row order so the top rows get symbols first.
  const tickerCache = new Map<string, string>();
  let lookups = 0;
  for (const row of rows) {
    if (tickerCache.has(row.issuer)) continue;
    if (lookups >= MAX_TICKER_LOOKUPS) break;
    if (lookups > 0) await sleep(TICKER_PACING_MS);
    lookups++;
    try {
      const quote = await searchTicker(row.issuer);
      tickerCache.set(row.issuer, quote?.symbol ?? "");
    } catch {
      tickerCache.set(row.issuer, "");
    }
  }
  for (const row of rows) {
    row.ticker = tickerCache.get(row.issuer) ?? "";
  }
  console.log(
    `${lookups} ticker lookups (${[...tickerCache.values()].filter(Boolean).length} matched)`,
  );

  const tickerCell = (t: string) =>
    t ? `[${t}](https://seekingalpha.com/symbol/${encodeURIComponent(t)})` : "";

  const failedFunds = WATCHLIST.filter(
    (f) => !results.some((r) => r.fund === f),
  );
  const failedNote = failedFunds.length
    ? ` Funds with no parsable info table this run: ${failedFunds.join(", ")}.`
    : "";
  const filers = results
    .map((r) => `${r.fund} → ${r.filer} (filed ${r.fileDate})`)
    .join("; ");

  writeIndicatorPost({
    slug: "thirteenf",
    title: "Famous Fund 13F Holdings",
    tag: "13f",
    intro: results.length
      ? `Top 10 holdings by reported value for the latest 13F-HR filings of well-known funds (last ${WINDOW_DAYS} days of filings). Values are in USD thousands as reported. ${results.length} of ${WATCHLIST.length} funds matched.${failedNote}`
      : `No 13F-HR info tables could be parsed for the fund watchlist in the last ${WINDOW_DAYS} days.${failedNote}`,
    table: {
      columns: ["Fund", "Issuer", "Value ($k)", "Ticker"],
      rows: rows.map((r) => [r.fund, r.issuer, r.value.toLocaleString("en-US"), tickerCell(r.ticker)]),
    },
    dataSource: {
      name: "SEC EDGAR 13F",
      url: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&form=13F-HR",
    },
    footnote:
      `*Value is the 13F reported market value in USD thousands; share-class rows of the same issuer are combined before ranking. Matched filings: ${filers}.*`,
  });
}

run().catch((err: unknown) => {
  console.error(
    "thirteenf.ts failed:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});