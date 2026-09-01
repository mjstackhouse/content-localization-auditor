export interface KontentLanguage {
  id: string;
  name: string;
  codename: string;
}

export interface KontentContentType {
  id: string;
  name: string;
  codename: string;
  /** Codename of this type's URL slug element, if it has one. */
  slugElementCodename?: string;
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
  /** Present only when explicitly requested via fetchAllItemsForLanguage's elementCodenames param. */
  elements?: Record<string, { value?: string }>;
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
 *
 * urlSlug is deliberately scoped to the default-language variant specifically
 * (blank if the item has none), not the representative variant — a slug is
 * usually per-language, so this only ever claims to represent one language's
 * URL rather than pretending to speak for all of them. Blank whenever the
 * item's content type has no URL slug element at all.
 */
export interface ItemCoverageRow {
  itemName: string;
  itemCodename: string;
  contentType: string;
  collection: string;
  urlSlug: string;
  missingLanguageCount: number;
  /** Keyed by language codename, for every language in the environment. */
  languageStatus: Map<string, string>;
}

export interface FetchProgress {
  message: string;
}
