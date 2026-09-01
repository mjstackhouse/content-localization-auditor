import { useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import "./App.css";
import { fetchAllContentTypes, fetchAllItemsForLanguage, fetchAllLanguages } from "./kontentApi";
import type { KontentLanguage, ItemSystem, ItemCoverageRow } from "./types";
import { MISSING_VARIANT } from "./types";
import { downloadCsv } from "./csv";

type Stage = "idle" | "running" | "done" | "error";

// Kontent.ai marks the environment's actual default language with this fixed language ID.
const DEFAULT_LANGUAGE_ID = "00000000-0000-0000-0000-000000000000";

// How many languages to crawl at once. Comfortably under Kontent's 100
// req/sec limit even accounting for each language's own page-by-page
// pagination — real wall-clock time is dominated by network round-trips,
// not request count, so this is a straightforward win for environments
// with many languages.
const LANGUAGE_FETCH_CONCURRENCY = 5;

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
  const [onlyIncomplete, setOnlyIncomplete] = useState(true);

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

  // Every item found in any language, unfiltered — the full coverage matrix.
  const [allRows, setAllRows] = useState<ItemCoverageRow[]>([]);
  // Every language the current report's columns are built from, default language first.
  const [allLanguages, setAllLanguages] = useState<KontentLanguage[]>([]);

  const displayedRows = useMemo(
    () => (onlyIncomplete ? allRows.filter((r) => r.missingLanguageCount > 0) : allRows),
    [allRows, onlyIncomplete],
  );

  const abortRef = useRef<AbortController | null>(null);
  const usePreview = apiKey.trim().length > 0;

  function appendLog(message: string) {
    setLog((prev) => [...prev, message]);
  }

  async function handleExport() {
    if (!environmentId.trim()) {
      setErrorMessage("Please enter an environment ID.");
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
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      appendLog("Fetching languages...");
      const langs = await fetchAllLanguages(environmentId.trim(), apiKey.trim() || undefined, usePreview, controller.signal);
      appendLog(`Found ${langs.length} language(s).`);

      appendLog("Fetching content types...");
      const types = await fetchAllContentTypes(environmentId.trim(), apiKey.trim() || undefined, usePreview, controller.signal);
      appendLog(`Found ${types.length} content type(s).`);

      setLanguages(langs);
      const typeNameByCodename = new Map(types.map((t) => [t.codename, t.name]));

      const foundDefault = langs.find((l) => l.id === DEFAULT_LANGUAGE_ID);
      if (!foundDefault) {
        appendLog(`Warning: no language with ID ${DEFAULT_LANGUAGE_ID} was returned; falling back to the first language in the list.`);
      }
      const defLang = foundDefault ?? langs[0] ?? null;
      if (!defLang) {
        throw new Error("This environment has no languages configured.");
      }

      // A small worker pool, not one request-per-language in parallel — that
      // would still respect the rate limit for a handful of languages, but
      // stays well-behaved as the count grows. Used for both the main crawl
      // and the published-status double-check below.
      async function crawlLanguages(
        langsToCrawl: KontentLanguage[],
        preview: boolean,
        resultMap: Map<string, Map<string, ItemSystem>>,
        setProgressMap: Dispatch<SetStateAction<Map<string, string>>>,
        describeStart: (lang: KontentLanguage) => string,
        doneNoun: string,
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

      const itemsByLanguage = new Map<string, Map<string, ItemSystem>>();
      await crawlLanguages(
        langs,
        usePreview,
        itemsByLanguage,
        setLanguageProgress,
        (lang) => `Fetching content items for "${lang.name}" (${lang.codename})`,
        "item(s)",
      );

      // Default language first, so it reads as the reference/source column.
      const orderedLanguages = [defLang, ...langs.filter((l) => l.codename !== defLang.codename)];

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

        coverageRows.push({
          itemName: representative.name,
          itemCodename,
          contentType: typeNameByCodename.get(representative.type) ?? representative.type,
          collection: representative.collection || "(none)",
          missingLanguageCount,
          languageStatus,
        });
      }

      coverageRows.sort((a, b) => a.itemName.localeCompare(b.itemName));

      const incompleteCount = coverageRows.filter((r) => r.missingLanguageCount > 0).length;
      setAllLanguages(orderedLanguages);
      setAllRows(coverageRows);
      setSummary(`Done. Found ${coverageRows.length} item(s) total, ${incompleteCount} with at least one missing translation.`);
      setStage("done");

      // Download right away — the button below is a fallback in case the
      // browser blocked this (some browsers only allow it as the direct
      // result of a click, and this fires well after the one that started
      // the export) and a way to re-export after toggling the checkbox.
      const rowsToExport = onlyIncomplete ? coverageRows.filter((r) => r.missingLanguageCount > 0) : coverageRows;
      downloadCsv(rowsToExport, orderedLanguages, `localization-audit-${environmentId.trim()}.csv`);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setStage("error");
    }
  }

  function handleCancel() {
    abortRef.current?.abort();
  }

  const isBusy = stage === "running";

  return (
    <div className="max-w-5xl mx-auto flex flex-wrap">
      <p id="app-title" className="fixed top-0 right-0 left-0 py-4 pl-12 text-white z-20">
        Content Localization Auditor
      </p>

      <p className="basis-full text-[14px] text-(--color-gray-500) mb-8">
        Audit content localization coverage across every language in your environment, and find
        content that's missing variants.
      </p>

      <section className="basis-full rounded-2xl border border-(--dark-gray) bg-white p-6 mb-6">
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
            disabled={isBusy}
            className="basis-full"
          />
        </div>

        <div className="basis-full flex flex-wrap mb-4">
          <label htmlFor="api-key" className="basis-full text-left mb-2 font-bold">
            Delivery API key
            <Tooltip text="Required if your environment has Secure Access enabled (Environment settings → API keys) — the key needs 'Secure access' permission. This tool always requests preview content so it can include unpublished/draft variants in the audit, so the key also needs 'Content preview' permission. Leave blank only if Secure Access is off, in which case only published content is scanned. Kept in memory only, never stored." />
          </label>
          <input
            type="password"
            id="api-key"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Required if your environment has Secure Access enabled"
            disabled={isBusy}
            className="basis-full"
          />
        </div>

        <label className="basis-full flex items-center gap-2 mb-6 text-[14px]">
          <input
            type="checkbox"
            checked={onlyIncomplete}
            onChange={(e) => setOnlyIncomplete(e.target.checked)}
            disabled={isBusy}
            className="accent-(--purple)"
          />
          Only export items with at least one missing translation
        </label>

        <div className="basis-full flex justify-end gap-3">
          {isBusy && (
            <button onClick={handleCancel} className="btn back-btn">
              Cancel
            </button>
          )}
          <button onClick={handleExport} disabled={isBusy} className="btn continue-btn inline-flex items-center">
            {isBusy && <span className="loading-span" />}
            {isBusy ? "Exporting..." : "Export report"}
          </button>
        </div>

        {errorMessage && <ErrorMessage text={errorMessage} />}
      </section>

      {(log.length > 0 || languageProgress.size > 0 || publishedProgress.size > 0) && (
        <section className="basis-full bg-(--light-gray) rounded-xl p-4 mb-6 font-mono text-[12px] text-(--lighter-black) max-h-52 overflow-y-auto">
          {log.map((line, i) => (
            <div key={`log-${i}`}>{line}</div>
          ))}
          {languages.map(
            (lang) =>
              languageProgress.has(lang.codename) && <div key={lang.codename}>{languageProgress.get(lang.codename)}</div>,
          )}
          {languages.map(
            (lang) =>
              publishedProgress.has(lang.codename) && (
                <div key={`published-${lang.codename}`}>{publishedProgress.get(lang.codename)}</div>
              ),
          )}
          {summary && <div>{summary}</div>}
        </section>
      )}

      {stage === "done" && (
        <section className="basis-full rounded-2xl border border-(--dark-gray) bg-white p-6 mb-6">
          <div className="flex items-center justify-between">
            <h2 className="section-heading">{displayedRows.length} of {allRows.length} item(s) exported</h2>
            <button
              onClick={() => downloadCsv(displayedRows, allLanguages, `localization-audit-${environmentId}.csv`)}
              disabled={displayedRows.length === 0}
              className="btn continue-btn"
            >
              Download CSV
            </button>
          </div>
          <p className="text-[12px] text-(--color-gray-500) mt-4">
            The download should have started automatically. If it didn't, or you toggled the
            checkbox above and want a re-filtered file, use the button.
          </p>
        </section>
      )}
    </div>
  );
}

export default App;
