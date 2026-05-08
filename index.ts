import { searchTicker } from "./utils";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";

const DATA_FILE = "data.json";
const REPORT_FILE = "static/report.html";
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

  generateReport(existingData);
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

function generateReport(data: Record<string, Award>) {
  console.log("Generating report...");
  
  // Ensure static directory exists
  if (!existsSync("static")) {
    mkdirSync("static", { recursive: true });
  }

  const awards = Object.values(data).sort((a, b) => {
    const dateCompare = b.date.localeCompare(a.date);
    if (dateCompare !== 0) return dateCompare;
    return b.amount - a.amount;
  });
  
  const rows = awards.map(a => {
    const tickerLink = `<a href="https://seekingalpha.com/symbol/${a.ticker}" target="_blank" class="ticker">${a.ticker} (${a.exchange})</a>`;
    const amountStr = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(a.amount);

    return `
      <tr>
        <td class="nowrap">${a.date}</td>
        <td class="nowrap"><span class="type-badge ${a.type.toLowerCase()}">${a.type}</span></td>
        <td>${a.recipient}</td>
        <td class="nowrap">${amountStr}</td>
        <td>${a.agency}<br><small>${a.subAgency}</small></td>
        <td class="nowrap">${tickerLink}</td>
      </tr>
    `;
  }).join("");

  const html = `
<!DOCTYPE html>
<html>
<head>
    <title>USA Government Awards Stock Indicator</title>
    <style>
        :root {
            --bg-color: #f0f2f5;
            --container-bg: white;
            --text-primary: #333;
            --text-secondary: #666;
            --accent-color: #004a99;
            --border-color: #eee;
            --table-header-bg: #f8f9fa;
            --table-hover-bg: #f1f8ff;
            --ticker-bg: #ffebee;
            --ticker-text: #d32f2f;
            --prime-bg: #e3f2fd;
            --prime-text: #1976d2;
            --sub-bg: #f3e5f5;
            --sub-text: #7b1e89;
        }

        @media (prefers-color-scheme: dark) {
            :root {
                --bg-color: #1a1c1e;
                --container-bg: #242628;
                --text-primary: #e1e3e6;
                --text-secondary: #a1a3a6;
                --accent-color: #4da3ff;
                --border-color: #3e4042;
                --table-header-bg: #2d2f31;
                --table-hover-bg: #2d353f;
                --ticker-bg: #442222;
                --ticker-text: #ffaaaa;
                --prime-bg: #1565c0;
                --prime-text: #e3f2fd;
                --sub-bg: #6a1b9a;
                --sub-text: #f3e5f5;
            }
        }

        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 20px; background-color: var(--bg-color); color: var(--text-primary); }
        .container { max-width: 98%; margin: auto; background: var(--container-bg); padding: 20px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); overflow-x: auto; }
        h1 { color: var(--accent-color); border-bottom: 2px solid var(--accent-color); padding-bottom: 10px; font-size: 1.5rem; }
        .meta { color: var(--text-secondary); margin-bottom: 10px; font-style: italic; font-size: 0.85rem; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 0.85rem; }
        th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border-color); }
        th { background-color: var(--table-header-bg); color: var(--accent-color); font-weight: 600; text-transform: uppercase; font-size: 0.75rem; cursor: pointer; position: relative; }
        th:hover { background-color: var(--table-hover-bg); }
        th::after { content: '↕'; position: absolute; right: 8px; color: var(--text-secondary); }
        .sort-asc::after { content: '↑'; color: var(--text-primary); }
        .sort-desc::after { content: '↓'; color: var(--text-primary); }
        tr:hover { background-color: var(--table-hover-bg); }
        .ticker { font-weight: bold; color: var(--ticker-text); background: var(--ticker-bg); padding: 2px 6px; border-radius: 4px; font-size: 0.8rem; }
        .type-badge { padding: 2px 6px; border-radius: 10px; font-size: 0.7rem; font-weight: bold; text-transform: uppercase; }
        .prime { background-color: var(--prime-bg); color: var(--prime-text); }
        .subaward { background-color: var(--sub-bg); color: var(--sub-text); }
        .nowrap { white-space: nowrap; }
        a { text-decoration: none; color: var(--accent-color); }
        a:hover { text-decoration: underline; }
        small { color: var(--text-secondary); font-size: 0.75rem; }
    </style>
</head>
<body>
    <div class="container">
        <h1>USA Government Awards Stock Indicator</h1>
        <p class="meta">Showing public companies awarded contracts in the last 12 months (since ${START_DATE}).</p>
        <p class="meta">Last updated: ${new Date().toLocaleString()}</p>
        <table>
            <thead>
                <tr>
                    <th class="nowrap">Date</th>
                    <th class="nowrap">Type</th>
                    <th>Recipient</th>
                    <th>Amount</th>
                    <th>Agency</th>
                    <th class="nowrap">Stock (Seeking Alpha)</th>
                </tr>
            </thead>
            <tbody>
                ${rows}
            </tbody>
        </table>
    </div>
    <script>
        document.addEventListener('DOMContentLoaded', function() {
            const getCellValue = (tr, idx) => tr.children[idx].innerText || tr.children[idx].textContent;
            const parseValue = (val) => {
                const cleaned = val.replace(/[$,]/g, '');
                const num = parseFloat(cleaned);
                return isNaN(num) ? val.toLowerCase() : num;
            };
            const comparer = (idx, asc) => (a, b) => ((v1, v2) => 
                v1 !== '' && v2 !== '' && !isNaN(parseValue(v1)) && !isNaN(parseValue(v2)) 
                ? parseValue(v1) - parseValue(v2) 
                : v1.toString().localeCompare(v2)
            )(getCellValue(asc ? a : b, idx), getCellValue(asc ? b : a, idx));

            document.querySelectorAll('th').forEach(th => th.addEventListener('click', (() => {
                const table = th.closest('table');
                const tbody = table.querySelector('tbody');
                const rows = Array.from(tbody.querySelectorAll('tr'));
                const index = Array.from(th.parentNode.children).indexOf(th);
                const ascending = th.dataset.asc = th.dataset.asc !== 'true';
                
                rows.sort(comparer(index, ascending)).forEach(tr => tbody.appendChild(tr));
                
                // Update icons
                th.parentNode.querySelectorAll('th').forEach(h => h.classList.remove('sort-asc', 'sort-desc'));
                th.classList.add(ascending ? 'sort-asc' : 'sort-desc');
            })));
        });
    </script>
</body>
</html>
  `;

  writeFileSync(REPORT_FILE, html);
  console.log(`Report generated: ${REPORT_FILE}`);
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

  writeFileSync(filename, content);
  console.log(`Hugo post generated: ${filename}`);
}

run().catch(console.error);
