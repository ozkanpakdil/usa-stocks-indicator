import { writeFileSync, existsSync, mkdirSync } from "fs";

export interface PostTable {
  columns: string[];
  rows: string[][];
}

export interface IndicatorPost {
  /** post slug, e.g. "insiders" -> content/posts/insiders-2026-09-13.md */
  slug: string;
  /** main title, date is appended automatically */
  title: string;
  /** unique tag used by the home-page button to link the latest post */
  tag: string;
  /** one-paragraph intro under the title */
  intro: string;
  table: PostTable;
  /** attribution for the data source */
  dataSource: { name: string; url: string };
  /** max table rows in the post (default 100) */
  maxRows?: number;
  /** optional extra markdown appended after the table */
  footnote?: string;
}

/** Escape cell text for markdown table safety. */
export function cell(text: string): string {
  return String(text ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

export function writeIndicatorPost(opts: IndicatorPost): string {
  const dateStr = new Date().toISOString().split("T")[0];
  mkdirSync("content/posts", { recursive: true });
  const filename = `content/posts/${opts.slug}-${dateStr}.md`;
  const maxRows = opts.maxRows ?? 100;

  let md = `| ${opts.table.columns.join(" | ")} |\n`;
  md += `|${opts.table.columns.map(() => "------").join("|")}|\n`;
  for (const row of opts.table.rows.slice(0, maxRows)) {
    md += `| ${row.map(c => cell(c)).join(" | ")} |\n`;
  }

  const content = `---
title: "${opts.title} - ${dateStr}"
date: ${new Date().toISOString()}
draft: false
tags: ["stocks", "${opts.tag}"]
---

${opts.intro}

${md}

*Only the ${Math.min(opts.table.rows.length, maxRows)} most relevant rows are shown.*
${opts.footnote ?? ""}
---
*Data source: [${opts.dataSource.name}](${opts.dataSource.url})*
`;

  writeFileSync(filename, content);
  console.log(`Post generated: ${filename} (${Math.min(opts.table.rows.length, maxRows)} rows)`);
  return filename;
}