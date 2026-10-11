// executive.ts — scraper for US executive-branch stock trades.
//
// Congress files under the STOCK Act; the President and Senate-confirmed
// executive-branch officials file with the Office of Government Ethics (OGE)
// instead, on Form 278 (annual) and Form 278-T (periodic transactions). OGE
// publishes those filings as PDFs, so unlike congress.ts (which renders a
// Cloudflare-protected table in Chromium) this scraper talks to OGE directly.
//
// Sources (both are plain server-rendered HTML):
//   PAS+Filings+by+Date?OpenView              -> filings by cabinet/senior
//                                                officials, newest first
//   President+and+Vice+President+Index?OpenView -> President & VP filings
//
// IMPORTANT: OGE's Lotus Notes app only routes the "+"-encoded URLs; the
// "%20"-encoded equivalents silently 302 to a generic OGE search page.
//
// Per filing row we get: filed date, filing type + report date, official,
// agency, position and a link to the filing PDF. The PDF itself contains the
// transaction table:
//
//   #  DESCRIPTION              TYPE      DATE        NOTIFICATION  AMOUNT
//   1  Walmart, Inc. (WMT)      Sale      03/24/2025  No            $1,001 - $15,000
//
// Two kinds of PDFs exist and they need different extraction:
//   * digitally generated (most officials, e.g. Hegseth): unpdf's merged text
//     gives one clean line per transaction.
//   * scanned + OCR'd (e.g. Trump's): the text layer splits columns into
//     separate blocks, so merged text is useless. We rebuild visual lines from
//     pdf.js text-item coordinates instead. The OCR is noisy ("ourchaso" for
//     "purchase", "Sll/2025" for "8/11/2025"), so types are matched fuzzily and
//     dates are repaired digit-by-digit, then sanity-checked against the
//     report date. Rows whose date cannot be repaired confidently are dropped
//     rather than published with a wrong date.

import { readFileSync, writeFileSync, existsSync } from "fs";
import { extractText, getDocumentProxy } from "unpdf";
import { writeIndicatorPost } from "./hugohelpers";
import { searchTicker } from "./utils";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const OGE_ORIGIN = "https://extapps2.oge.gov";

const BY_DATE_URL = `${OGE_ORIGIN}/201/Presiden.nsf/PAS+Filings+by+Date?OpenView`;
const POTUS_URL = `${OGE_ORIGIN}/201/Presiden.nsf/President+and+Vice+President+Index?OpenView`;

/** Bump when the parsing logic changes so cached PDF parses are redone. */
const PARSER_VERSION = 3;
const CACHE_FILE = "executive_cache.json";

// Bound the work: a weekly run should stay a few minutes. OGE keeps ~330
// transaction filings in total, so the window only needs to be wide enough to
// cover the current administration - two years reaches back past the first
// Cabinet confirmations, which is what keeps officials who have not traded
// recently (e.g. Hegseth) in the list.
const LOOKBACK_DAYS = Number(process.env.EXEC_LOOKBACK_DAYS ?? 730);
const MAX_FILINGS = Number(process.env.EXEC_MAX_FILINGS ?? 400);
const MAX_ROWS = Number(process.env.EXEC_MAX_ROWS ?? 100);
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 90_000;
const PDF_CONCURRENCY = 4;
const MAX_TICKER_LOOKUPS = 25;
const TICKER_LOOKUP_DELAY_MS = 400;

interface Filing {
  /** ISO date OGE posted the filing (falls back to the report date). */
  filed: string;
  /** report date encoded in the link label, e.g. "278 Transaction (08/12/2025)" */
  reportDate: string;
  /** true when the filing is an amendment to an earlier report */
  amended: boolean;
  url: string;
  official: string;
  agency: string;
  position: string;
}

