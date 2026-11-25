# Online giving: Stripe Checkout via Netlify Functions

**Status: reviewed and unit-tested. Not merged. No Stripe objects, webhook endpoints, or live configuration were created by this change. Production is the default branch; do not merge until giving is approved.**

Donors choose an amount (default **$1–$10,000**) as a **one-time** or **monthly** gift.
The browser never holds a Stripe key. It POSTs the amount to a Netlify Function, which
validates it and creates a **Stripe-hosted Checkout Session**. The browser then redirects
to that Stripe page. Card data never touches this site.

```
public/                     static site (publish directory)
  index.html                live page, plus the #give section wired to Checkout
  road-crew-field-guide.pdf
netlify/functions/
  create-checkout-session.mjs   POST -> { url }
  stripe-webhook.mjs            signed Stripe events
netlify/lib/                config, checkout, webhook, blobs store, HTTP helpers
test/                       node:test (Stripe mocked; no network, no live charges)
netlify.toml  package.json  .env.example (names only)
```

The published files are the current live page and Field Guide. `index.html` differs from
the pre-giving page only in the Give section (styles, markup, and the script that starts
Checkout and shows the return message).

## How it works

| Gift | Checkout `mode` | Price | Notes |
|---|---|---|---|
| One time | `payment` | inline `price_data`, USD, donor's amount | `submit_type: donate` |
| Monthly | `subscription` | inline `price_data` + `recurring.interval = month` | no trial; charged today, then monthly |

- No Products or Prices are pre-created. Checkout creates them from `price_data`.
- `payment_method_types` is not set, so Stripe uses dynamic payment methods from the Dashboard.
- `automatic_tax` is not enabled. This flow does not collect sales tax. Do not turn tax on
  until Stripe Tax is configured with an active registration in each jurisdiction; without
  that, Stripe collects no tax and returns no error. This site does not state that gifts
  are tax-deductible and does not state nonprofit status beyond the placeholder line that
  was already on the live page.
- Checkout collects the donor's email on Stripe's page. Receipts are Stripe's emails
  (Dashboard → Settings → Customer emails). This site stores no names, emails, or card data.
- Sessions are tagged `integration_identifier: fillingstation-give-qzkfwmrt` (8-letter suffix)
  so this flow can be compared in the Dashboard.
- Return URLs are always `SITE_URL/?donation=success#give` and `SITE_URL/?donation=cancel#give`.
  The page announces a thank-you, or that the donor was not charged, then drops the query
  string. The success page is not proof of payment. The webhook is the source of truth.
  If a browser drops the `#give` fragment, the `donation` query parameter still drives the message.
- SDK pin: `stripe@23.2.0`. API version pin: `2026-11-18.endive` (the version that SDK pins;
  the client sets it explicitly). `@netlify/blobs@11.1.11`.

### create-checkout-session

`POST /.netlify/functions/create-checkout-session`

```json
{"amount_cents": 5000, "frequency": "one_time", "currency": "usd", "idempotency_key": "<uuid>"}
```

Monthly also requires `"monthly_consent": true`. The checkbox on the page is required before
the browser will send that flag, and the function rejects a monthly gift without it.

Server-side checks, in order:

- POST only (405)
- `Origin` must be on the allowlist, and `Sec-Fetch-Site` must not be `cross-site` (403)
- about 10 requests per minute per IP per warm instance (429). This is a speed bump, not a guarantee.
- `Content-Type: application/json` (415) and body at most 1 KB (413)
- amount is a JSON integer inside the configured min/max (400)
- currency is decided by the server; a client value must match
- frequency is `one_time` or `monthly`
- `STRIPE_SECRET_KEY` must look like a restricted or secret key (`rk_` or `sk_`, test or live). A missing or publishable key returns 503 and does not call Stripe.
- `SITE_URL` must be an `https` origin. If it is missing, the function returns 503 and does not call Stripe. It does not fall back to the request origin.
- Idempotency key `give-<client uuid or a server uuid>-<frequency>-<amount>`, so a retried click reuses the session and a changed amount does not reuse a key with different parameters.
- The URL returned to the browser must start with `https://checkout.stripe.com/`.

Errors shown to the donor are generic. Logs contain the session id, or Stripe's error type, code, and request id. They do not contain the API key, the request body, or donor details.

Environment variables inside the functions are read with `Netlify.env.get`. `process.env` is only a fallback for local `node --test` and `npm run check`.

### stripe-webhook

`POST /.netlify/functions/stripe-webhook`

