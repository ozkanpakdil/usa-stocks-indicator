import { searchTicker, getStockPerformance } from "./utils";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { chromium } from "playwright";

const DATA_FILE = "layoffs.json";
const SCRAPED_FILE = "layoffs_scraped.json";

interface LayoffRecord {
  company: string;
  laidOff: number;
  date: string;
  industry: string;
  ticker?: string;
  exchange?: string;
  performance?: {
    changePercent: number;
    startPrice: number;
    endPrice: number;
  };
}

async function scrapeLayoffs() {
  console.log("Starting scraper for layoffs.fyi...");
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();
  
  try {
    console.log("Navigating to layoffs.fyi...");
    await page.goto("https://layoffs.fyi/", { waitUntil: "domcontentloaded", timeout: 60000 });
    
    const frame = page.frames().find(f => f.url().includes("airtable.com"));
    if (!frame) {
      throw new Error("Airtable frame not found");
    }
    
    console.log("Airtable frame found. Waiting for data to load...");
    await frame.waitForSelector(".dataRow", { timeout: 30000 });
    
    // Scroll to top
    await frame.evaluate(() => {
      const scrollable = document.querySelector(".antiscroll-inner");
      if (scrollable) scrollable.scrollTop = 0;
    });
    await new Promise(r => setTimeout(r, 2000));
    
    const headers = await frame.evaluate(() => {
      const headerEls = Array.from(document.querySelectorAll(".gridHeaderCellPhosphorIcons"));
      return headerEls.map(h => ({
        text: h.innerText.trim(),
        left: Math.round(h.getBoundingClientRect().left)
      }));
    });
    
    const allData = new Map<string, any>();
    let lastCount = -1;
    let sameCountTries = 0;
    
    // Limit to 1000 records to cover the last year
    while (sameCountTries < 5 && allData.size < 1000) {
      const newRows = await frame.evaluate((headers) => {
        const results: any[] = [];
        const divs = Array.from(document.querySelectorAll("div"));
        const rowsByTop: Record<number, any[]> = {};
        
        divs.forEach(div => {
          if (!div.innerText || div.innerText.length > 500) return;
          const rect = div.getBoundingClientRect();
          if (rect.top < 60) return;
          const top = Math.round(rect.top);
          if (!rowsByTop[top]) rowsByTop[top] = [];
          rowsByTop[top].push({ text: div.innerText, left: Math.round(rect.left) });
        });
        
        for (const top of Object.keys(rowsByTop)) {
          const cells = rowsByTop[Number(top)];
          const rowData: Record<string, string> = {};
          let foundAny = false;
          cells.forEach(cell => {
            const header = headers.find(h => Math.abs(h.left - cell.left) < 5);
            if (header && cell.text) {
              rowData[header.text] = cell.text.trim();
              foundAny = true;
            }
          });
          if (foundAny && rowData["Company"] && rowData["Date"] !== "Summary") {
            results.push(rowData);
          }
        }
        return results;
      }, headers);
      
      for (const row of newRows) {
        const id = `${row["Company"]}-${row["Date"]}`;
        allData.set(id, row);
      }
      
      if (allData.size === lastCount) {
        sameCountTries++;
      } else {
        sameCountTries = 0;
      }
      lastCount = allData.size;
      console.log(`Collected ${allData.size} records...`);
      
      await frame.evaluate(() => {
        const scrollable = document.querySelector(".antiscroll-inner");
        if (scrollable) scrollable.scrollTop += 600;
      });
      await new Promise(r => setTimeout(r, 1000));
    }
    
    const finalData = Array.from(allData.values());
    writeFileSync(SCRAPED_FILE, JSON.stringify(finalData, null, 2));
    console.log(`Scraping finished. Saved ${finalData.length} records to ${SCRAPED_FILE}`);
  } finally {
    await browser.close();
  }
}

