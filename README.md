# Content Localization Auditor

A tool for auditing content localization coverage in a [Kontent.ai](https://kontent.ai/) environment. Point it at an environment and it reports which content items are missing variants in which languages, then exports the results to CSV. It can run standalone in any browser, or be installed as a [Kontent.ai custom app](https://kontent.ai/learn/docs/custom-apps).

It runs entirely client-side — there's no backend and no data is sent anywhere except directly to Kontent.ai's Delivery API. Use it [hosted on Netlify](#deploying), run it locally, or install it as a custom app (see below).

## What it does

1. You provide a Kontent.ai **Environment ID** and, if needed, a **Delivery API key** — both can be skipped when running as a custom app (see below).
2. It fetches every language and content type configured in the environment, and detects the environment's actual default language.
3. You choose which content types to include, and whether to only export items with at least one missing translation.
4. It retrieves every selected content item in every language (via the [Enumerate content items](https://kontent.ai/learn/docs/apis/delivery-api/content-items#enumerate-content-items) endpoint, so results stay consistent even on a large, actively-edited environment).
5. For every item found in *any* language, it builds one row showing that item's status — the actual workflow step (`published`, `draft`, etc.) or `Missing` — in every language.
6. It exports the result as a CSV, downloaded automatically once it's finished.

## Do you need a Delivery API key?

Leave it blank if your environment does **not** have [Secure Access](https://kontent.ai/learn/docs/security/secure-access) enabled — you'll get published content only.

If Secure Access **is** enabled (common for most Kontent.ai customers), a key is required, with **Secure access** permission enabled on it.

By default, this tool only scans **published** content — matching what's actually live today, and keeping the key's permission requirements minimal. Check "Include unpublished content" if you also want to see in-progress translations that haven't been published yet; the key then additionally needs **Content preview** permission.

The key is kept in memory only for the duration of the session and is never stored, logged, or sent anywhere other than Kontent.ai's own API.

## Using the app

1. Enter your **Environment ID** (found under Environment settings, or in the `app.kontent.ai/<environment-id>` URL) and your **Delivery API key**, if required (see above). Click **Continue**.
2. Choose which **content types** to include (all are selected by default) and your export options, then click **Export report**. Progress for each language is shown live below.
3. The CSV downloads automatically when it's done. If your browser blocks it, or you change the selection afterward and want a re-filtered file, use the **Download CSV** button.

## Running as a Kontent.ai Custom App

This tool can also be installed as a [custom app](https://kontent.ai/learn/docs/custom-apps) inside Kontent.ai itself (Environment settings → Custom apps), pointed at wherever you've deployed it. Running this way changes a couple of things:

- The **Environment ID** is detected automatically from the custom app context, so that field doesn't appear at all.
- The **Advanced settings** speed picker shown in standalone mode is hidden in favor of a value read from the custom app's own configuration (see below) — a setting an admin sets once, rather than something every person running an audit needs to understand.
- If you add a Delivery API key to the configuration (see below), the **Delivery API key** field doesn't appear either — otherwise it works the same as standalone mode.

### Configuring the Custom App

This custom app requires no JSON parameters, so the parameters field can be left empty.

But, if you'd like to add your Delivery API key to the configuration so users don't have to enter it every time, you can do that like so:

```json
{
  "deliveryKey": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...."
}
```

The key needs 'Secure access' permission if your environment has Secure Access enabled, and 'Content preview' permission if you also want users to be able to check "Include unpublished content." Adding the key to your configuration will technically expose it to any roles allowed to use the custom app (if they go looking for it), so this is ultimately up to whoever configures the custom app — the same tradeoff as in the [export tool](https://github.com/mjstackhouse/export-tool#configuring-the-custom-app), which uses the same `deliveryKey` config name for consistency.

You can also control the delay this tool waits between requests:

```json
{
  "requestDelayMs": 300
}
```

This is the minimum time, in milliseconds, between the start of any two requests this tool makes. It exists because Kontent.ai's Delivery API rate limit is shared with everything else hitting your environment — including your live site's own traffic — not just this tool's own requests. If omitted, it defaults to `150`.

Rather than guess a number, you can use the same tiers the standalone version's "Retrieval speed" picker offers:

| Standalone label | `requestDelayMs` |
|---|---|
| Very cautious — for high-traffic sites | `700` |
| Cautious — for busier sites | `350` |
| Normal (recommended, and the default if omitted) | `150` |
| Fastest — no delay (use with caution) | `0` |

Both settings can be combined in the same configuration object.

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