- Verifies `Stripe-Signature` against the **raw request bytes** with `STRIPE_WEBHOOK_SECRET` before parsing. A bad signature is 400.
- If the webhook secret or the API key is missing or the wrong shape, the function returns 500 (Stripe retries) and does not throw.
- Bodies over 512 KB are rejected.
- De-duplicates on `event.id` with Netlify Blobs (`onlyIfNew` on `events/<id>`). If processing throws, the claim is released and the function returns 500 so Stripe retries.
- Counting rules, safe if events arrive out of order:
  - one-time: one record per Checkout Session when `payment_status` is `paid` (`checkout.session.completed` or `checkout.session.async_payment_succeeded`)
  - monthly: one record per invoice from `invoice.paid` only, including the first invoice (`billing_reason: subscription_create`). `checkout.session.completed` in subscription mode is logged and not counted.
  - an `invoice.paid` whose subscription metadata `source` is present and is not `website_give_page` is ignored, so other products on the same Stripe account are not recorded. Invoices with no source metadata are still counted.
- Logged only (not counted): `checkout.session.async_payment_failed`, `invoice.payment_failed`, `customer.subscription.deleted`, `charge.refunded`, `charge.dispute.created`, `radar.early_fraud_warning.created`. Refunds, disputes, and fraud warnings are logged with the prefix `ATTENTION`.
- Stored fields: Stripe ids, amount, currency, livemode, timestamp, billing reason. No name, email, or card data.
- The `donations` blob store is site-wide, so production and deploy previews share it unless `DONATIONS_BLOB_STORE` is set differently per deploy context. These keys are idempotency markers, not a donor database.

## Environment variables

Set these in Netlify → Site configuration → Environment variables. Mark keys as secret. Scope secret values to Functions. Use a **sandbox** key for Deploy Previews and branch deploys, and a live key only in the Production context, and only after giving is approved.

| Name | Required | Default | Notes |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | yes | — | A **restricted key** (`rk_test_…` in sandbox, `rk_live_…` in production). See permissions below. A secret key (`sk_…`) also works; prefer the restricted key. |
| `STRIPE_WEBHOOK_SECRET` | yes | — | The `whsec_…` signing secret for the endpoint in the **same** mode (sandbox vs live). |
| `SITE_URL` | yes | — | `https://thefillingstationchurch.org` in production. Success and cancel URLs are built only from this value. For a deploy preview, set it to that preview's `https` origin if the thank-you message should appear on the preview. |
| `ALLOWED_ORIGINS` | no | — | Extra comma-separated origins, for example `https://www.thefillingstationchurch.org`. Netlify's `URL`, `DEPLOY_PRIME_URL`, and `DEPLOY_URL` are added automatically. |
| `DONATION_CURRENCY` | no | `usd` | Only `usd` is supported. Anything else makes checkout return 503. |
| `DONATION_MIN_CENTS` | no | `100` | $1.00. If you change it, also change `GIVE_MIN` and the hint in `public/index.html`. |
| `DONATION_MAX_CENTS` | no | `1000000` | $10,000.00. Also change `GIVE_MAX` and the hint. |
| `DONATION_PRODUCT_NAME` / `DONATION_MONTHLY_PRODUCT_NAME` | no | "Gift to The Filling Station" / "Monthly gift to The Filling Station" | Shown on Checkout and receipts. |
| `DONATIONS_BLOB_STORE` | no | `donations` | Blob store name. Use a different name on deploy previews if test records should stay out of the production store. |
| `ALLOW_LOCALHOST` | no | unset | Set to `true` only for local `netlify dev`. Never in production. |

Suggested restricted-key permissions (Write includes Read). Start in a sandbox:

- Checkout Sessions: Write
- Prices: Write (Dashboard may label this Prices or Plans; inline `price_data` needs it)
- Products: Write
- Customers: Write
- Subscriptions: Write (monthly gifts)

Webhook verification uses the signing secret locally and does not call the Stripe API. If a sandbox request returns a permissions error, add only the permission named in that error. Confirm the final set against the key's request logs before creating the live key.

