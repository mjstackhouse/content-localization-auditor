import type { ItemCoverageRow, KontentLanguage } from "./types";
import { MISSING_VARIANT } from "./types";

const FIXED_COLUMNS = ["Content item name", "Content type", "Collection", "Missing language count"] as const;
const URL_SLUG_COLUMN = "URL slug (default language)";

function escapeCsvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function buildCsv(rows: ItemCoverageRow[], allLanguages: KontentLanguage[], includeUrlSlug: boolean): string {
  // allLanguages is always built default-language-first (see App.tsx), so
  // index 0 is the one to mark — matching how Kontent.ai's own UI labels it.
  const header = [
    ...FIXED_COLUMNS.slice(0, 3),
    ...(includeUrlSlug ? [URL_SLUG_COLUMN] : []),
    ...FIXED_COLUMNS.slice(3),
    ...allLanguages.map((l, i) => (i === 0 ? `${l.name} (Default)` : l.name)),
  ];
  const lines = [header.map(escapeCsvField).join(",")];

  for (const row of rows) {
    const fields = [
      row.itemName,
      row.contentType,
      row.collection,
      ...(includeUrlSlug ? [row.urlSlug] : []),
      String(row.missingLanguageCount),
      ...allLanguages.map((l) => row.languageStatus.get(l.codename) ?? MISSING_VARIANT),
    ];
    lines.push(fields.map(escapeCsvField).join(","));
  }

  return lines.join("\n");
}

export function downloadCsv(
  rows: ItemCoverageRow[],
  allLanguages: KontentLanguage[],
  includeUrlSlug: boolean,
  filename: string,
): void {
  const csv = buildCsv(rows, allLanguages, includeUrlSlug);
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
