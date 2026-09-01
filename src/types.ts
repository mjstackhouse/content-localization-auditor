export interface KontentLanguage {
  id: string;
  name: string;
  codename: string;
}

export interface KontentContentType {
  id: string;
  name: string;
  codename: string;
}

export interface ItemSystem {
  id: string;
  name: string;
  codename: string;
  type: string;
  collection: string;
  language: string;
  last_modified: string;
  workflow_step?: string;
  workflow?: string;
}

/** All variants found for one content item codename, keyed by language codename. */
export type ItemVariantsByLanguage = Map<string, ItemSystem>;

export const MISSING_VARIANT = "Missing";

/**
 * One row per content item, covering every language (including the default
 * one) with a per-language status cell (a workflow step, or MISSING_VARIANT).
 *
 * itemName, contentType, and collection are read off a single "representative"
 * variant (the default-language one when it exists, otherwise whichever
 * variant does) — content type and collection are item-level in Kontent.ai,
 * so any variant's values are correct regardless of which one this is.
 */
export interface ItemCoverageRow {
  itemName: string;
  itemCodename: string;
  contentType: string;
  collection: string;
  missingLanguageCount: number;
  /** Keyed by language codename, for every language in the environment. */
  languageStatus: Map<string, string>;
}

export interface FetchProgress {
  message: string;
}
