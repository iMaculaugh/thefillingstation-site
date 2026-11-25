// Core logic for creating a Stripe-hosted Checkout Session for a donation.
// Kept free of Netlify globals so it can be unit tested with mocks.

import { randomUUID } from 'node:crypto';
import { json, MESSAGES, readLimitedText, createRateLimiter } from './http.mjs';
import { isStripeSecretKey } from './config.mjs';

export const MAX_BODY_BYTES = 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FREQUENCIES = new Set(['one_time', 'monthly']);
const CHECKOUT_URL = /^https:\/\/checkout\.stripe\.com\//;

// Stable label so this flow can be compared in the Stripe Dashboard.
// The suffix is 8 letters, as Stripe asks for on integration_identifier.
export const INTEGRATION_IDENTIFIER = 'fillingstation-give-qzkfwmrt';

export function formatUsd(cents) {
  return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Validate the parsed JSON body. Returns { ok: true, value } or { ok: false, status, error }.
export function validateDonation(body, config) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, status: 400, error: MESSAGES.badRequest };
  }
  const { amount_cents: amount, frequency, currency, idempotency_key: key, monthly_consent: consent } = body;

  if (typeof frequency !== 'string' || !FREQUENCIES.has(frequency)) {
    return { ok: false, status: 400, error: MESSAGES.frequency };
  }
  // JSON number that is a safe integer: rejects "5000", 50.5, NaN, 1e400, etc.
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount)) {
    return { ok: false, status: 400, error: MESSAGES.amount };
  }
  if (amount < config.minCents || amount > config.maxCents) {
    return { ok: false, status: 400, error: MESSAGES.amount };
  }
  // The server decides the currency. A client may echo it, but it must match.
  if (currency !== undefined && (typeof currency !== 'string' || currency.toLowerCase() !== config.currency)) {
    return { ok: false, status: 400, error: MESSAGES.badRequest };
  }
  if (key !== undefined && (typeof key !== 'string' || !UUID_RE.test(key))) {
    return { ok: false, status: 400, error: MESSAGES.badRequest };
  }
  if (frequency === 'monthly' && consent !== true) {
    return { ok: false, status: 400, error: MESSAGES.consent };
  }
  return { ok: true, value: { amountCents: amount, frequency, clientKey: key || null } };
}

export function buildSessionParams({ amountCents, frequency }, config, baseUrl) {
  const monthly = frequency === 'monthly';
  const base = baseUrl.replace(/\/+$/, '');
  const metadata = { source: 'website_give_page', frequency };

  const priceData = {
    currency: config.currency,
    unit_amount: amountCents,
    product_data: { name: monthly ? config.monthlyProductName : config.productName },
  };
  if (monthly) priceData.recurring = { interval: 'month', interval_count: 1 };

  const params = {
    mode: monthly ? 'subscription' : 'payment',
    line_items: [{ price_data: priceData, quantity: 1 }],
    success_url: `${base}/?donation=success#give`,
    cancel_url: `${base}/?donation=cancel#give`,
    integration_identifier: INTEGRATION_IDENTIFIER,
    metadata,
    // Hosted Checkout collects the donor email. This site does not.
    // payment_method_types is omitted on purpose (dynamic payment methods).
    // automatic_tax is omitted on purpose (no tax collection in this flow).
  };

  if (monthly) {
    // No trial: the first gift is charged today, then monthly until cancelled.
    params.subscription_data = { description: 'Monthly gift', metadata };
    params.custom_text = {
      submit: {
        message:
          `You're giving ${formatUsd(amountCents)} every month. You'll be charged today and then monthly ` +
          'until you cancel. To cancel or change your gift, contact us.',
      },
    };
  } else {
    params.submit_type = 'donate';
    params.payment_intent_data = { description: 'One-time gift', metadata };
  }
  return params;
}

function clientIp(req, context) {
  return (
    (context && context.ip) ||
    req.headers.get('x-nf-client-connection-ip') ||
    (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    'unknown'
  );
}

export function createCheckoutHandler({ config, getStripe, rateLimiter = createRateLimiter(), logger = console }) {
  return async function handler(req, context) {
    if (req.method !== 'POST') {
      return json(405, { error: MESSAGES.method }, { allow: 'POST' });
    }

    const origin = req.headers.get('origin');
    if (!origin || !config.allowedOrigins.has(origin)) {
      return json(403, { error: MESSAGES.origin });
    }
    const fetchSite = req.headers.get('sec-fetch-site');
    if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'same-site') {
      return json(403, { error: MESSAGES.origin });
    }

    if (!rateLimiter(clientIp(req, context))) {
      return json(429, { error: MESSAGES.rateLimited }, { 'retry-after': '60' });
    }

    const ctype = (req.headers.get('content-type') || '').toLowerCase();
    if (!ctype.startsWith('application/json')) {
      return json(415, { error: MESSAGES.badRequest });
    }

    const { text, tooLarge } = await readLimitedText(req, MAX_BODY_BYTES);
    if (tooLarge) return json(413, { error: MESSAGES.tooLarge });

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return json(400, { error: MESSAGES.badRequest });
    }

    if (!config.currencySupported) {
      logger.error('[donations] misconfigured currency');
      return json(503, { error: MESSAGES.unavailable });
    }
    const result = validateDonation(body, config);
    if (!result.ok) return json(result.status, { error: result.error });

    // Missing or unusable config must fail before any Stripe call.
    if (!isStripeSecretKey(config.stripeSecretKey)) {
      logger.error('[donations] stripe key missing or not a restricted/secret key');
      return json(503, { error: MESSAGES.unavailable });
    }
    if (!config.siteUrl) {
      logger.error('[donations] SITE_URL missing or not an https origin');
      return json(503, { error: MESSAGES.unavailable });
    }

    const params = buildSessionParams(result.value, config, config.siteUrl);
    // Key covers the client attempt AND the validated parameters, so a retry of
    // the same click reuses the same session, while a changed amount never
    // collides with an earlier key (Stripe rejects key reuse with new params).
    const attempt = result.value.clientKey || randomUUID();
    const idempotencyKey = `give-${attempt}-${result.value.frequency}-${result.value.amountCents}`;

    try {
      const stripe = getStripe();
      const session = await stripe.checkout.sessions.create(params, { idempotencyKey });
      if (!session || typeof session.url !== 'string' || !CHECKOUT_URL.test(session.url)) {
        logger.error('[donations] checkout session missing a Stripe-hosted url', session && session.id);
        return json(502, { error: MESSAGES.generic });
      }
      logger.info('[donations] checkout session created', session.id, result.value.frequency);
      return json(200, { url: session.url });
    } catch (err) {
      // Type, code, and request id only. Never the key, body, message, or donor data.
      logger.error('[donations] stripe error', err && err.type, err && err.code, err && err.requestId);
      return json(502, { error: MESSAGES.generic });
    }
  };
}
