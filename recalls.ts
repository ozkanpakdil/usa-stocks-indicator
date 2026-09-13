import { searchTicker } from "./utils";
import { writeIndicatorPost } from "./hugohelpers";

// CPSC SaferProducts REST API.
// Verified shape (probed): a plain JSON array; each item has RecallDate (ISO
// datetime), Title, URL, Hazards[].Name, and company arrays
// Manufacturers / Importers / Distributors / Retailers, each [{Name, CompanyID}].
// Note: there is no "Companies" field, despite the task brief's guess.

const WINDOW_DAYS = 7;
const TICKER_PACING_MS = 500;
const HAZARD_MAX_CHARS = 160;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function isoDate(d: Date): string {
  return d.toISOString().split("T")[0];
}

/** Company of record: first manufacturer, else importer, distributor, retailer. */
function firstCompany(item: any): string {
  const groups = ["Manufacturers", "Importers", "Distributors", "Retailers"];
  for (const g of groups) {
    const arr = item[g];
    if (!Array.isArray(arr)) continue;
    // Skip "Sold At: ..." / "Sold Online At: ..." pseudo-entries that CPSC
    // sometimes puts in Retailers; they are sales channels, not companies.
    const entry = arr.find((c: any) => c?.Name && !/^Sold\b/i.test(String(c.Name)));
    if (entry) return String(entry.Name).trim();
  }
  return "";
}

/** Drop the "..., of Hacienda Heights, California" tail before ticker lookup. */
function lookupName(raw: string): string {
  return raw.split(/,\s*of\s+/i)[0].trim();
}

function truncate(text: string, max: number): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(" "))}...`;
}

async function run() {
  const end = isoDate(new Date());
  const start = isoDate(new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000));

  const url = `https://www.saferproducts.gov/RestWebServices/Recall?format=json&recallDateStart=${start}`;
  console.log(`Fetching CPSC recalls from ${start} to ${end}...`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CPSC SaferProducts API HTTP ${res.status}`);
  const items = await res.json();
  if (!Array.isArray(items)) throw new Error("Unexpected CPSC response: expected a JSON array");
  console.log(`Fetched ${items.length} recalls.`);

  const records = items
    .map((item: any) => {
      // Some CPSC records store the recall URL in Title; the product name
      // is the better display cell in that case.
      const title = String(item.Title ?? "").trim();
      const product = String(item.Products?.[0]?.Name ?? "").trim();
      const displayTitle = /^https?:\/\//i.test(title) ? (product || title) : title;
      return {
        sortKey: String(item.RecallDate ?? ""),
        date: String(item.RecallDate ?? "").split("T")[0] || "",
        title: displayTitle,
        company: firstCompany(item),
        hazard: truncate(item.Hazards?.[0]?.Name ?? "", HAZARD_MAX_CHARS),
      };
    })
    .filter(r => r.date && r.title);

  // Newest first.
  records.sort((a, b) => b.sortKey.localeCompare(a.sortKey));

  // Ticker lookup: unique companies only, paced, cached.
  const tickerCell = new Map<string, string>();
  for (const r of records) {
    const key = r.company;
    if (!key || tickerCell.has(key)) continue;
    await sleep(TICKER_PACING_MS);
    console.log(`Ticker lookup: ${key}...`);
    const info = await searchTicker(key);
    tickerCell.set(key, info ? `[${info.symbol}](https://seekingalpha.com/symbol/${info.symbol})` : "n/a");
    if (info) console.log(`  -> ${info.symbol}`);
  }

  const rows = records.map(r => [
    r.date,
    r.title,
    r.company || "n/a",
    r.hazard,
    r.company ? (tickerCell.get(r.company) ?? "n/a") : "n/a",
  ]);

  const withTicker = rows.filter(r => r[4] !== "n/a").length;
  const intro = rows.length
    ? `Consumer product recalls published by the CPSC between ${start} and ${end}, newest first. Company is the first manufacturer, importer, distributor or retailer named in the recall notice; tickers link to Seeking Alpha.`
    : `No consumer product recalls were published by the CPSC in the ${start} to ${end} window.`;

  writeIndicatorPost({
    slug: "recalls",
    title: "Consumer Product Recalls",
    tag: "recalls",
    intro,
    table: {
      columns: ["Date", "Product", "Company", "Hazard", "Ticker"],
      rows,
    },
    dataSource: { name: "CPSC SaferProducts", url: "https://www.saferproducts.gov/" },
    footnote: `*Recall notices in this window: ${records.length}; hazard text excerpted. Tickers matched via Yahoo Finance (${withTicker} identified).*\n`,
  });

  console.log(`recalls: ${rows.length} rows, ${withTicker} with ticker.`);
}

run().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});