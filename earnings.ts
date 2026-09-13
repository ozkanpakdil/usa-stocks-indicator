// DJIA earnings surprises: for Dow components that reported within the last
// 10 days, show the latest reported quarter's EPS estimate vs actual vs
// surprise, plus 1-week post-earnings performance vs SPY.
//
// Yahoo v10 quoteSummary needs a cookie+crumb dance (verified):
//   1. GET https://fc.yahoo.com with redirect: "manual" -> A3 set-cookie
//      (any status is fine; it answers 404 but still sets the cookie).
//   2. GET v1/test/getcrumb with that cookie -> crumb token.
//   3. GET v10/finance/quoteSummary/<tick>?modules=...&crumb=<crumb>.
// If the dance fails (429/401/empty), retry once after 5s, then fail loud.
//
// Request budget: 2 (crumb dance) + 29 quoteSummary + a few perf lookups
// for reported tickers + 1 shared SPY benchmark < ~45; 500ms pacing between calls.

import { getPerformanceWindows, type PerfReport } from "./utils";
import { writeIndicatorPost } from "./hugohelpers";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Hardcoded Dow Jones Industrial Average components (2024-2026 reshuffles:
 *  Amazon, Nvidia and Sherwin-Williams in; Dow Inc, Intel, Walgreens out). */
const DJIA: { tick: string; name?: string }[] = [
  { tick: "MMM", name: "3M" },
  { tick: "AMGN", name: "Amgen" },
  { tick: "AMZN", name: "Amazon" },
  { tick: "AXP", name: "American Express" },
  { tick: "AAPL", name: "Apple" },
  { tick: "BA", name: "Boeing" },
  { tick: "CAT", name: "Caterpillar" },
  { tick: "CVX", name: "Chevron" },
  { tick: "CSCO", name: "Cisco" },
  { tick: "KO", name: "Coca-Cola" },
  { tick: "DIS", name: "Disney" },
  { tick: "GS", name: "Goldman Sachs" },
  { tick: "HD", name: "Home Depot" },
  { tick: "HON", name: "Honeywell" },
  { tick: "IBM", name: "IBM" },
  { tick: "JNJ", name: "Johnson & Johnson" },
  { tick: "JPM", name: "JPMorgan" },
  { tick: "MCD", name: "McDonald's" },
  { tick: "MRK", name: "Merck" },
  { tick: "MSFT", name: "Microsoft" },
  { tick: "NKE", name: "Nike" },
  { tick: "NVDA", name: "Nvidia" },
  { tick: "PG", name: "Procter & Gamble" },
  { tick: "CRM", name: "Salesforce" },
  { tick: "SHW", name: "Sherwin-Williams" },
  { tick: "TRV", name: "Travelers" },
  { tick: "UNH", name: "UnitedHealth" },
  { tick: "V", name: "Visa" },
  { tick: "VZ", name: "Verizon" },
  { tick: "WMT", name: "Walmart" },
];

/** Report window: earnings reported within the last 10 days. */
const WINDOW_DAYS = 10;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Yahoo pacing: keep 500ms between consecutive requests. */
const pace = () => sleep(500);

/** Yahoo chart/quote `raw` numbers are seconds since epoch in some fields and
 *  milliseconds in others; normalize to ms defensively. */
function toMs(v: unknown): number | null {
  if (typeof v !== "number" || !isFinite(v) || v <= 0) return null;
  return v > 1e12 ? v : v * 1000;
}

/** Fallback date parsing for quarter/report dates given as strings. */
function parseDateStr(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return isFinite(t) ? t : null;
}

const fmtDate = (ms: number): string => new Date(ms).toISOString().split("T")[0];

/** Signed percent with 1 decimal, e.g. "+2.3%"; "n/a" when missing. */
function pct(v: number | null | undefined): string {
  if (typeof v !== "number" || !isFinite(v)) return "n/a";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

/** {raw, fmt} number object -> plain number. */
function rawNum(v: any): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  const raw = typeof v.raw === "number" ? v.raw : null;
  if (raw !== null && isFinite(raw)) return raw;
  const fmt = parseFloat(v.fmt);
  return isFinite(fmt) ? fmt : null;
}

interface Credentials {
  cookie: string;
  crumb: string;
}

