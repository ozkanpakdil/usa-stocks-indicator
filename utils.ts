export function cleanCompanyName(name: string): string {
  if (!name) return "";
  let cleaned = name.toUpperCase();
  
  // Remove common suffixes
  const suffixes = [
    ", INC.", ", INC", " INC.", " INC",
    ", LLC.", ", LLC", " LLC.", " LLC",
    ", L.L.C.", " L.L.C.", " L.L.C", " LLP", " LP",
    ", LTD.", ", LTD", " LTD.", " LTD", " LIMITED",
    ", GMBH", " GMBH", " AG", " B.V.", " BV", " PVT.", " PVT",
    ", CORP.", ", CORP", " CORP.", " CORP",
    ", CORPORATION", " CORPORATION",
    ", CO.", ", CO", " CO.", " CO",
    ", COMPANY", " COMPANY",
    " P.C.", " PC",
    " L.P."
  ];

  for (const suffix of suffixes) {
    if (cleaned.endsWith(suffix)) {
      cleaned = cleaned.slice(0, -suffix.length);
    }
  }

  // Remove common symbols and extra spaces
  cleaned = cleaned.replace(/[^A-Z0-9 ]/g, " ");
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  return cleaned;
}

export async function searchTicker(companyName: string) {
  let cleanedName = cleanCompanyName(companyName);
  
  // Universities and government entities are not stocks
  const blacklist = ["UNIVERSITY", "INSTITUTE OF TECHNOLOGY", "DEPARTMENT OF", "STATE OF", "CITY OF", "REGENTS OF"];
  for (const item of blacklist) {
    if (cleanedName.includes(item)) return null;
  }

  const trySearch = async (query: string) => {
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}`;
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      const data = await response.json();
      const quotes = data.quotes || [];
      // Strictly filter for US Equities to avoid indices and private companies.
      // NYQ/NYS = NYSE, NMS/NAS = Nasdaq, ASE/PCX/NGM/NGS = NYSE American tiers.
      const usQuotes = quotes.filter((q: any) => 
        ["NYQ", "NMS", "NAS", "NYS", "ASE", "PCX", "NGM", "NGS"].includes(q.exchange) &&
        q.quoteType === "EQUITY"
      );
      if (!usQuotes.length) return null;

      // Guard against fuzzy matches on an UNRELATED company (e.g. Yahoo
      // returns Sunoco (SUN) for over-trimmed "Sun Pharmaceutical"). Accept a
      // quote only if a significant query word appears in its company name,
      // or the symbol prefix-matches a >=4-letter query word (GOOGLE -> GOOG).
      const tokens = query.toUpperCase().replace(/['`]/g, "").split(/[^A-Z0-9]+/).filter(Boolean);
      const eq = (a: string, b: string) =>
        a === b ||
        (a.endsWith("S") && a.slice(0, -1) === b) ||
        (b.endsWith("S") && b.slice(0, -1) === a);
      const nameOf = (q: any) =>
        String(q.shortname ?? q.longname ?? q.name ?? "").toUpperCase().replace(/['`]/g, "");

      for (const q of usQuotes) {
        const nameTokens = nameOf(q).split(/[^A-Z0-9]+/).filter(Boolean);
        const symbol = String(q.symbol ?? "").toUpperCase();
        if (tokens.some(t => t.length >= 3 && nameTokens.some(nt => eq(t, nt)))) return q;
        if (tokens.some(t => t.length >= 4 && (symbol.startsWith(t) || t.startsWith(symbol)))) return q;
      }

      // Short/ambiguous queries with no significant word ("AT&T", "3M",
      // "HP"): accept only an exact company-name prefix match.
      if (!tokens.some(t => t.length >= 3)) {
        const qStr = query.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
        const hit = usQuotes.find((q: any) =>
          nameOf(q).replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim().startsWith(qStr)
        );
        return hit || null;
      }
      return null;
    } catch (e) {
      return null;
    }
  };

  // Try original cleaned name
  let result = await trySearch(cleanedName);
  if (result) return result;

  // If not found and has multiple words, try removing the last word if it looks like a generic descriptor
  const generics = ["SYSTEMS", "SERVICES", "SOLUTIONS", "TECHNOLOGIES", "FEDERAL", "INTERNATIONAL", "NORTH", "AMERICA", "GROUP", "HOLDINGS", "CORPORATION", "COMPANY", "INC", "LLC",
    // pharma/legal descriptors common in FDA applicant names
    "PHARMACEUTICALS", "PHARMACEUTICAL", "PHARMA", "LABORATORIES", "LABORATORY", "LABS", "HEALTHCARE", "SCIENCES", "BIOSCIENCES", "THERAPEUTICS", "INDUSTRIES", "COMPANIES", "USA", "LP", "LTD", "GMBH", "AG", "BV", "PVT"];
  let words = cleanedName.split(" ");
  
  while (words.length > 1) {
    const lastWord = words[words.length - 1];
    if (generics.includes(lastWord) || words.length > 2) {
      words.pop();
      // Pace the retry: every trimmed attempt is another Yahoo request.
      await new Promise(res => setTimeout(res, 200));
      const nextQuery = words.join(" ");
      result = await trySearch(nextQuery);
      if (result) return result;
    } else {
      break;
    }
  }

  return null;
}

