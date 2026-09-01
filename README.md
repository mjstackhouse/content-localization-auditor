# Content Localization Auditor

A browser-based tool for auditing content localization coverage in a [Kontent.ai](https://kontent.ai/) environment. Point it at an environment and it reports which content items are missing variants in which languages, then exports the results to CSV.

It runs entirely in your browser — there's no backend and no data is sent anywhere except directly to Kontent.ai's Delivery API. You can use it [hosted on Netlify](#deploying) or run it locally.

## What it does

1. You provide a Kontent.ai **Environment ID** and, if needed, a **Delivery API key**.
2. It fetches every language configured in the environment and detects the environment's actual default language.
3. It crawls every content item in every language (via the [Enumerate content items](https://kontent.ai/learn/docs/apis/delivery-api/content-items#enumerate-content-items) endpoint, so results stay consistent even on a large, actively-edited environment).
4. For every item found in *any* language, it builds one row showing that item's status — the actual workflow step (`published`, `draft`, etc.) or `Missing` — in every language.
5. It exports the result as a CSV, downloaded automatically when the crawl finishes.

By default, only items with at least one missing language variant are included — uncheck "Only export items with at least one missing translation" to export the full coverage matrix for every item instead.

## Do you need a Delivery API key?

Leave it blank if your environment does **not** have [Secure Access](https://kontent.ai/learn/docs/security/secure-access) enabled — you'll get published content only.

If Secure Access **is** enabled (common for most Kontent.ai customers), a key is required. Create or use a Delivery API key with:

- **Secure access** enabled — required to reach published content at all when Secure Access is on.
- **Content preview** enabled — this tool always requests preview content so it can include unpublished/draft variants in the audit.

The key is kept in memory only for the duration of the session and is never stored, logged, or sent anywhere other than Kontent.ai's own API.

## Using the app

1. Enter your **Environment ID** (found under Environment settings, or in the `app.kontent.ai/<environment-id>` URL).
2. Enter your **Delivery API key**, if required (see above).
3. Choose whether to export only incomplete items or the full matrix.
4. Click **Export report**. Progress for each language is shown live below the form.
5. The CSV downloads automatically when it's done. If your browser blocks it, or you toggle the checkbox afterward and want a re-filtered file, use the **Download CSV** button.

## Deploying

If you'd like to deploy and host your own copy, Netlify makes this easy — the button below walks you through it and leaves you with a copy of the repository in your own GitHub account.

[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/mjstackhouse/content-localization-auditor)

## Running locally

```bash
npm install
npm run dev
```

Then open the local URL Vite prints (typically `http://localhost:5173`).

To build a static production bundle:

```bash
npm run build
```

The output goes to `dist/` and can be hosted on any static file host.
