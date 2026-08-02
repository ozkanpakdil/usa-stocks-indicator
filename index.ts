import { searchTicker } from "./utils";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";

const DATA_FILE = "data.json";
const USASPENDING_URL = "https://api.usaspending.gov/api/v2/search/spending_by_award/";

// Calculate last 12 months
const now = new Date();
const lastYear = new Date();
lastYear.setFullYear(now.getFullYear() - 1);

const formatDate = (date: Date) => date.toISOString().split("T")[0];

const START_DATE = formatDate(lastYear);
const END_DATE = formatDate(now);

const COMMON_FILTERS = {
  "time_period": [
    {
      "start_date": START_DATE,
      "end_date": END_DATE
    }
  ],
  "award_type_codes": ["A", "B", "C", "D"] // Contracts
};

interface Award {
  id: string;
  type: "Prime" | "Subaward";
  recipient: string;
  date: string;
  amount: number;
  agency: string;
  subAgency: string;
  ticker?: string;
  exchange?: string;
}

async function run() {
  console.log(`Fetching awards from ${START_DATE} to ${END_DATE}...`);
  
  let existingData: Record<string, Award> = {};
  if (existsSync(DATA_FILE)) {
    const rawData = JSON.parse(readFileSync(DATA_FILE, "utf-8"));
    // Filter out records older than last year and private companies if user wants only stocks
    for (const key in rawData) {
      const award = rawData[key];
      if (award.date >= START_DATE && award.ticker) {
        // Migration: add type if missing (old records were all subawards)
        if (!award.type) award.type = "Subaward";
        existingData[key] = award;
      }
    }
  }

  // 1. Fetch Subawards
  console.log("Fetching subawards...");
  for (let page = 1; page <= 5; page++) {
    console.log(`  Page ${page}...`);
    const subPayload = {
      filters: COMMON_FILTERS,
      fields: [
        "Sub-Award ID", "Sub-Awardee Name", "Sub-Award Date", "Sub-Award Amount",
        "Awarding Agency", "Awarding Sub Agency"
      ],
      page, limit: 100, sort: "Sub-Award Date", order: "desc", subawards: true
    };
    const count = await processAwards(subPayload, "Subaward", existingData);
    writeFileSync(DATA_FILE, JSON.stringify(existingData, null, 2));
    if (count === 0) break;
  }

  // 2. Fetch Prime Awards
  console.log("Fetching prime awards...");
  for (let page = 1; page <= 5; page++) {
    console.log(`  Page ${page}...`);
    const primePayload = {
      filters: COMMON_FILTERS,
      fields: [
        "Award ID", "Recipient Name", "Base Obligation Date", "Award Amount",
        "Awarding Agency", "Awarding Sub Agency"
      ],
      page, limit: 100, sort: "Base Obligation Date", order: "desc", subawards: false
    };
    const count = await processAwards(primePayload, "Prime", existingData);
    writeFileSync(DATA_FILE, JSON.stringify(existingData, null, 2));
    if (count === 0) break;
  }

  writeFileSync(DATA_FILE, JSON.stringify(existingData, null, 2));
  console.log(`Saved ${Object.keys(existingData).length} total awards with stock info.`);

  generateHugoPost(existingData);
}

async function processAwards(payload: any, type: "Prime" | "Subaward", existingData: Record<string, Award>): Promise<number> {
  try {
    const response = await fetch(USASPENDING_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error(`Failed to fetch ${type} data`, await response.text());
      return 0;
    }

    const data = await response.json();
    const results = data.results || [];
    let processedCount = 0;

    for (const item of results) {
      const id = type === "Subaward" ? item["Sub-Award ID"] : item["Award ID"];
      if (existingData[id]) continue;

      const recipient = type === "Subaward" ? item["Sub-Awardee Name"] : item["Recipient Name"];
      const date = type === "Subaward" ? item["Sub-Award Date"] : item["Base Obligation Date"];
      const amount = type === "Subaward" ? item["Sub-Award Amount"] : item["Award Amount"];
      
      // We only care about public companies
      const tickerInfo = await searchTicker(recipient);
      if (!tickerInfo) {
        // console.log(`Skipping private company: ${recipient}`);
        continue;
      }

      console.log(`New ${type} award for ${recipient} (${tickerInfo.symbol})`);
      
      existingData[id] = {
        id,
        type,
        recipient,
        date,
        amount,
        agency: item["Awarding Agency"],
        subAgency: item["Awarding Sub Agency"],
        ticker: tickerInfo.symbol,
        exchange: tickerInfo.exchange,
      };
      
      processedCount++;
      await new Promise(r => setTimeout(r, 500));
    }
    return results.length;
  } catch (e) {
    console.error(`Error processing ${type} awards:`, e);
    return 0;
  }
}

function generateHugoPost(data: Record<string, Award>) {
  console.log("Generating Hugo post...");
  const dateStr = formatDate(new Date());
  const filename = `content/posts/awards-${dateStr}.md`;

  // Create content directory if it doesn't exist
  if (!existsSync("content/posts")) {
    mkdirSync("content/posts", { recursive: true });
  }

  const awards = Object.values(data).sort((a, b) => {
    const dateCompare = b.date.localeCompare(a.date);
    if (dateCompare !== 0) return dateCompare;
    return b.amount - a.amount;
  });
  
  let content = `---
title: "USA Government Awards Stock Report - ${dateStr}"
date: ${new Date().toISOString()}
draft: false
tags: ["stocks", "government", "awards"]
---

### Top Public Companies by Award Amount (Last 12 Months)

This report shows publicly traded companies that have received government contracts or subawards in the last year.

| Date | Type | Recipient | Amount | Agency | Stock |
|------|------|-----------|--------|--------|-------|
`;

  // Limit to top 200 for the blog post
  awards.slice(0, 200).forEach(a => {
    const amountStr = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(a.amount);
    const typeBadge = `<span class="type-badge ${a.type.toLowerCase()}">${a.type}</span>`;
    const tickerLink = `[${a.ticker} (${a.exchange})](https://seekingalpha.com/symbol/${a.ticker})`;
    content += `| ${a.date} | ${typeBadge} | ${a.recipient} | ${amountStr} | ${a.agency}<br><small>${a.subAgency}</small> | ${tickerLink} |\n`;
  });

  content += `
---
*Data source: [USASpending.gov](https://www.usaspending.gov/)*
`;

  writeFileSync(filename, content);
  console.log(`Hugo post generated: ${filename}`);
}

run().catch(console.error);
