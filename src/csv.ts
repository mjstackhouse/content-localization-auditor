import type { ItemCoverageRow, KontentLanguage } from "./types";
import { MISSING_VARIANT } from "./types";

const FIXED_COLUMNS = [
  "Content item name",
  "Content type",
  "Collection",
  "URL slug (default language)",
  "Missing language count",
] as const;

function escapeCsvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function buildCsv(rows: ItemCoverageRow[], allLanguages: KontentLanguage[]): string {
  const header = [...FIXED_COLUMNS, ...allLanguages.map((l) => l.name)];
  const lines = [header.map(escapeCsvField).join(",")];

  for (const row of rows) {
    const fields = [
      row.itemName,
      row.contentType,
      row.collection,
      row.urlSlug,
      String(row.missingLanguageCount),
      ...allLanguages.map((l) => row.languageStatus.get(l.codename) ?? MISSING_VARIANT),
    ];
    lines.push(fields.map(escapeCsvField).join(","));
  }

  return lines.join("\n");
}

export function downloadCsv(rows: ItemCoverageRow[], allLanguages: KontentLanguage[], filename: string): void {
  const csv = buildCsv(rows, allLanguages);
  // Excel guesses a CSV's encoding when opened by double-click, and without
  // this BOM it usually guesses wrong for UTF-8 — multi-byte characters
  // (emoji, accented letters) come out as mojibake. The BOM tells Excel
  // explicitly to read it as UTF-8; other tools (Sheets, Numbers) ignore or
  // strip it transparently.
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