There is no secrets vault on Netlify beyond sensitive environment variables. Mark `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` secret, use a different key per deploy context, and add an [IP access policy](https://docs.stripe.com/keys.md#access-policies) on each key. Never put keys in git, in `netlify.toml`, in client code, or in function logs.

## Sandbox and live

Use a Stripe [sandbox](https://docs.stripe.com/sandboxes) for this new integration, not the account's shared test mode. Sandboxes keep test data and settings away from live mode. Use one sandbox for the deploy preview and do not point it at live keys.

- Deploy Preview / branch deploys: sandbox restricted key + that sandbox's webhook signing secret.
- Production: live restricted key + the live endpoint's signing secret, only after approval.
- Separate webhook endpoints per environment. A sandbox endpoint should target the preview URL. A live endpoint should target production.
- Do not run test cards against the live account. Stored records include `livemode`.

## Webhook events to subscribe

Add the endpoint in the sandbox Dashboard first (Developers → Webhooks → Add destination). URL:

`https://<preview-or-site-host>/.netlify/functions/stripe-webhook`

Events:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `invoice.paid`
- `invoice.payment_failed`
- `customer.subscription.deleted`
- `charge.refunded`
- `charge.dispute.created`
- `radar.early_fraud_warning.created`

Copy that endpoint's signing secret into `STRIPE_WEBHOOK_SECRET` for the matching deploy context and redeploy so the function picks it up.

For a local check only: `stripe listen --forward-to localhost:8888/.netlify/functions/stripe-webhook` prints its own `whsec_` value. This repository does not create the endpoint.

Optional defense in depth: Netlify can allowlist [Stripe's webhook IP addresses](https://docs.stripe.com/ips.md) on this path. Signature verification remains the control that decides whether an event is processed.

## Sandbox test plan

No live keys and no real cards. Use the deploy preview after sandbox env vars are set. Until those vars exist, the Give button should show "Online giving is temporarily unavailable" and must not open Checkout.

| # | Case | How | Expect |
|---|---|---|---|
| 1 | One-time success | $25 one time, card `4242 4242 4242 4242`, any future date, any CVC | Redirect to `/?donation=success#give` with the thank-you message. Webhook log contains `one-time paid`. One Blobs record `gifts/session_…`. |
| 2 | Decline | card `4000 0000 0000 0002` | Error on Checkout. No gift record. |
| 3 | 3D Secure | card `4000 0027 6000 3184` | Complete the challenge (success path) and fail it (no gift record) as two tries. |
| 4 | Cancel | Back on Checkout | "Gift cancelled" and "You weren't charged." No gift record. |
| 5 | Amount bounds | $1.00 and $10,000.00 succeed. $0.99, $10,000.01, `abc`, and `25.555` are stopped in the browser. A crafted POST outside the range is 400. | |
| 6 | Monthly consent | Choose Monthly and press Give with the box unchecked. | Focus moves to the checkbox and no request is sent. A POST without `monthly_consent: true` is 400 and creates no session. |
| 7 | Monthly signup | $15 monthly, check the box, card `4242…` | Subscription, no trial. First `invoice.paid` stored once (`subscription_create`). Checkout completion is not counted. |
| 8 | Duplicate webhook | Resend the event from the Dashboard, or `stripe events resend evt_…` | Response includes `duplicate: true`. Still one gift record. |
| 9 | Bad signature | `curl -X POST …/stripe-webhook -H 'stripe-signature: t=1,v1=bad' -d '{}'` | 400. Nothing stored. |
| 10 | Monthly renewal | Test clock (Billing → Test clocks), advance one month | Second `invoice.paid` (`subscription_cycle`) stored. |
| 11 | Monthly failure | On that test clock, set the card to `4000 0000 0000 0341`, advance one month | `invoice.payment_failed` logged. Stripe Smart Retries follow Dashboard settings. |
| 12 | Cancel subscription | Cancel it in the Dashboard | `customer.subscription.deleted` logged. |
| 13 | Origin | `curl -X POST …/create-checkout-session -H 'origin: https://evil.example' -H 'content-type: application/json' -d '{"amount_cents":500,"frequency":"one_time"}'` | 403. No session. |
| 14 | Double-click | Press Give twice, or retry after a network error | The button disables. The same idempotency key reuses the session. |
| 15 | Missing env | Open the preview before vars are set and press Give | Message that giving is unavailable. No Checkout page. Function does not throw. |

Automated: `npm ci && npm test && npm run check` (48 tests). Tests mock Stripe and do not make network calls.

## Rollback

This branch is not merged. The default branch stays the live site, and Netlify production keeps publishing that branch.

- To drop this work: close the pull request. Do not merge it.
- If a deploy preview was published to production by mistake: in Netlify, open Deploys and publish the previous production deploy (the one built from the default branch before this change). That restores the current live page. Functions from the donations deploy stop being served.
- If a webhook endpoint was created, disable it in the Stripe Dashboard. Leaving it in place only produces delivery failures after the function is gone.
- Monthly subscriptions that were already created keep billing inside Stripe. Cancel or pause them in the Dashboard if giving must stop. Removing the site does not cancel them.

## Notes for later

- Cancellation copy on the page and on Checkout says "contact us." A real email or phone, or Stripe's Customer Portal, can replace that when one is chosen. Neither is invented here.
- One-time gifts use Checkout's guest flow (no `customer_creation: 'always'`). Turn that on later if a Customer object is needed for year-end statements.
- The page has inline scripts and loads Google Fonts. A Content-Security-Policy header was not added, because a strict policy would block the current page. Hosted Checkout does not load Stripe.js on this origin. Add a CSP in a separate change after it is tested against the live page.
- No street or mailing address was added. The check-by-mail line still says the mailing address is coming soon. The Canton crew listing still says "Contact for info," which is what the live page already says.