interface Tx {
  /** ISO date of the transaction */
  traded: string;
  official: string;
  role: string;
  type: string; // BUY / SELL / EXCHANGE
  issuer: string;
  ticker?: string;
  amount: string;
  reportDate: string;
  filed: string;
  url: string;
  /** true when the row came out of an OCR'd (scanned) filing */
  ocr?: boolean;
}

interface CacheEntry {
  version: number;
  txs: Omit<Tx, "official" | "role" | "reportDate" | "filed" | "url">[];
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── filing index ────────────────────────────────────────────────────────────

const strip = (s: string) =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

interface HtmlRow {
  cells: string[];
  link?: { text: string; url: string };
}

function parseRows(html: string): HtmlRow[] {
  const out: HtmlRow[] = [];
  for (const tr of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const body = tr[1] ?? "";
    const tds = [...body.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1] ?? "");
    if (!tds.length) continue;
    const a = body.match(/<a\s+href='([^']+)'[^>]*>([\s\S]*?)<\/a>/);
    out.push({
      cells: tds.map(strip),
      link: a ? { text: strip(a[2] ?? ""), url: a[1] ?? "" } : undefined,
    });
  }
  return out;
}

async function fetchText(url: string): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctl.signal });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

/** "Hegseth, Pete" -> "Pete Hegseth"; leaves already-natural names alone. */
function naturalName(raw: string): string {
  const s = raw.trim().replace(/\s+/g, " ");
  const i = s.indexOf(",");
  if (i < 0) return s;
  const last = s.slice(0, i).trim();
  const rest = s.slice(i + 1).trim();
  return rest ? `${rest} ${last}` : last;
}

/** Report date from a link label like "278 Transaction (08/12/2025)". */
const labelDate = (s: string) => s.match(/\((\d{2})\/(\d{2})\/(\d{4})\)/);

const isoOf = (m: RegExpMatchArray | null) => (m ? `${m[3]}-${m[1]}-${m[2]}` : "");

/**
 * Read the PAS by-date view (cabinet and other senior officials). Each row is
 * [posted date, filing link, official, agency, position].
 */
function parseByDate(html: string): Filing[] {
  const out: Filing[] = [];
  for (const r of parseRows(html)) {
    if (r.cells.length < 5 || !r.link || !isTransactionFiling(r.link.text)) continue;
    const posted = r.cells[0] ?? "";
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(posted)) continue;
    const [mm, dd, yyyy] = posted.split("/") as [string, string, string];
    out.push({
      filed: `${yyyy}-${mm}-${dd}`,
      reportDate: isoOf(labelDate(r.link.text)),
      amended: /amend/i.test(r.link.url + r.link.text),
      url: r.link.url.startsWith("http") ? r.link.url : OGE_ORIGIN + r.link.url,
      official: naturalName(r.cells[2] ?? ""),
      agency: r.cells[3] ?? "",
      position: r.cells[4] ?? "",
    });
  }
  return out;
}

/**
 * Read the President & VP index. It is grouped: a 2-cell row names the
 * officeholder ("Trump, Donald J, White House Office, President") and each
 * following row carries one filing link, with no date of its own.
 */
function parsePotus(html: string): Filing[] {
  const out: Filing[] = [];
  let cur = { official: "", agency: "", position: "" };
  for (const r of parseRows(html)) {
    if (!r.link && r.cells.length === 2 && r.cells[0]) {
      // "Trump, Donald J, White House Office, President": the name itself
      // contains a comma, so peel agency and position off the right.
      const parts = r.cells[0].split(",").map(s => s.trim()).filter(Boolean);
      const position = parts.length > 2 ? parts[parts.length - 1] ?? "" : "";
      const agency = parts.length > 2 ? parts[parts.length - 2] ?? "" : "";
      const name = parts.slice(0, Math.max(1, parts.length - 2)).join(", ");
      cur = { official: naturalName(name), agency, position };
      continue;
    }
    if (!r.link || !isTransactionFiling(r.link.text)) continue;
    out.push({
      filed: "",
      reportDate: isoOf(labelDate(r.link.text)),
      amended: /amend/i.test(r.link.url + r.link.text),
      url: r.link.url.startsWith("http") ? r.link.url : OGE_ORIGIN + r.link.url,
      ...cur,
    });
  }
  return out;
}

