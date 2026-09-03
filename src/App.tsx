import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import "./App.css";
import { fetchAllContentTypes, fetchAllItemsForLanguage, fetchAllLanguages, setRequestDelayMs } from "./kontentApi";
import type { KontentLanguage, KontentContentType, ItemSystem, ItemCoverageRow } from "./types";
import { MISSING_VARIANT } from "./types";
import { downloadCsv } from "./csv";

type Stage = "idle" | "connecting" | "ready" | "running" | "done" | "error";

// Kontent.ai marks the environment's actual default language with this fixed language ID.
const DEFAULT_LANGUAGE_ID = "00000000-0000-0000-0000-000000000000";

// How many languages to crawl at once. Comfortably under Kontent's 100
// req/sec limit even accounting for each language's own page-by-page
// pagination — real wall-clock time is dominated by network round-trips,
// not request count, so this is a straightforward win for environments
// with many languages.
const LANGUAGE_FETCH_CONCURRENCY = 5;

// Named presets rather than a raw millisecond input — most users of this
// tool won't know what to set a delay to, or why one matters at all. When
// embedded as a custom app, this is skipped entirely in favor of a
// requestDelayMs value in the app's JSON config, set once by whoever
// installs it rather than by every person who runs an audit.
const CRAWL_SPEED_PRESETS = {
  normal: { label: "Normal (recommended)", delayMs: 150 },
  cautious: { label: "Cautious — for busier sites", delayMs: 350 },
  veryCautious: { label: "Very cautious — for high-traffic sites", delayMs: 700 },
  fastest: { label: "Fastest — no delay (use with caution)", delayMs: 0 },
} as const;
type CrawlSpeedKey = keyof typeof CRAWL_SPEED_PRESETS;
const DEFAULT_CRAWL_SPEED: CrawlSpeedKey = "normal";

