import type { KontentLanguage, KontentContentType, ItemSystem } from "./types";

export class KontentApiError extends Error {}

function baseUrl(environmentId: string, usePreview: boolean): string {
  const host = usePreview ? "preview-deliver.kontent.ai" : "deliver.kontent.ai";
  return `https://${host}/${environmentId}`;
}

async function fetchJson(
  url: string,
  apiKey: string | undefined,
  signal: AbortSignal,
  extraHeaders?: Record<string, string>,
): Promise<{ data: any; response: Response }> {
  const headers: Record<string, string> = { ...extraHeaders };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { headers, signal });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After")) || 2;
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }

    if (!res.ok) {
      let message = `Request failed (${res.status})`;
      try {
        const body = await res.json();
        if (body?.message) message = body.message;
      } catch {
        // ignore parse failure, use default message
      }
      throw new KontentApiError(`${message} — ${url}`);
    }

    return { data: await res.json(), response: res };
  }

  throw new KontentApiError(`Too many rate-limit retries — ${url}`);
}

export async function fetchAllLanguages(
  environmentId: string,
  apiKey: string | undefined,
  usePreview: boolean,
  signal: AbortSignal,
): Promise<KontentLanguage[]> {
  const result: KontentLanguage[] = [];
  let url: string | null = `${baseUrl(environmentId, usePreview)}/languages?limit=100`;

  while (url) {
    const { data } = await fetchJson(url, apiKey, signal);
    for (const lang of data.languages ?? []) {
      result.push({ id: lang.system.id, name: lang.system.name, codename: lang.system.codename });
    }
    url = data.pagination?.next_page || null;
  }

  return result;
}

export async function fetchAllContentTypes(
  environmentId: string,
  apiKey: string | undefined,
  usePreview: boolean,
  signal: AbortSignal,
): Promise<KontentContentType[]> {
  const result: KontentContentType[] = [];
  let url: string | null = `${baseUrl(environmentId, usePreview)}/types?limit=100`;

  while (url) {
    const { data } = await fetchJson(url, apiKey, signal);
    for (const type of data.types ?? []) {
      result.push({ id: type.system.id, name: type.system.name, codename: type.system.codename });
    }
    url = data.pagination?.next_page || null;
  }

  return result;
}

/**
 * Fetches every content item's system info for a given language, via the
 * "Enumerate content items" (items-feed) endpoint rather than "List content
 * items". items-feed paginates with a continuation token instead of
 * skip/limit, so it's immune to items being skipped or duplicated across
 * pages if content changes mid-crawl — which matters here since this walks
 * every item in every language, and Kontent's own docs recommend it
 * specifically for exporting a whole environment's content.
 * https://kontent.ai/learn/docs/apis/delivery-api/content-items#enumerate-content-items
 */
export async function fetchAllItemsForLanguage(
  environmentId: string,
  apiKey: string | undefined,
  usePreview: boolean,
  languageCodename: string,
  signal: AbortSignal,
  onPage?: (itemsSoFar: number) => void,
  typeCodenames?: string[],
): Promise<ItemSystem[]> {
  const result: ItemSystem[] = [];
  const qs = new URLSearchParams({
    language: languageCodename,
    // Without this, items that don't actually have a variant in this language
    // are returned as a language-fallback copy of the default language's
    // variant, which would make every item look "translated". Filtering on
    // system.language forces the API to return only genuine variants.
    // https://kontent.ai/learn/develop/hello-world/get-localized-content/typescript#a-ignoring-language-fallbacks
    "system.language": languageCodename,
    // `elements=` (empty) does NOT restrict anything — the API treats a blank
    // value as "no filter" and still returns every element's full content.
    // Passing a codename that can never match a real element (no content
    // type uses `""` as a codename) makes the API return each item with an
    // empty elements object instead, which is all we need since we only read
    // item.system — this cuts response payloads by ~90% in testing.
    elements: '""',
  });
  // Scoping to specific content types up front shrinks the crawl itself,
  // rather than fetching everything and discarding items client-side.
  if (typeCodenames && typeCodenames.length > 0) {
    qs.set("system.type[in]", typeCodenames.join(","));
  }
  const url = `${baseUrl(environmentId, usePreview)}/items-feed?${qs.toString()}`;

  let continuationToken: string | null = null;
  do {
    const extraHeaders = continuationToken ? { "X-Continuation": continuationToken } : undefined;
    const { data, response } = await fetchJson(url, apiKey, signal, extraHeaders);
    for (const item of data.items ?? []) {
      result.push(item.system as ItemSystem);
    }
    onPage?.(result.length);
    continuationToken = response.headers.get("X-Continuation");
  } while (continuationToken);

  return result;
}