const isTransactionFiling = (label: string) => /^278\s*Transaction/i.test(label);

// ── PDF text extraction ─────────────────────────────────────────────────────

/**
 * Merged text (works for digitally generated filings). The buffer is copied
 * because pdf.js transfers it to its worker, which detaches the original and
 * would break the OCR fallback's second read of the same bytes.
 */
async function digitalText(buf: Uint8Array): Promise<string> {
  const doc = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(doc, { mergePages: true });
  return text;
}

/**
 * Rebuild visual lines from text-item coordinates. Needed for scanned filings
 * whose OCR text layer groups a whole column together in the merged text.
 */
async function visualLines(buf: Uint8Array): Promise<string[]> {
  const doc = await getDocumentProxy(new Uint8Array(buf));
  const lines: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc: any = await page.getTextContent();
    const items = (tc.items as any[])
      .filter(i => i.str && i.str.trim())
      .map(i => ({ s: i.str, x: i.transform[4], y: i.transform[5] }));
    // Bucket items into rows by vertical position.
    const rows: { y: number; items: typeof items }[] = [];
    for (const it of items) {
      const row = rows.find(r => Math.abs(r.y - it.y) <= 3);
      if (row) row.items.push(it);
      else rows.push({ y: it.y, items: [it] });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) {
      lines.push(r.items.sort((a, b) => a.x - b.x).map(i => i.s).join(" ").replace(/\s+/g, " ").trim());
    }
  }
  return lines;
}

// ── transaction parsing ─────────────────────────────────────────────────────