async function run() {
  // Always scrape fresh data if we're running this
  await scrapeLayoffs().catch(err => {
    console.error("Scraping failed, will try to use existing scraped file if available:", err.message);
  });

  console.log("Processing layoffs data...");
  if (!existsSync(SCRAPED_FILE)) {
    console.error("Scraped file not found. Please run the scraper first.");
    return;
  }

  const scrapedData = JSON.parse(readFileSync(SCRAPED_FILE, "utf-8"));

  let existingData: Record<string, LayoffRecord> = {};
  if (existsSync(DATA_FILE)) {
    existingData = JSON.parse(readFileSync(DATA_FILE, "utf-8"));
  }

  const newRecords: LayoffRecord[] = [];

  for (const item of scrapedData) {
    const company = item["Company"];
    const laidOff = parseInt(item["# Laid Off"]?.replace(/,/g, "")) || 0;
    const rawDate = item["Date"]; // M/D/YYYY
    const industry = item["Industry"];

    if (!company || !rawDate || rawDate === "Summary") continue;

    // Improved date parsing
    const parts = rawDate.split("/");
    let date = rawDate;
    if (parts.length === 3) {
      const p1 = parseInt(parts[0]);
      const p2 = parseInt(parts[1]);
      const year = parseInt(parts[2]);
      
      if (p1 > 12) {
        // D/M/YYYY
        date = `${year}-${parts[1].padStart(2, "0")}-${parts[0].padStart(2, "0")}`;
      } else if (p2 > 12) {
        // M/D/YYYY
        date = `${year}-${parts[0].padStart(2, "0")}-${parts[1].padStart(2, "0")}`;
      } else {
        // Ambiguous (both <= 12). Check for future dates.
        const dateMDY = new Date(year, p1 - 1, p2);
        const dateDMY = new Date(year, p2 - 1, p1);
        const now = new Date();
        
        if (dateMDY > now && dateDMY <= now) {
          // M/D/YYYY is in the future, D/M/YYYY is not. Likely D/M/YYYY.
          date = `${year}-${parts[1].padStart(2, "0")}-${parts[0].padStart(2, "0")}`;
        } else {
          // Default to M/D/YYYY or whatever was more likely. 
          // Given Airtable often defaults to M/D/YYYY in US.
          date = `${year}-${parts[0].padStart(2, "0")}-${parts[1].padStart(2, "0")}`;
        }
      }
    }

    const layoffDate = new Date(date);
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    if (layoffDate < oneYearAgo) continue;

    const id = `${company}-${date}`;
    if (existingData[id]) {
      newRecords.push(existingData[id]);
      continue;
    }

    console.log(`Checking ticker for ${company}...`);
    let tickerInfo = await searchTicker(company);
    
    // Try without .com if failed
    if (!tickerInfo && company.endsWith(".com")) {
      const searchName = company.slice(0, -4);
      console.log(`Retrying search for ${searchName}...`);
      tickerInfo = await searchTicker(searchName);
    }

    if (tickerInfo) {
      console.log(`Found ticker ${tickerInfo.symbol} for ${company}`);
      const performance = await getStockPerformance(tickerInfo.symbol);
      
      const record: LayoffRecord = {
        company,
        laidOff,
        date,
        industry,
        ticker: tickerInfo.symbol,
        exchange: tickerInfo.exchange,
        performance: performance || undefined
      };
      
      existingData[id] = record;
      newRecords.push(record);
      await new Promise(r => setTimeout(r, 500));
    }
  }

  writeFileSync(DATA_FILE, JSON.stringify(existingData, null, 2));
  generateHugoPost(Object.values(existingData));
}


function generateHugoPost(records: LayoffRecord[]) {
  console.log("Generating Layoffs Hugo post...");
  const dateStr = new Date().toISOString().split("T")[0];
  const filename = `content/posts/layoffs-${dateStr}.md`;

  const sorted = records
    .filter(r => r.ticker)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  let table = "| Date | Company | Laid Off | Industry | Stock | 1-Month Perf |\n|------|---------|----------|----------|-------|--------------|\n";
  
  // Limit to top 100 for post
  sorted.slice(0, 100).forEach(r => {
    const perfStr = r.performance 
      ? `${r.performance.changePercent > 0 ? "+" : ""}${r.performance.changePercent.toFixed(2)}%`
      : "N/A";
    const perfColor = r.performance 
      ? (r.performance.changePercent > 0 ? "green" : "red") 
      : "inherit";
    
    const tickerLink = `[${r.ticker} (${r.exchange})](https://seekingalpha.com/symbol/${r.ticker})`;
    const laidOffStr = r.laidOff > 0 ? r.laidOff.toLocaleString() : "Unknown";

    table += `| ${r.date} | ${r.company} | ${laidOffStr} | ${r.industry} | ${tickerLink} | <span style="color: ${perfColor}">${perfStr}</span> |\n`;
  });

  const content = `---
title: "Recent Tech Layoffs Stock Report - ${dateStr}"
date: ${new Date().toISOString()}
draft: false
tags: ["stocks", "layoffs", "tech"]
---

### Recent Tech Layoffs and Stock Performance

This report covers publicly traded companies that have announced layoffs in the last year.

${table}

---
*Data source: [Layoffs.fyi](https://layoffs.fyi/)*
`;

  writeFileSync(filename, content);
  console.log(`Layoffs post generated: ${filename}`);
}

run().catch(console.error);