/** Cookie+crumb dance. Retries once after 5s, then throws (fail loud). */
async function getCredentials(): Promise<Credentials> {
  const attempt = async (): Promise<Credentials> => {
    // fc.yahoo.com answers 404 but always sets the A3 cookie.
    const res = await fetch("https://fc.yahoo.com", {
      redirect: "manual",
      headers: { "User-Agent": UA },
    });
    const headers = res.headers as Headers & { getSetCookie?: () => string[] };
    const setCookies =
      typeof headers.getSetCookie === "function"
        ? headers.getSetCookie()
        : [res.headers.get("set-cookie")].filter(Boolean);
    const cookie = setCookies.map(c => c.split(";")[0]).join("; ");
    if (!cookie) throw new Error("fc.yahoo.com returned no set-cookie headers");

    await pace();
    const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": UA, Cookie: cookie },
    });
    if (!crumbRes.ok) throw new Error(`getcrumb HTTP ${crumbRes.status}`);
    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb.startsWith("<")) throw new Error("getcrumb returned an empty/HTML body");
    return { cookie, crumb };
  };

  try {
    return await attempt();
  } catch (e) {
    console.warn(`Crumb dance failed (${(e as Error).message}); retrying once after 5s...`);
    await sleep(5000);
    return await attempt(); // throws -> fatal, fail loud
  }
}