/** Amounts as "1K–15K" so the post matches the congressional tables. */
function formatAmount(lo: string, hi: string): string {
  const short = (n: number) =>
    n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`
    : n >= 1_000 ? `${+(n / 1_000).toFixed(n % 1_000 ? 1 : 0)}K`
    : String(n);
  // OCR likes to insert spaces inside numbers ("$100,00 1").
  const a = Number(lo.replace(/[\s,]/g, ""));
  const b = Number(hi.replace(/[\s,]/g, ""));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return `$${lo}–$${hi}`;
  return `${short(a)}–${short(b)}`;
}

// Standalone type tokens, tolerant of the OCR garbling seen in scanned
// filings ("ourchaso", "oun:hasc"). Anchored on whitespace so words such as
// "Salesforce" in a description cannot be mistaken for the TYPE column.
const TYPE_RE =
  /(?:^|\s)(exchange[d]?|exchang[ea]|sale[s]?|sell|sold|purchase[sd]?|purchas[ea]?|purchasc|buy|bought|ourchase[sd]?|ourchasc|ourchas[eo]|oun:hasc|ounhasc|ounhase)(?=\s|$)/gi;

function normalizeType(token: string): string {
  const s = token.toLowerCase().replace(/[^a-z]/g, "");
  if (/exchang|exch/.test(s)) return "EXCHANGE";
  if (/^sale|^sell|^sold/.test(s)) return "SELL";
  if (/^buy|^bought|urchas|ourch|ounh|purcha|purch|urcas/.test(s)) return "BUY";
  return "";
}

// OCR confusions common in the scanned filings' date column.
const DIGIT_FIX: Record<string, string> = {
  S: "8", B: "8", O: "0", Q: "0", D: "0", I: "1", l: "1", "|": "1",
  Z: "2", E: "3", A: "4", G: "6", T: "7", g: "9", q: "9",
};

/** Repair an OCR'd date such as "Sll/2025" -> "2025-08-11". */
function repairDate(raw: string): string | null {
  const clean = raw.replace(/[.\s]/g, "");
  const parts = clean.split("/");
  const fix = (s: string) =>
    s.split("").map(c => (/[0-9]/.test(c) ? c : DIGIT_FIX[c] ?? DIGIT_FIX[c.toUpperCase()] ?? "")).join("");
  let mm: string, dd: string, yyyy: string;
  if (parts.length === 3) {
    [mm, dd, yyyy] = parts.map(fix) as [string, string, string];
  } else if (parts.length === 2) {
    // A slash was lost to OCR: "Sll/2025" is really "8/11/2025", and
    // "1/2812025" is really "1/28/2025".
    const [a, y] = parts.map(fix) as [string, string];
    if (y.length === 7) { mm = a; dd = y.slice(0, 2); yyyy = y.slice(2); }
    else {
      yyyy = y;
      if (a.length === 3) { mm = a[0] ?? ""; dd = a.slice(1); }
      else if (a.length === 4) { mm = a.slice(0, 2); dd = a.slice(2); }
      else if (a.length === 1) { mm = a; dd = "1"; }
      else return null;
    }
  } else return null;
  if (!/^\d{1,2}$/.test(mm) || !/^\d{1,2}$/.test(dd) || !/^\d{4}$/.test(yyyy)) return null;
  const M = Number(mm), D = Number(dd), Y = Number(yyyy);
  if (M < 1 || M > 12 || D < 1 || D > 31 || Y < 2015 || Y > 2100) return null;
  return `${Y}-${String(M).padStart(2, "0")}-${String(D).padStart(2, "0")}`;
}

function isoAddDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const TICKER_RE = /\(([A-Z]{1,6}(?:\.[A-Z])?)\)\s*$/;

/**
 * Long amount ranges wrap onto the following line in some filings
 * ("... No $1,000,001 -" / "$5,000,000"), which hides the upper bound from a
 * per-line parse. Re-join those before parsing.
 */
function joinWrappedAmounts(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i] ?? "";
    while (i + 1 < lines.length && /\$[\d][\d,\s]*[-–—•]\s*$/.test(line)) {
      i++;
      line = `${line} ${lines[i] ?? ""}`.trim();
    }
    out.push(line);
  }
  return out;
}

interface ParsedRow {
  traded: string;
  type: string;
  issuer: string;
  ticker?: string;
  amount: string;
}

/**
 * Parse one transaction line. Description and TYPE may sit on the same line
 * (digital filings, and rebuilt OCR lines) and the description can itself
 * contain dates (bond maturity dates), so everything is anchored off the
 * trailing "... DATE <Yes|No> $LO - $HI" block.
 */
function parseTxLine(raw: string, reportDate: string): ParsedRow | null {
  const line = raw.replace(/\s+/g, " ").trim();

  // 1. amount pair at the end of the line. OCR inserts spaces inside numbers
  //    ("$100,00 1"), so digits are matched permissively and cleaned later.
  const am = line.match(/\$(\d[\d,\s]*?)\s*[-–—•."'`,;]*\s*\$(\d[\d,\s]*?)\s*$/);
  if (!am) return null;
  const amount = formatAmount(am[1] ?? "", am[2] ?? "");
  let head = line.slice(0, am.index).trim();

  // 2. "Yes"/"No" notification flag (junk may sit between it and the amount)
  const notif = head.match(/(Yes|No)\b[^A-Za-z]*$/i);
  if (notif) head = head.slice(0, notif.index).trim();

  // 3. the DATE immediately before it
  const dm = head.match(
    /([0-9SBOGZlI|]{1,2}[\/\\|][0-9SBOGZlI|]{1,3}[\/\\|]\d{4}|[0-9SBOGZlI|]{1,3}[\/\\|]\d{4})[^0-9A-Za-z]*$/
  );
  if (!dm) return null;
  const traded = repairDate(dm[1] ?? "");
  if (!traded) return null;
  head = head.slice(0, dm.index).trim();

  // 4. drop the row index, then split the TYPE token off the description
  head = head.replace(/^\d{1,4}\s+/, "");
  const matches = [...head.matchAll(TYPE_RE)];
  if (!matches.length) return null;
  const last = matches[matches.length - 1];
  if (!last) return null;
  const type = normalizeType(last[1] ?? "");
  if (!type) return null;
  const issuer = head
    .slice(0, last.index)
    .replace(/[\s,;.\-–]+$/, "")
    .replace(/\s*(?:see\s+)?endnotes?\.?$/i, "")
    .trim();
  if (!issuer) return null;

  // 5. transactions must sit in a plausible window around the report date
  if (reportDate) {
    if (traded > isoAddDays(reportDate, 45) || traded < isoAddDays(reportDate, -400)) return null;
  }

  const tk = issuer.match(TICKER_RE);
  // A few rows describe the asset only by its ticker, e.g. "1 (CAMOX) Sale ...".
  const name = tk ? issuer.slice(0, tk.index).replace(/[\s,;.\-–]+$/, "").trim() : issuer;
  return {
    traded,
    type,
    issuer: name || tk?.[1] || issuer,
    ticker: tk ? tk[1] : undefined,
    amount,
  };
}

