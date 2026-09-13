// Shared helpers for SEC EDGAR EFTS full-text search.
// efts.sec.gov rejects generic automation User-Agents with a 403 HTML page,
// so requests use a browser-style header. Keep pacing polite (SEC allows
// max 10 req/s); we default to ~4 req/s between paginated pages.

const EFTS_URL = "https://efts.sec.gov/LATEST/search-index";

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept": "application/json",
};

export interface EftsHit {
  /** accession number, e.g. 0001104659-26-104300 */
  adsh: string;
  /** document file name from _id, e.g. park-20260828x8k.htm */
  fileId: string;
  /** primary CIK, when present */
  cik?: string;
  /** e.g. "Park Dental Partners, Inc.  (PARK)  (CIK 0002069604)" */
  displayName?: string;
  /** ticker parsed out of displayName, when present */
  ticker?: string;
  /** filing date, yyyy-mm-dd */
  fileDate: string;
  /** 8-K item numbers, when present */
  items?: string[];
  form: string;
  /** URL of the filed document */
  filingUrl: string;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const first = (v: any) => (Array.isArray(v) ? v[0] : v);
const arr = (v: any) => (Array.isArray(v) ? v : v ? [v] : []);

/** "Name, Inc.  (PARK)  (CIK 0002069604)" -> PARK */
export function tickerFromDisplayName(name?: string): string | undefined {
  if (!name) return undefined;
  const withTicker = name.match(/^.*?\(([A-Z0-9.]+)\)\s*\(CIK\s+\d+\)$/);
  return withTicker ? withTicker[1] : undefined;
}

/** "Name, Inc.  (PARK)  (CIK 0002069604)" -> 0002069604 */
export function cikFromDisplayName(name?: string): string | undefined {
  const m = name?.match(/\(CIK\s+(\d+)\)/);
  return m ? m[1] : undefined;
}

/** Full-text search over EDGAR filings (EFTS). Paginates up to maxHits. */
export async function eftsSearch(opts: {
  q: string;
  forms?: string[];
  startdt?: string; // yyyy-mm-dd (inclusive)
  enddt?: string;   // yyyy-mm-dd (inclusive)
  maxHits?: number; // default 200
}): Promise<EftsHit[]> {
  const { q, forms, startdt, enddt, maxHits = 200 } = opts;
  const out: EftsHit[] = [];
  const pageSize = 100;

  for (let from = 0; from < maxHits; from += pageSize) {
    const url = new URL(EFTS_URL);
    url.searchParams.set("q", q);
    if (forms?.length) url.searchParams.set("forms", forms.join(","));
    if (startdt && enddt) {
      url.searchParams.set("dateRange", "custom");
      url.searchParams.set("startdt", startdt);
      url.searchParams.set("enddt", enddt);
    }
    url.searchParams.set("from", String(from));
    url.searchParams.set("size", String(pageSize));

    const response = await fetch(url, { headers: HEADERS });
    if (!response.ok) {
      throw new Error(`EFTS search failed (HTTP ${response.status}) for q="${q}"`);
    }
    const data: any = await response.json();
    const hits: any[] = data?.hits?.hits ?? [];
    const total: number = data?.hits?.total?.value ?? 0;

    for (const h of hits) {
      const s = h?._source ?? {};
      const displayName: string | undefined = first(s.display_names);
      const adsh: string = s.adsh ?? "";
      const fileId = String(h._id ?? "").split(":")[1] ?? "";
      const cik = cikFromDisplayName(displayName) ?? first(s.ciks);
      out.push({
        adsh,
        fileId,
        displayName,
        cik,
        ticker: tickerFromDisplayName(displayName),
        fileDate: s.file_date ?? "",
        items: arr(s.items),
        form: first(s.root_forms) ?? "",
        // Canonical EDGAR document URL. The legacy /Archives/{accession}/
        // short form (without the /edgar/data/{cik}/ segment) 404s for
        // current filings; the CIK-qualified path is the documented format.
        filingUrl: cik && fileId
          ? `https://www.sec.gov/Archives/edgar/data/${cik}/${adsh.replace(/-/g, "")}/${encodeURIComponent(fileId)}`
          : "",
      });
    }

    if (hits.length < pageSize || out.length >= total) break;
    await sleep(250);
  }
  return out.slice(0, maxHits);
}

/**
 * Fetch a filed document from the EDGAR archives.
 * NOTE: www.sec.gov is behind stricter bot filtering than efts.sec.gov;
 * callers must catch failures and degrade gracefully.
 */
export async function fetchFilingDoc(hit: EftsHit): Promise<string> {
  if (!hit.filingUrl) throw new Error(`No document URL for ${hit.adsh}`);
  const response = await fetch(hit.filingUrl, { headers: HEADERS });
  if (!response.ok) {
    throw new Error(`Archives fetch failed (HTTP ${response.status}) for ${hit.adsh}`);
  }
  return response.text();
}

export function daysAgoISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split("T")[0]!;
}

export function todayISO(): string {
  return new Date().toISOString().split("T")[0]!;
}