async function fetchQuoteSummary(
  tick: string,
  cred: Credentials
): Promise<any | null> {
  const attempt = async (): Promise<any | null> => {
    const url =
      "https://query1.finance.yahoo.com/v10/finance/quoteSummary/" +
      tick +
      "?modules=calendarEvents,earningsHistory&crumb=" +
      encodeURIComponent(cred.crumb);
    const res = await fetch(url, {
      headers: { Cookie: cred.cookie, "User-Agent": UA },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: any = await res.json();
    return data?.quoteSummary?.result?.[0] ?? null;
  };
  try {
    return await attempt();
  } catch (e) {
    // One rate-limit/auth retry, then give up on this ticker.
    const msg = (e as Error).message;
    if (/HTTP (429|401)/.test(msg)) {
      console.warn(`quoteSummary ${tick} ${msg}; retrying once after 2s...`);
      await sleep(2000);
      try {
        return await attempt();
      } catch (e2) {
        console.error(`quoteSummary ${tick} failed: ${(e2 as Error).message}`);
        return null;
      }
    }
    console.error(`quoteSummary ${tick} failed: ${msg}`);
    return null;
  }
}

/** The most recently reported quarter from earningsHistory (defensive about
 *  ordering: Yahoo lists history oldest-first, [-4q .. -1q]). */
function latestHistoryEntry(res: any): any | null {
  const history: any[] = res?.earningsHistory?.history ?? [];
  if (!history.length) return null;
  let best: { entry: any; q: number } | null = null;
  for (const h of history) {
    const q =
      toMs(h?.quarter?.raw) ??
      parseDateStr(h?.quarter?.fmt) ??
      parseDateStr(h?.quarter?.endDateString) ??
      parseDateStr(h?.endDateString);
    const score = q ?? (h?.period === "-1q" ? Infinity : -Infinity);
    if (!best || score > best.q) best = { entry: h, q: score };
  }
  return best?.entry ?? null;
}

interface EarningsRow {
  tick: string;
  label: string;
  reportedMs: number;
  epsEst: number | null;
  epsActual: number | null;
  surprise: number | null;
  perf: PerfReport | null;
}

async function run(): Promise<void> {
  console.log("Getting Yahoo cookie + crumb...");
  const cred = await getCredentials();
  console.log("Crumb acquired.");

  const now = Date.now();
  const windowStart = now - WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const rows: EarningsRow[] = [];
  const failures: string[] = [];

  for (const item of DJIA) {
    await pace();
    const res = await fetchQuoteSummary(item.tick, cred);
    if (!res) {
      failures.push(item.tick);
      continue;
    }

    // calendarEvents.earnings.earningsDate flips to the NEXT (future) date
    // right after a report, so the most recent actual report date is taken
    // from the newest past date among earningsDate/earningsCallDate.
    const earnings = res?.calendarEvents?.earnings ?? {};
    const candidates = [earnings.earningsDate?.[0], earnings.earningsCallDate?.[0]]
      .map((v: any) => toMs(v?.raw) ?? parseDateStr(v?.fmt))
      .filter((ms: number | null): ms is number => ms !== null && ms <= now);
    if (!candidates.length) continue; // nothing reported recently -> not in window
    const reportedMs = Math.max(...candidates);
    if (reportedMs < windowStart) continue; // reported, but outside the 10-day window

    const hist = latestHistoryEntry(res);
    const epsEst = hist ? rawNum(hist.epsEstimate) : null;
    const epsActual = hist ? rawNum(hist.epsActual) : null;
    let surprise = hist ? rawNum(hist.surprisePercent) : null;
    if (surprise !== null) surprise *= 100; // Yahoo gives a fraction
    else if (epsActual !== null && epsEst !== null && epsEst !== 0) {
      surprise = ((epsActual - epsEst) / Math.abs(epsEst)) * 100;
    }

    const quarterMs = hist ? (toMs(hist?.quarter?.raw) ?? parseDateStr(hist?.quarter?.fmt)) : null;
    console.log(
      `${item.tick} reported ${fmtDate(reportedMs)}` +
        (quarterMs ? ` (quarter ended ${fmtDate(quarterMs)})` : "") +
        `, EPS ${epsEst !== null ? epsEst.toFixed(2) : "n/a"} est vs ` +
        `${epsActual !== null ? epsActual.toFixed(2) : "n/a"} actual`
    );

    rows.push({
      tick: item.tick,
      label: item.name ? `${item.tick} (${item.name})` : item.tick,
      reportedMs,
      epsEst,
      epsActual,
      surprise,
      perf: null, // fetched after filtering, so we only pay for included rows
    });
  }

  if (failures.length === DJIA.length) {
    throw new Error(
      "Every quoteSummary request failed (cookie/crumb or rate limiting); " +
        "cannot determine which DJIA components reported. Failing loud instead of publishing an empty report."
    );
  }

  // 1-week post-earnings performance, only for tickers that made the cut.
  for (const row of rows) {
    await pace();
    row.perf = await getPerformanceWindows(row.tick);
  }

  // Most recent reports first.
  rows.sort((a, b) => b.reportedMs - a.reportedMs);

  const windowNote = `${fmtDate(windowStart)} to ${fmtDate(now)}`;
  const intro =
    rows.length > 0
      ? `${rows.length} of the ${DJIA.length} Dow components in the watchlist reported quarterly results in the last 10 days (${windowNote}). ` +
        `The table shows the latest reported quarter's EPS estimate vs actual, the surprise, and the stock's 1-week performance against SPY. ` +
        `This is event-driven earnings data, not general market context.`
      : `No DJIA component in the watchlist reported quarterly earnings within the last 10 days (${windowNote}), ` +
        `so there are no earnings surprises to show this run. ` +
        `This is event-driven earnings data, not general market context.`;

  const tableRows = rows.map(r => [
    r.label,
    fmtDate(r.reportedMs),
    r.epsEst !== null ? r.epsEst.toFixed(2) : "n/a",
    r.epsActual !== null ? r.epsActual.toFixed(2) : "n/a",
    pct(r.surprise),
    pct(r.perf?.windows["1w"]?.changePercent),
    pct(r.perf?.excess["1w"]),
  ]);

  writeIndicatorPost({
    slug: "earnings",
    title: "DJIA Earnings Surprises",
    tag: "earnings",
    intro,
    table: {
      columns: ["Ticker", "Reported", "EPS Est", "EPS Actual", "Surprise", "1w", "1w vs SPY"],
      rows: tableRows,
    },
    dataSource: { name: "Yahoo Finance", url: "https://finance.yahoo.com/" },
    footnote:
      "*Surprise is EPS actual vs estimate in percent. '1w' is the 1-week price change since the report; " +
      "'1w vs SPY' is that return minus SPY's over the same window, in points." +
      (failures.length
        ? ` Data could not be fetched for ${failures.length} ticker(s) this run: ${failures.join(", ")}.*`
        : "*"),
  });

  if (failures.length) {
    console.warn(`Warning: ${failures.length} tickers failed to fetch (${failures.join(", ")})`);
  }
  console.log(`Earnings report done: ${rows.length} row(s) in window, ${failures.length} failures.`);
}

run().catch(err => {
  console.error("earnings.ts failed:", err);
  process.exit(1);
});