function extractRequestDelayMs(appConfig: unknown): number | null {
  if (appConfig && typeof appConfig === "object" && "requestDelayMs" in appConfig) {
    const value = (appConfig as Record<string, unknown>).requestDelayMs;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return null;
}

// Same JSON key export-tool uses for this, for consistency across both tools.
function extractDeliveryKey(appConfig: unknown): string | null {
  if (appConfig && typeof appConfig === "object" && "deliveryKey" in appConfig) {
    const value = (appConfig as Record<string, unknown>).deliveryKey;
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

// YYYY-MM-DD, local date — same format export-tool uses for its export filenames.
function formatDateStamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function Tooltip({ text }: { text: string }) {
  return (
    <span className="tooltip-icon" title={text}>
      ⓘ
    </span>
  );
}

function ErrorMessage({ text }: { text: string }) {
  return (
    <p className="inline-flex items-stretch rounded-lg overflow-hidden mt-3">
      <span className="bg-(--red) text-white px-2 py-1.5 inline-flex items-center message-icon-section rounded-l-lg">
        <span className="text-[14px]">⚠</span>
      </span>
      <span className="bg-(--color-gray-100) text-black px-3 py-1.5 inline-flex items-center rounded-r-lg text-[13px]">
        {text}
      </span>
    </p>
  );
}

function App() {
  const [environmentId, setEnvironmentId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [includeUnpublished, setIncludeUnpublished] = useState(false);
  const [onlyIncomplete, setOnlyIncomplete] = useState(true);
  const [includeUrlSlug, setIncludeUrlSlug] = useState(false);
  const [crawlSpeed, setCrawlSpeed] = useState<CrawlSpeedKey>(DEFAULT_CRAWL_SPEED);

  // Custom apps run inside an iframe within app.kontent.ai; a standalone tab
  // is always its own top-level window.
  const [insideKontentAi] = useState(() => typeof window !== "undefined" && window.self !== window.top);
  const [customAppRequestDelayMs, setCustomAppRequestDelayMs] = useState<number | null>(null);
  // Gates step 1 while the (async, postMessage-based) context fetch is in
  // flight — there's nothing to wait for outside Kontent.ai, so this starts
  // true in that case.
  const [customAppContextLoaded, setCustomAppContextLoaded] = useState(!insideKontentAi);

  useEffect(() => {
    if (!insideKontentAi) return;
    (async () => {
      try {
        const { getCustomAppContext } = await import("@kontent-ai/custom-app-sdk");
        const result = await getCustomAppContext();
        if (!result.isError) {
          setCustomAppRequestDelayMs(extractRequestDelayMs(result.context.appConfig));
          if (result.context.environmentId) {
            setEnvironmentId(result.context.environmentId);
          }
          const deliveryKey = extractDeliveryKey(result.context.appConfig);
          if (deliveryKey) {
            setApiKey(deliveryKey);
          }
        }
      } catch {
        // Not actually embedded, or the SDK couldn't reach the parent frame —
        // fall back to the defaults below, including showing the
        // environment ID and API key fields so the user isn't stuck with no way in.
      } finally {
        setCustomAppContextLoaded(true);
      }
    })();
  }, [insideKontentAi]);

  const effectiveRequestDelayMs = insideKontentAi
    ? (customAppRequestDelayMs ?? CRAWL_SPEED_PRESETS[DEFAULT_CRAWL_SPEED].delayMs)
    : CRAWL_SPEED_PRESETS[crawlSpeed].delayMs;

  const [stage, setStage] = useState<Stage>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [log, setLog] = useState<string[]>([]);
  // Per-language progress line, keyed by language codename — languages fetch
  // concurrently, so each needs its own line rather than a shared "last line".
  const [languageProgress, setLanguageProgress] = useState<Map<string, string>>(new Map());
  // Same idea, for the second pass that double-checks published status.
  const [publishedProgress, setPublishedProgress] = useState<Map<string, string>>(new Map());
  // The final "Done..." line, kept separate so it always renders after the
  // per-language lines above regardless of when it was appended to `log`.
  const [summary, setSummary] = useState("");

  const [languages, setLanguages] = useState<KontentLanguage[]>([]);
  const [contentTypes, setContentTypes] = useState<KontentContentType[]>([]);
  const [defaultLanguage, setDefaultLanguage] = useState<KontentLanguage | null>(null);
  const [selectedTypeCodenames, setSelectedTypeCodenames] = useState<Set<string>>(new Set());
  // Distinguishes an error from step 1 (connect) vs. step 2 (export) — can't
  // use contentTypes.length for this, since a real environment could have zero.
  const [hasConnected, setHasConnected] = useState(false);

  // Every item found in any language, unfiltered — the full coverage matrix.
  const [allRows, setAllRows] = useState<ItemCoverageRow[]>([]);
  // Every language the current report's columns are built from, default language first.
  const [allLanguages, setAllLanguages] = useState<KontentLanguage[]>([]);
  // Whether allRows actually has slug data — a snapshot of includeUrlSlug at
  // crawl time, since toggling the live checkbox afterward without
  // re-running the export wouldn't change what's actually in memory.
  const [rowsHaveUrlSlug, setRowsHaveUrlSlug] = useState(false);
  // When this run's crawl finished — reused for every download of this
  // report's data, so re-clicking "Download CSV" later doesn't silently
  // shift the filename's date away from when the data was actually captured.
  const [exportTimestamp, setExportTimestamp] = useState("");

  const displayedRows = useMemo(
    () => (onlyIncomplete ? allRows.filter((r) => r.missingLanguageCount > 0) : allRows),
    [allRows, onlyIncomplete],
  );

  const abortRef = useRef<AbortController | null>(null);
  // Preview mode is an explicit opt-in, not implied by "a key was given" — a
  // key may only be there for Secure Access on the published endpoint.
  const usePreview = includeUnpublished;
  const allTypesSelected = contentTypes.length > 0 && selectedTypeCodenames.size === contentTypes.length;

  function appendLog(message: string) {
    setLog((prev) => [...prev, message]);
  }

  async function handleConnect() {
    if (!environmentId.trim()) {
      setErrorMessage("Please enter an environment ID.");
      return;
    }

    setStage("connecting");
    setErrorMessage("");
    setLog([]);
    setRequestDelayMs(effectiveRequestDelayMs);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      appendLog("Fetching languages...");
      const langs = await fetchAllLanguages(environmentId.trim(), apiKey.trim() || undefined, usePreview, controller.signal);
      appendLog(`Found ${langs.length} language(s).`);

      appendLog("Fetching content types...");
      const types = await fetchAllContentTypes(environmentId.trim(), apiKey.trim() || undefined, usePreview, controller.signal);
      appendLog(`Found ${types.length} content type(s).`);

      const foundDefault = langs.find((l) => l.id === DEFAULT_LANGUAGE_ID);
      if (!foundDefault) {
        appendLog(`Warning: no language with ID ${DEFAULT_LANGUAGE_ID} was returned; falling back to the first language in the list.`);
      }
      const defLang = foundDefault ?? langs[0] ?? null;
      if (!defLang) {
        throw new Error("This environment has no languages configured.");
      }

      setLanguages(langs);
      setContentTypes(types);
      setDefaultLanguage(defLang);
      setSelectedTypeCodenames(new Set(types.map((t) => t.codename)));
      setHasConnected(true);
      setStage("ready");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setStage("error");
    }
  }

  function handleBack() {
    setStage("idle");
    setErrorMessage("");
    setLog([]);
    setLanguageProgress(new Map());
    setPublishedProgress(new Map());
    setSummary("");
    setLanguages([]);
    setContentTypes([]);
    setDefaultLanguage(null);
    setSelectedTypeCodenames(new Set());
    setHasConnected(false);
    setAllRows([]);
    setAllLanguages([]);
    setRowsHaveUrlSlug(false);
    setExportTimestamp("");
  }

  function toggleType(codename: string) {
    setSelectedTypeCodenames((prev) => {
      const next = new Set(prev);
      if (next.has(codename)) next.delete(codename);
      else next.add(codename);
      return next;
    });
  }

  function toggleSelectAllTypes(checked: boolean) {
    setSelectedTypeCodenames(checked ? new Set(contentTypes.map((t) => t.codename)) : new Set());
  }

  async function handleExport() {
    if (!defaultLanguage) return;
    if (selectedTypeCodenames.size === 0) {
      setErrorMessage("Please select at least one content type.");
      return;
    }

    setStage("running");
    setErrorMessage("");
    setLog([]);
    setLanguageProgress(new Map());
    setPublishedProgress(new Map());
    setSummary("");
    setAllRows([]);
    setAllLanguages([]);
    setRequestDelayMs(effectiveRequestDelayMs);
    const controller = new AbortController();
    abortRef.current = controller;

    // Omit the filter entirely when every type is selected — equivalent
    // result, shorter query string, and avoids missing a type that's added
    // to the environment mid-crawl (however unlikely).
    const typeFilter = allTypesSelected ? undefined : Array.from(selectedTypeCodenames);
    const typeNameByCodename = new Map(contentTypes.map((t) => [t.codename, t.name]));
    const slugElementCodenameByType = new Map(contentTypes.map((t) => [t.codename, t.slugElementCodename]));

    // URL slugs are usually per-language, so this only ever reads the
    // default-language variant's slug rather than pretending to speak for
    // every language. An explicit opt-in, since that scoping only makes
    // sense when a customer's slugs are actually shared across languages —
    // when unchecked, this stays empty and the default-language crawl never
    // requests these elements at all, so there's no cost either.
    const slugElementCodenames = includeUrlSlug
      ? Array.from(
          new Set(
            contentTypes
              .filter((t) => selectedTypeCodenames.has(t.codename))
              .map((t) => t.slugElementCodename)
              .filter((c): c is string => !!c),
          ),
        )
      : [];

    try {
      // A small worker pool, not one request-per-language in parallel — that
      // would still respect the rate limit for a handful of languages, but
      // stays well-behaved as the count grows. Used for the main crawl, the
      // published-status double-check below, and the default-language pass.
      async function crawlLanguages(
        langsToCrawl: KontentLanguage[],
        preview: boolean,
        resultMap: Map<string, Map<string, ItemSystem>>,
        setProgressMap: Dispatch<SetStateAction<Map<string, string>>>,
        describeStart: (lang: KontentLanguage) => string,
        doneNoun: string,
        elementCodenames?: string[],
      ) {
        function setProgress(codename: string, message: string) {
          setProgressMap((prev) => new Map(prev).set(codename, message));
        }

        let nextIndex = 0;
        async function worker() {
          while (nextIndex < langsToCrawl.length) {
            const lang = langsToCrawl[nextIndex++];
            const startMessage = describeStart(lang);
            setProgress(lang.codename, `${startMessage}...`);
            const items = await fetchAllItemsForLanguage(
              environmentId.trim(),
              apiKey.trim() || undefined,
              preview,
              lang.codename,
              controller.signal,
              (count) => setProgress(lang.codename, `${startMessage}... ${count} so far`),
              typeFilter,
              elementCodenames,
            );
            const byCodename = new Map<string, ItemSystem>();
            for (const item of items) byCodename.set(item.codename, item);
            resultMap.set(lang.codename, byCodename);
            setProgress(lang.codename, `"${lang.name}" (${lang.codename}): ${items.length} ${doneNoun}.`);
          }
        }

        const workerCount = Math.min(LANGUAGE_FETCH_CONCURRENCY, langsToCrawl.length);
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
      }

      const otherLanguages = languages.filter((l) => l.codename !== defaultLanguage.codename);
      const itemsByLanguage = new Map<string, Map<string, ItemSystem>>();
      const describeStart = (lang: KontentLanguage) => `Fetching content items for "${lang.name}" (${lang.codename})`;

      await Promise.all([
        crawlLanguages(
          [defaultLanguage],
          usePreview,
          itemsByLanguage,
          setLanguageProgress,
          describeStart,
          "item(s)",
          slugElementCodenames.length > 0 ? slugElementCodenames : undefined,
        ),
        crawlLanguages(otherLanguages, usePreview, itemsByLanguage, setLanguageProgress, describeStart, "item(s)"),
      ]);

      // Default language first, so it reads as the reference/source column.
      const orderedLanguages = [defaultLanguage, ...otherLanguages];

      // Kontent.ai lets a variant have a newer, unpublished version sitting on
      // top of an already-published one — the Preview API only ever returns
      // the newer version, so a variant whose latest workflow step is e.g.
      // "draft" might still have an older version that's genuinely live right
      // now. Only worth checking in preview mode (a non-preview crawl already
      // only saw published content), and only for languages where at least
      // one item's latest step isn't already "published" — no point crawling
      // a language a second time if there's nothing ambiguous to resolve.
      const publishedItemsByLanguage = new Map<string, Map<string, ItemSystem>>();
      if (usePreview) {
        const languagesNeedingCheck = orderedLanguages.filter((lang) => {
          const byCodename = itemsByLanguage.get(lang.codename);
          if (!byCodename) return false;
          for (const item of byCodename.values()) {
            if ((item.workflow_step ?? "unknown") !== "published") return true;
          }
          return false;
        });

        if (languagesNeedingCheck.length > 0) {
          await crawlLanguages(
            languagesNeedingCheck,
            false,
            publishedItemsByLanguage,
            setPublishedProgress,
            (lang) => `Checking published status for "${lang.name}" (${lang.codename})`,
            "already-published item(s)",
          );
        }
      }

      // Every item codename found in ANY language — not just the default one.
      // An item that only exists in a non-default language (no default-language
      // source at all) is itself worth surfacing in a general coverage audit.
      const allItemCodenames = new Set<string>();
      for (const byCodename of itemsByLanguage.values()) {
        for (const codename of byCodename.keys()) allItemCodenames.add(codename);
      }

      const coverageRows: ItemCoverageRow[] = [];

      for (const itemCodename of allItemCodenames) {
        const languageStatus = new Map<string, string>();
        let missingLanguageCount = 0;
        // The first variant found, in default-language-first order — used for
        // itemName since that's genuinely per-variant. Content type and
        // collection are item-level in Kontent.ai, so any variant's values
        // for those are correct regardless of which one this is.
        let representative: ItemSystem | null = null;

        for (const lang of orderedLanguages) {
          const variant = itemsByLanguage.get(lang.codename)?.get(itemCodename);
          if (variant) {
            let status = variant.workflow_step ?? (usePreview ? "unknown" : "published");
            if (status !== "published" && publishedItemsByLanguage.get(lang.codename)?.has(itemCodename)) {
              status = `${status}/published`;
            }
            languageStatus.set(lang.codename, status);
            if (!representative) representative = variant;
          } else {
            languageStatus.set(lang.codename, MISSING_VARIANT);
            missingLanguageCount += 1;
          }
        }

        if (!representative) continue;

        // Deliberately from the default-language variant specifically, not
        // `representative` — a slug is usually per-language, so this should
        // only ever claim to be the default language's URL, and stay blank
        // when the item has no default-language variant to read it from.
        const defaultVariant = itemsByLanguage.get(defaultLanguage.codename)?.get(itemCodename);
        const slugElementCodename = defaultVariant && slugElementCodenameByType.get(defaultVariant.type);
        const urlSlug = (slugElementCodename && defaultVariant?.elements?.[slugElementCodename]?.value) || "";

        coverageRows.push({
          itemName: representative.name,
          itemCodename,
          contentType: typeNameByCodename.get(representative.type) ?? representative.type,
          collection: representative.collection || "(none)",
          urlSlug,
          missingLanguageCount,
          languageStatus,
        });
      }

      coverageRows.sort((a, b) => a.itemName.localeCompare(b.itemName));

      const incompleteCount = coverageRows.filter((r) => r.missingLanguageCount > 0).length;
      const timestamp = formatDateStamp(new Date());
      setAllLanguages(orderedLanguages);
      setAllRows(coverageRows);
      setRowsHaveUrlSlug(includeUrlSlug);
      setExportTimestamp(timestamp);
      setSummary(`Done. Found ${coverageRows.length} item(s) total, ${incompleteCount} with at least one missing translation.`);
      setStage("done");

      // Download right away — the button below is a fallback in case the
      // browser blocked this (some browsers only allow it as the direct
      // result of a click, and this fires well after the one that started
      // the export) and a way to re-export after toggling the checkbox.
      const rowsToExport = onlyIncomplete ? coverageRows.filter((r) => r.missingLanguageCount > 0) : coverageRows;
      downloadCsv(
        rowsToExport,
        orderedLanguages,
        includeUrlSlug,
        `localization-audit-${environmentId.trim()}-${timestamp}.csv`,
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setStage("error");
    }
  }

  function handleCancel() {
    abortRef.current?.abort();
  }

  const isConnecting = stage === "connecting";
  const isRunning = stage === "running";

  return (
    <div className="max-w-5xl mx-auto flex flex-wrap">
      <p id="app-title" className="fixed top-0 right-0 left-0 py-4 pl-12 text-white z-20">
        Content Localization Auditor
      </p>

      <p className="basis-full text-[14px] text-(--color-gray-500) mb-8">
        Audit content localization coverage across every language in your environment, and find
        content that's missing variants.
      </p>

      {(stage === "idle" || stage === "connecting" || (stage === "error" && !hasConnected)) && (
        <section className="basis-full rounded-2xl border border-(--dark-gray) bg-white p-6 mb-6">
          {insideKontentAi && !customAppContextLoaded && (
            <p className="basis-full text-[14px] text-(--color-gray-500) mb-6">Loading environment info...</p>
          )}

          {(!insideKontentAi || (customAppContextLoaded && !environmentId)) && (
            <div className="basis-full flex flex-wrap mb-6">
              <label htmlFor="environment-id" className="basis-full text-left mb-2 font-bold">
                Environment ID
                <Tooltip text="Found under Environment settings, or in the app.kontent.ai/<environment-id> URL." />
              </label>
              <input
                type="text"
                id="environment-id"
                value={environmentId}
                onChange={(e) => setEnvironmentId(e.target.value)}
                placeholder="e.g. 975bf280-fd91-488c-994c-2f04416e5ee3"
                disabled={isConnecting}
                className="basis-full"
              />
            </div>
          )}

          {(!insideKontentAi || (customAppContextLoaded && !apiKey)) && (
            <div className="basis-full flex flex-wrap mb-4">
              <label htmlFor="api-key" className="basis-full text-left mb-2 font-bold">
                Delivery API key
                <Tooltip text="Required if your environment has Secure Access enabled (Environment settings → API keys) — the key needs 'Secure access' permission for that. If you also check 'Include unpublished content' below, the key additionally needs 'Content preview' permission. Leave blank only if Secure Access is off. Kept in memory only, never stored." />
              </label>
              <input
                type="password"
                id="api-key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Required if your environment has Secure Access enabled"
                disabled={isConnecting}
                className="basis-full"
              />
            </div>
          )}

          <label className="input-container basis-full flex items-center gap-2 mb-6 text-[14px]">
            <input
              type="checkbox"
              checked={includeUnpublished}
              onChange={(e) => setIncludeUnpublished(e.target.checked)}
              disabled={isConnecting}
              className="accent-(--purple)"
            />
            Include unpublished content
            <Tooltip text="Off by default: only published content is scanned, matching what's actually live today, and the API key (if any) only needs 'Secure access' permission. Check this to also see in-progress translations that haven't been published yet — the key then needs 'Content preview' permission too." />
          </label>

          {!insideKontentAi && (
            <fieldset className="basis-full flex flex-wrap mb-6">
              <details className="basis-full flex flex-wrap">
                <summary className="basis-full">
                  <div className="relative">
                    <legend className="section-heading">Advanced settings</legend>
                  </div>
                </summary>

                <div className="basis-full flex flex-wrap pl-10">
                  <label htmlFor="crawl-speed" className="basis-full text-left mb-2 font-bold">
                    Crawl speed
                    <Tooltip text="This tool shares your environment's Delivery API rate limit with everything else hitting it, like your live website's own visitors. Slower settings leave more of that shared limit available for real traffic." />
                  </label>
                  <select
                    id="crawl-speed"
                    value={crawlSpeed}
                    onChange={(e) => setCrawlSpeed(e.target.value as CrawlSpeedKey)}
                    disabled={isConnecting}
                    className="basis-full"
                  >
                    {Object.entries(CRAWL_SPEED_PRESETS).map(([key, preset]) => (
                      <option key={key} value={key}>
                        {preset.label}
                      </option>
                    ))}
                  </select>
                </div>
              </details>
            </fieldset>
          )}

          <div className="basis-full flex justify-end gap-3">
            {isConnecting && (
              <button onClick={handleCancel} className="btn back-btn">
                Cancel
              </button>
            )}
            <button
              onClick={handleConnect}
              disabled={isConnecting || !customAppContextLoaded}
              className="btn continue-btn inline-flex items-center"
            >
              {isConnecting && <span className="loading-span" />}
              {isConnecting ? "Connecting..." : "Continue"}
            </button>
          </div>

          {errorMessage && <ErrorMessage text={errorMessage} />}
        </section>
      )}

      {(stage === "ready" || stage === "running" || stage === "done" || (stage === "error" && hasConnected)) && (
        <section className="basis-full rounded-2xl border border-(--dark-gray) bg-white p-6 mb-6">
          <fieldset className="basis-full flex flex-wrap mb-6">
            <details className="basis-full flex flex-wrap" open>
              <summary className="basis-full">
                <div className="relative">
                  <legend className="section-heading">Content types</legend>
                </div>
              </summary>

              <div className="basis-full flex mb-3 pl-10">
                <label htmlFor="select-all-types" className="input-container relative flex items-center">
                  <input
                    type="checkbox"
                    id="select-all-types"
                    checked={allTypesSelected}
                    onChange={(e) => toggleSelectAllTypes(e.target.checked)}
                    disabled={isRunning}
                    className="mr-2 accent-(--purple)"
                  />
                  Select all
                </label>
              </div>

              <div className="pl-18 flex flex-wrap">
                {contentTypes.map((type) => (
                  <div className="flex flex-wrap basis-full mb-3" key={type.codename}>
                    <label htmlFor={type.codename} className="input-container relative flex items-center">
                      <input
                        type="checkbox"
                        id={type.codename}
                        checked={selectedTypeCodenames.has(type.codename)}
                        onChange={() => toggleType(type.codename)}
                        disabled={isRunning}
                        className="mr-2 accent-(--purple)"
                      />
                      {type.name}
                    </label>
                  </div>
                ))}
              </div>
            </details>
          </fieldset>

          <div className="basis-full border-t border-(--dark-gray) pt-6 mb-6">
            <p className="section-heading mb-3">Export options</p>
            <label className="input-container basis-full flex items-center gap-2 mb-3 text-[14px]">
              <input
                type="checkbox"
                checked={onlyIncomplete}
                onChange={(e) => setOnlyIncomplete(e.target.checked)}
                disabled={isRunning}
                className="accent-(--purple)"
              />
              Only export items with at least one missing translation
            </label>

            <label className="input-container basis-full flex items-center gap-2 text-[14px]">
              <input
                type="checkbox"
                checked={includeUrlSlug}
                onChange={(e) => setIncludeUrlSlug(e.target.checked)}
                disabled={isRunning}
                className="accent-(--purple)"
              />
              Include URL slug
              <Tooltip text="Adds each item's URL slug — but only from its default-language variant, since a slug is usually different per language. This is most useful when a content type's slug is shared across languages rather than translated separately; otherwise it will only reflect the default language's URL." />
            </label>
          </div>

          <div className="basis-full flex justify-between gap-3 mt-6">
            {isRunning ? (
              <button onClick={handleCancel} className="btn back-btn">
                Cancel
              </button>
            ) : (
              <button onClick={handleBack} className="btn back-btn">
                Back
              </button>
            )}
            <button onClick={handleExport} disabled={isRunning} className="btn continue-btn inline-flex items-center">
              {isRunning && <span className="loading-span" />}
              {isRunning ? "Exporting..." : "Export report"}
            </button>
          </div>

          {errorMessage && <ErrorMessage text={errorMessage} />}
        </section>
      )}

      {(log.length > 0 || languageProgress.size > 0 || publishedProgress.size > 0) && (
        <section className="basis-full bg-(--light-gray) rounded-xl p-4 mb-6">
          <p className="section-heading mb-2">Progress log</p>
          <div className="font-mono text-[12px] text-(--lighter-black) max-h-52 overflow-y-auto">
            {log.map((line, i) => (
              <div key={`log-${i}`}>{line}</div>
            ))}
            {languages.map(
              (lang) =>
                languageProgress.has(lang.codename) && (
                  <div key={lang.codename}>{languageProgress.get(lang.codename)}</div>
                ),
            )}
            {languages.map(
              (lang) =>
                publishedProgress.has(lang.codename) && (
                  <div key={`published-${lang.codename}`}>{publishedProgress.get(lang.codename)}</div>
                ),
            )}
            {summary && <div>{summary}</div>}
          </div>
        </section>
      )}

      {stage === "done" && (
        <section className="basis-full rounded-2xl border border-(--dark-gray) bg-white p-6 mb-6">
          <div className="flex items-center justify-between">
            <h2 className="section-heading">{displayedRows.length} of {allRows.length} item(s) exported</h2>
            <button
              onClick={() =>
                downloadCsv(
                  displayedRows,
                  allLanguages,
                  rowsHaveUrlSlug,
                  `localization-audit-${environmentId}-${exportTimestamp}.csv`,
                )
              }
              disabled={displayedRows.length === 0}
              className="btn continue-btn"
            >
              Download CSV
            </button>
          </div>
          <p className="text-[12px] text-(--color-gray-500) mt-4">
            The download should have started automatically. If it didn't, or you changed the
            selection above and want a re-filtered file, use the button.
          </p>
        </section>
      )}
    </div>
  );
}

export default App;
