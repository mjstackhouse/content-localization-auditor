import { HttpService } from "@kontent-ai/core-sdk";
import type { IHttpGetQueryCall, IHttpQueryOptions, IHttpCancelRequestToken, IResponse } from "@kontent-ai/core-sdk";
import { DeliveryClient } from "@kontent-ai/delivery-sdk";
import type { KontentLanguage, KontentContentType, ItemSystem } from "./types";

export class KontentApiError extends Error {}

// Kontent's Delivery API rate limit (100 req/sec, ~33 req/sec sustained) is
// shared across everything hitting the environment — this tool's own crawl
// isn't the only traffic. This is a floor on the time between the START of
// any two requests, enforced globally across every concurrent language
// worker (and both the SDK's own internal pagination requests), so raising
// crawl concurrency never raises how fast requests actually go out — it only
// hides network latency, which is the point.
let requestDelayMs = 150;
let nextAvailableSlotAt = 0;

export function setRequestDelayMs(ms: number): void {
  requestDelayMs = Math.max(0, ms);
}

async function throttle(): Promise<void> {
  const now = Date.now();
  const scheduledAt = Math.max(now, nextAvailableSlotAt);
  // Reserve the slot synchronously (no `await` yet) so concurrent callers
  // queue up correctly instead of racing on a stale nextAvailableSlotAt.
  nextAvailableSlotAt = scheduledAt + requestDelayMs;
  const waitMs = scheduledAt - now;
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

// The SDK's own HTTP layer only retries reactively on 429/5xx — it has no
// proactive rate limiting. This is the documented extension point
// (IDeliveryClientConfig.httpService) for adding that, so every request the
// SDK makes, from any query, funnels through the same throttle above.
class ThrottledHttpService extends HttpService {
  override async getAsync<TRawData>(
    call: IHttpGetQueryCall,
    options?: IHttpQueryOptions<any>,
  ): Promise<IResponse<TRawData>> {
    await throttle();
    return super.getAsync<TRawData>(call, options);
  }
}

// Mints a cancel token via the SDK's own http service so it's guaranteed
// compatible with whatever request-cancellation mechanism the SDK's bundled
// HTTP client actually checks — the SDK uses axios's CancelToken, not the
// native AbortController/AbortSignal this tool used before migrating.
const cancelTokenFactory = new HttpService();

export type CancelHandle = IHttpCancelRequestToken<unknown>;

export function createCancelHandle(): CancelHandle {
  return cancelTokenFactory.createCancelToken();
}

function createClient(environmentId: string, apiKey: string | undefined, usePreview: boolean): DeliveryClient {
  return new DeliveryClient({
    environmentId,
    previewApiKey: usePreview ? apiKey : undefined,
    secureApiKey: usePreview ? undefined : apiKey,
    defaultQueryConfig: {
      usePreviewMode: usePreview,
      useSecuredMode: !usePreview && !!apiKey,
    },
    httpService: new ThrottledHttpService(),
  });
}

// Normalizes whatever the SDK throws (a DeliveryError with a `.message` but
// no Error prototype, a raw axios error, a cancellation) into a real Error
// subclass, so callers can keep doing `err instanceof Error ? err.message : ...`.
async function unwrap<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    const message =
      err && typeof err === "object" && "message" in err ? String((err as { message?: unknown }).message) : String(err);
    throw new KontentApiError(message);
  }
}

export async function fetchAllLanguages(
  environmentId: string,
  apiKey: string | undefined,
  usePreview: boolean,
  cancelHandle: CancelHandle,
): Promise<KontentLanguage[]> {
  const client = createClient(environmentId, apiKey, usePreview);
  const result = await unwrap(client.languages().queryConfig({ cancelToken: cancelHandle }).toAllPromise());
  return result.data.items.map((lang) => ({ id: lang.system.id, name: lang.system.name, codename: lang.system.codename }));
}

export async function fetchAllContentTypes(
  environmentId: string,
  apiKey: string | undefined,
  usePreview: boolean,
  cancelHandle: CancelHandle,
): Promise<KontentContentType[]> {
  const client = createClient(environmentId, apiKey, usePreview);
  const result = await unwrap(client.types().queryConfig({ cancelToken: cancelHandle }).toAllPromise());
  return result.data.items.map((type) => {
    // Find this type's URL slug element, if it has one — lets us later ask
    // for just that element's value instead of every element.
    const slugElement = type.elements.find((el) => el.type === "url_slug");
    return {
      id: type.system.id,
      name: type.system.name,
      codename: type.system.codename,
      slugElementCodename: slugElement?.codename,
    };
  });
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
  cancelHandle: CancelHandle,
  onPage?: (itemsSoFar: number) => void,
  typeCodenames?: string[],
  elementCodenames?: string[],
): Promise<ItemSystem[]> {
  const client = createClient(environmentId, apiKey, usePreview);

  let query = client
    .itemsFeed()
    .languageParameter(languageCodename)
    // Without this, items that don't actually have a variant in this language
    // are returned as a language-fallback copy of the default language's
    // variant, which would make every item look "translated". Filtering on
    // system.language forces the API to return only genuine variants.
    // https://kontent.ai/learn/develop/hello-world/get-localized-content/typescript#a-ignoring-language-fallbacks
    .equalsFilter("system.language", languageCodename);

  query =
    elementCodenames && elementCodenames.length > 0
      ? // Ask for specific elements (e.g. a URL slug) only when a caller
        // actually needs them — otherwise fall through to the zero-elements
        // trick below.
        query.elementsParameter(elementCodenames)
      : // An empty elements filter does NOT restrict anything — the API
        // treats no elements given as "no filter" and still returns every
        // element's full content. Passing a codename that can never match a
        // real element (no content type uses `""` as a codename) makes the
        // API return each item with an empty elements object instead, which
        // is all we need since we only read item.system — this cuts response
        // payloads by ~90% in testing.
        query.elementsParameter(['""']);

  // Scoping to specific content types up front shrinks the crawl itself,
  // rather than fetching everything and discarding items client-side.
  if (typeCodenames && typeCodenames.length > 0) {
    query = query.types(typeCodenames);
  }

  let itemsSoFar = 0;
  const result = await unwrap(
    query.queryConfig({ cancelToken: cancelHandle }).toAllPromise({
      responseFetched: (response) => {
        itemsSoFar += response.data.items.length;
        onPage?.(itemsSoFar);
      },
    }),
  );

  return result.data.items.map((item) => ({
    id: item.system.id,
    name: item.system.name,
    codename: item.system.codename,
    type: item.system.type,
    collection: item.system.collection,
    language: item.system.language,
    lastModified: item.system.lastModified,
    workflowStep: item.system.workflowStep ?? undefined,
    workflow: item.system.workflow ?? undefined,
    elements: item.elements as ItemSystem["elements"],
  }));
}