/** Digital filings: one transaction per merged-text line. */
function parseDigital(text: string, reportDate: string): ParsedRow[] {
  const out: ParsedRow[] = [];
  for (const line of joinWrappedAmounts(text.split("\n"))) {
    if (!line.includes("$")) continue;
    const p = parseTxLine(line, reportDate);
    if (p) out.push(p);
  }
  return out;
}

/** Scanned filings: rebuild rows visually, then parse the same way. */
function parseOcr(lines: string[], reportDate: string): ParsedRow[] {
  const out: ParsedRow[] = [];
  for (const line of joinWrappedAmounts(lines)) {
    if (!line.includes("$")) continue;
    const p = parseTxLine(line, reportDate);
    if (p) out.push(p);
  }
  return out;
}

// ── main pipeline ───────────────────────────────────────────────────────────

/** Keep the newest filing when the same report was filed more than once. */
function dedupeFilings(filings: Filing[]): Filing[] {
  const groups = new Map<string, Filing[]>();
  for (const f of filings) {
    const key = `${f.official}|${f.reportDate}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(f);
  }
  const out: Filing[] = [];
  for (const g of groups.values()) {
    const amended = g.filter(f => f.amended);
    out.push(...(amended.length ? amended : g));
  }
  return out;
}

async function parsePdf(buf: Uint8Array, reportDate: string): Promise<{ rows: ParsedRow[]; ocr: boolean }> {
  let rows: ParsedRow[] = [];
  try {
    rows = parseDigital(await digitalText(buf), reportDate);
  } catch (e: any) {
    console.warn(`  merged-text extraction failed: ${e.message}`);
  }
  if (rows.length) return { rows, ocr: false };
  const lines = await visualLines(buf);
  return { rows: parseOcr(lines, reportDate), ocr: true };
}

/**
 * `permanent` marks a filing that will never parse (too large to be a text
 * PDF), so the caller can remember the verdict instead of re-downloading tens
 * of megabytes every week. Transient failures stay uncached and are retried.
 */
async function download(url: string): Promise<{ buf?: Uint8Array; permanent: boolean }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctl.signal });
    if (!res.ok) {
      console.warn(`  HTTP ${res.status}`);
      return { permanent: false };
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_PDF_BYTES) {
      console.warn(`  skipped (${(buf.length / 1024 / 1024).toFixed(1)} MB) ${url.split("/$FILE/").pop()}`);
      return { permanent: true };
    }
    return { buf, permanent: false };
  } catch (e: any) {
    console.warn(`  download failed: ${e.message}`);
    return { permanent: false };
  } finally {
    clearTimeout(t);
  }
}

function loadCache(): Record<string, CacheEntry> {
  if (!existsSync(CACHE_FILE)) return {};
  try {
    const raw = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
    for (const [k, v] of Object.entries(raw)) {
      if ((v as CacheEntry).version !== PARSER_VERSION) delete raw[k];
    }
    return raw;
  } catch {
    return {};
  }
}

async function run() {
  console.log("Fetching OGE filing indexes...");
  const [byDateHtml, potusHtml] = await Promise.all([fetchText(BY_DATE_URL), fetchText(POTUS_URL)]);

  const all: Filing[] = [...parseByDate(byDateHtml), ...parsePotus(potusHtml)];

  const cutoff = isoAddDays(new Date().toISOString().slice(0, 10), -LOOKBACK_DAYS);
  const recent = dedupeFilings(all)
    .filter(f => !f.reportDate || f.reportDate >= cutoff)
    .sort((a, b) => (b.reportDate || b.filed).localeCompare(a.reportDate || a.filed))
    .slice(0, MAX_FILINGS);

  console.log(
    `${all.length} 278-T filings found, ${recent.length} within ${LOOKBACK_DAYS} days ` +
      `(${new Set(recent.map(f => f.official)).size} officials)`
  );
  console.log(`Hegseth filings: ${recent.filter(f => /hegseth/i.test(f.official)).length}`);

  const cache = loadCache();
  const txs: Tx[] = [];
  let fetched = 0, cached = 0, ocrPdfs = 0, failed = 0;

  const work = [...recent];
  const worker = async () => {
    for (;;) {
      const f = work.shift();
      if (!f) return;
      const key = f.url;
      let entries = cache[key]?.txs;
      if (entries) {
        cached++;
      } else {
        const dl = await download(f.url);
        if (!dl.buf) {
          // Remember only permanent verdicts; transient errors are retried.
          if (dl.permanent) cache[key] = { version: PARSER_VERSION, txs: [] };
          failed++;
          continue;
        }
        const buf = dl.buf;
        try {
          const { rows: parsed, ocr } = await parsePdf(buf, f.reportDate);
          if (ocr) ocrPdfs++;
          entries = parsed.map(p => ({
            traded: p.traded,
            type: p.type,
            issuer: p.issuer,
            ticker: p.ticker,
            amount: p.amount,
            ocr,
          }));
          cache[key] = { version: PARSER_VERSION, txs: entries };
          fetched++;
          console.log(`  ${f.official} ${f.reportDate || f.filed}: ${entries.length} txns${ocr ? " (ocr)" : ""}`);
        } catch (e: any) {
          console.warn(`  parse failed for ${f.url.slice(-40)}: ${e.message}`);
          failed++;
          continue;
        }
        await sleep(150);
      }
      for (const e of entries) {
        txs.push({
          ...e,
          official: f.official,
          role: [f.position, f.agency].filter(Boolean).join(" · "),
          reportDate: f.reportDate,
          filed: f.filed,
          url: f.url,
        });
      }
    }
  };
  await Promise.all(Array.from({ length: PDF_CONCURRENCY }, worker));
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));

  // Amendments can repeat rows; collapse identical disclosures. A row is the
  // same trade when the who/what/when/how-much all match.
  const seen = new Set<string>();
  let deduped = txs.filter(t => {
    const k = [t.official, t.traded, t.type, t.issuer, t.amount].join("|");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  console.log(
    `PDFs: ${fetched} parsed, ${cached} cached, ${ocrPdfs} scanned/OCR, ${failed} failed; ` +
      `${txs.length} rows -> ${deduped.length} after amendment dedupe`
  );

  // Prefer the ticker printed on the filing; fall back to Yahoo for the rest.
  // Resolved tickers are written back into the cache so an unchanged week
  // reuses them instead of re-querying (and so the post does not drift).
  const rowKey = (x: { traded: string; type: string; issuer: string; amount: string }) =>
    [x.traded, x.type, x.issuer, x.amount].join("|");
  let lookups = 0;
  for (const t of deduped) {
    if (t.ticker || !t.issuer) continue;
    const entry = cache[t.url];
    const match = entry?.txs.find(e => rowKey(e) === rowKey(t));
    if (match?.ticker) {
      t.ticker = match.ticker;
      continue;
    }
    if (lookups >= MAX_TICKER_LOOKUPS) break;
    await sleep(TICKER_LOOKUP_DELAY_MS);
    const info = await searchTicker(t.issuer);
    lookups++;
    if (info) {
      t.ticker = info.symbol;
      if (match) match.ticker = info.symbol;
    }
  }
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));
  console.log(`Ticker lookups used: ${lookups}`);

  // One official can dominate the list outright (the President files hundreds
  // of rows per report), which would push the rest of the administration out
  // of a purely chronological top-N. Select in rounds - every official's
  // newest row, then their second-newest, and so on - so each official with a
  // disclosure is represented, then present the selection chronologically.
  const byOfficial = new Map<string, Tx[]>();
  for (const t of deduped) {
    (byOfficial.get(t.official) ?? byOfficial.set(t.official, []).get(t.official)!).push(t);
  }
  const byDateDesc = (a: Tx, b: Tx) =>
    b.traded.localeCompare(a.traded) ||
    (b.reportDate || b.filed).localeCompare(a.reportDate || a.filed);
  const queues = [...byOfficial.values()].map(list => list.sort(byDateDesc));
  const picked: Tx[] = [];
  for (let round = 0; picked.length < MAX_ROWS; round++) {
    let added = false;
    for (const q of queues) {
      const row = q[round];
      if (!row) continue;
      picked.push(row);
      added = true;
      if (picked.length >= MAX_ROWS) break;
    }
    if (!added) break;
  }
  deduped = picked.sort(byDateDesc);
  console.log(`Selected ${deduped.length} rows across ${byOfficial.size} officials`);
  if (!deduped.length) throw new Error("OGE produced 0 executive-branch transactions");

  const rowsOut = deduped.map(t => [
    t.traded,
    t.official,
    t.role,
    t.type,
    t.issuer,
    t.ticker ? `[${t.ticker}](https://seekingalpha.com/symbol/${t.ticker})` : "N/A",
    t.amount,
    `[278-T](${t.url})`,
  ]);

  writeIndicatorPost({
    slug: "executive",
    tag: "executive",
    title: "US Executive Branch Stock Trades",
    date: process.env.EXEC_DATE,
    intro:
      "Recent stock trades disclosed by the President, the Vice President and Senate-confirmed " +
      "executive-branch officials. These are filed with the U.S. Office of Government Ethics on " +
      "Form 278-T rather than under the STOCK Act, so they are tracked separately from congressional " +
      "trades. Each official's most recent transactions are included, ordered by transaction date, " +
      "newest first.",
    table: {
      columns: ["Traded", "Official", "Role & Agency", "Trade", "Issuer", "Ticker", "Amount", "Report"],
      rows: rowsOut,
    },
    maxRows: MAX_ROWS,
    dataSource: {
      name: "US Office of Government Ethics — Form 278-T filings",
      url: "https://extapps2.oge.gov/201/Presiden.nsf/PAS+Filings+by+Date?OpenView",
    },
    footnote:
      "*Amount* is the disclosed trade size range and *Report* links to the original OGE filing. " +
      "Transactions may be disclosed up to 45 days after they occur, so the newest trades appear with a lag. " +
      "Scanned filings (including the President's) are read from their OCR text layer: types and dates are " +
      "normalised, and trades whose date or amount cannot be read confidently are omitted rather than guessed. " +
      "Amendments supersede earlier filings and identical rows are collapsed.",
  });
}

run().catch(err => {
  console.error("Executive trades scraper failed:", err.message);
  process.exit(1);
});