export async function getStockPerformance(ticker: string): Promise<{ changePercent: number, startPrice: number, endPrice: number } | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1mo&interval=1d`;
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (!response.ok) return null;
    const data = await response.json();
    const prices = data.chart.result[0].indicators.adjclose[0].adjclose;
    if (!prices || prices.length < 2) return null;

    const startPrice = prices[0];
    const endPrice = prices[prices.length - 1];
    if (startPrice === null || endPrice === null) return null;

    const changePercent = ((endPrice - startPrice) / startPrice) * 100;
    return { changePercent, startPrice, endPrice };
  } catch (e) {
    console.error(`Error fetching performance for ${ticker}:`, e);
    return null;
  }
}

// ---------- multi-window performance with SPY benchmark ----------

export type WindowKey = "1w" | "1m" | "3m";

export interface PerfWindow {
  changePercent: number;
  startPrice: number;
  endPrice: number;
}

export interface PerfReport {
  windows: Partial<Record<WindowKey, PerfWindow>>;
  /** performance minus SPY performance over the same window, in points */
  excess: Partial<Record<WindowKey, number>>;
}

const WINDOW_DAYS: Record<WindowKey, number> = { "1w": 7, "1m": 31, "3m": 92 };
const WINDOWS: WindowKey[] = ["1w", "1m", "3m"];

interface ChartBar { date: string; close: number; }

export async function fetchDailyCloses(ticker: string): Promise<ChartBar[]> {
  // 2y so the breadth dashboard can compute a 200-day SMA;
  // window lookups only use the tail, so this is safe for them too.
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=2y&interval=1d`;
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`chart ${ticker} HTTP ${response.status}`);
  const data = await response.json();
  const result = data?.chart?.result?.[0];
  const timestamps: number[] = result?.timestamp ?? [];
  const closes: (number | null)[] = result?.indicators?.adjclose?.[0]?.adjclose ?? [];
  const bars: ChartBar[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (close === null || close === undefined) continue;
    bars.push({ date: new Date(timestamps[i] * 1000).toISOString().split("T")[0], close });
  }
  return bars;
}

function windowChange(bars: ChartBar[], days: number): PerfWindow | undefined {
  if (bars.length < 2) return undefined;
  const endBar = bars[bars.length - 1];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().split("T")[0];
  const startBar = bars.find(b => b.date >= cutoffStr) ?? bars[0];
  if (startBar.close === 0) return undefined;
  return {
    changePercent: ((endBar.close - startBar.close) / startBar.close) * 100,
    startPrice: startBar.close,
    endPrice: endBar.close,
  };
}

// One SPY fetch per process, shared by every lookup in the run.
let spyBarsPromise: Promise<ChartBar[]> | null = null;
function getSpyBars(): Promise<ChartBar[]> {
  if (!spyBarsPromise) {
    spyBarsPromise = fetchDailyCloses("SPY").catch(e => {
      spyBarsPromise = null;
      throw e;
    });
  }
  return spyBarsPromise;
}

/**
 * 1w / 1m / 3m performance for a ticker, plus excess return vs SPY
 * over the same windows. Returns null when the ticker has no chart.
 */
export async function getPerformanceWindows(ticker: string): Promise<PerfReport | null> {
  try {
    const bars = await fetchDailyCloses(ticker);
    const windows: PerfReport["windows"] = {};
    const excess: PerfReport["excess"] = {};
    let spyBars: ChartBar[] = [];
    try {
      spyBars = await getSpyBars();
    } catch {
      console.error("SPY benchmark fetch failed; excess returns omitted");
    }
    for (const w of WINDOWS) {
      const perf = windowChange(bars, WINDOW_DAYS[w]);
      if (!perf) continue;
      windows[w] = perf;
      const spyPerf = windowChange(spyBars, WINDOW_DAYS[w]);
      if (spyPerf) excess[w] = perf.changePercent - spyPerf.changePercent;
    }
    if (!Object.keys(windows).length) return null;
    return { windows, excess };
  } catch (e) {
    console.error(`Error fetching performance windows for ${ticker}:`, e);
    return null;
  }
}
