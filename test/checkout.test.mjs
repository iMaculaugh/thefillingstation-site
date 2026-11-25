import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, runtimeEnv, isStripeSecretKey } from '../netlify/lib/config.mjs';
import { createCheckoutHandler, validateDonation, buildSessionParams, MAX_BODY_BYTES } from '../netlify/lib/checkout.mjs';
import { createRateLimiter } from '../netlify/lib/http.mjs';

const SITE = 'https://thefillingstationchurch.org';
// Obviously not a real key. Shape matches a restricted key so validation can run offline.
const baseEnv = { STRIPE_SECRET_KEY: 'rk_test_placeholder', SITE_URL: SITE };
const quiet = { info() {}, warn() {}, error() {} };

function mockStripe({ fail = false, url = 'https://checkout.stripe.com/c/pay/cs_test_123' } = {}) {
  const calls = [];
  return {
    calls,
    checkout: {
      sessions: {
        async create(params, opts) {
          calls.push({ params, opts });
          if (fail) { const e = new Error('boom SECRET-shouldnotleak'); e.type = 'StripeAPIError'; throw e; }
          return { id: 'cs_test_123', url };
        },
      },
    },
  };
}

function setup({ env = {}, stripe = mockStripe(), limiter, logger = quiet } = {}) {
  const config = loadConfig({ ...baseEnv, ...env });
  const handler = createCheckoutHandler({ config, getStripe: () => stripe, rateLimiter: limiter || createRateLimiter({ limit: 1000 }), logger });
  return { handler, stripe, config };
}

function post(body, { origin = SITE, headers = {}, method = 'POST', raw } = {}) {
  const h = { 'content-type': 'application/json', ...headers };
  if (origin) h.origin = origin;
  return new Request(`${SITE}/.netlify/functions/create-checkout-session`, {
    method, headers: h, body: method === 'GET' ? undefined : raw !== undefined ? raw : JSON.stringify(body),
  });
}

const UUID = '3f1c2b9e-8d4a-4f6b-9c2d-1a2b3c4d5e6f';

describe('amount validation', () => {
  const config = loadConfig(baseEnv);
  const ok = (amount_cents) => validateDonation({ amount_cents, frequency: 'one_time' }, config).ok;
  test('accepts min and max edges', () => {
    assert.equal(ok(100), true);
    assert.equal(ok(1_000_000), true);
  });
  test('rejects just outside edges', () => {
    assert.equal(ok(99), false);
    assert.equal(ok(1_000_001), false);
  });
  test('rejects zero, negative, fractional, string, NaN, huge, missing', () => {
    for (const v of [0, -500, 100.5, '5000', NaN, Infinity, 1e20, null, undefined, true, [5000]]) {
      assert.equal(ok(v), false, `should reject ${String(v)}`);
    }
  });
  test('limits are env-configurable', () => {
    const c = loadConfig({ ...baseEnv, DONATION_MIN_CENTS: '500', DONATION_MAX_CENTS: '2000' });
    assert.equal(validateDonation({ amount_cents: 499, frequency: 'monthly', monthly_consent: true }, c).ok, false);
    assert.equal(validateDonation({ amount_cents: 500, frequency: 'monthly', monthly_consent: true }, c).ok, true);
    assert.equal(validateDonation({ amount_cents: 2001, frequency: 'monthly', monthly_consent: true }, c).ok, false);
  });
  test('bad env limits fall back to defaults', () => {
    const c = loadConfig({ ...baseEnv, DONATION_MIN_CENTS: 'abc', DONATION_MAX_CENTS: '-1' });
    assert.equal(c.minCents, 100);
    assert.equal(c.maxCents, 1_000_000);
    const swapped = loadConfig({ ...baseEnv, DONATION_MIN_CENTS: '5000', DONATION_MAX_CENTS: '100' });
    assert.equal(swapped.minCents, 100);
  });
});

describe('currency and frequency', () => {
  const config = loadConfig(baseEnv);
  test('USD default; matching client currency accepted, other rejected', () => {
    assert.equal(config.currency, 'usd');
    assert.equal(validateDonation({ amount_cents: 500, frequency: 'one_time', currency: 'USD' }, config).ok, true);
    assert.equal(validateDonation({ amount_cents: 500, frequency: 'one_time', currency: 'eur' }, config).ok, false);
  });
  test('unsupported configured currency returns 503', async () => {
    const { handler, stripe } = setup({ env: { DONATION_CURRENCY: 'jpy' } });
    const res = await handler(post({ amount_cents: 500, frequency: 'one_time' }));
    assert.equal(res.status, 503);
    assert.equal(stripe.calls.length, 0);
  });
  test('frequency must be one_time or monthly', () => {
    for (const f of ['once', 'weekly', '', null, undefined, 1]) {
      assert.equal(validateDonation({ amount_cents: 500, frequency: f }, config).ok, false);
    }
  });
  test('monthly requires an explicit consent flag; one-time does not', () => {
    assert.equal(validateDonation({ amount_cents: 500, frequency: 'monthly' }, config).ok, false);
    assert.equal(validateDonation({ amount_cents: 500, frequency: 'monthly', monthly_consent: false }, config).ok, false);
    assert.equal(validateDonation({ amount_cents: 500, frequency: 'monthly', monthly_consent: true }, config).ok, true);
    assert.equal(validateDonation({ amount_cents: 500, frequency: 'one_time' }, config).ok, true);
  });
});

describe('session params', () => {
  const config = loadConfig(baseEnv);
  test('one-time -> payment mode with inline price_data, no recurring', () => {
    const p = buildSessionParams({ amountCents: 2500, frequency: 'one_time' }, config, SITE);
    assert.equal(p.mode, 'payment');
    assert.equal(p.submit_type, 'donate');
    assert.deepEqual(p.line_items[0].price_data.currency, 'usd');
    assert.equal(p.line_items[0].price_data.unit_amount, 2500);
    assert.equal(p.line_items[0].price_data.recurring, undefined);
    assert.equal(p.line_items[0].quantity, 1);
    assert.equal(p.subscription_data, undefined);
    assert.equal(p.success_url, `${SITE}/?donation=success#give`);
    assert.equal(p.cancel_url, `${SITE}/?donation=cancel#give`);
    assert.equal('payment_method_types' in p, false);
    assert.equal('automatic_tax' in p, false);
    assert.equal('billing_address_collection' in p, false);
    assert.equal('customer_email' in p, false);
    assert.match(p.integration_identifier, /[a-z]{8}$/);
  });
  test('monthly -> subscription mode, monthly recurring, no trial, consent text', () => {
    const p = buildSessionParams({ amountCents: 1234, frequency: 'monthly' }, config, SITE);
    assert.equal(p.mode, 'subscription');
    assert.deepEqual(p.line_items[0].price_data.recurring, { interval: 'month', interval_count: 1 });
    assert.equal(p.line_items[0].price_data.unit_amount, 1234);
    assert.equal(p.subscription_data.trial_period_days, undefined);
    assert.equal(p.subscription_data.trial_end, undefined);
    assert.equal(p.payment_intent_data, undefined);
    assert.match(p.custom_text.submit.message, /\$12\.34 every month/);
    assert.match(p.custom_text.submit.message, /until you cancel/);
    assert.doesNotMatch(JSON.stringify(p), /tax[- ]deductible|501\(c\)/i);
  });
});

describe('handler', () => {
  test('creates a session and returns only the url', async () => {
    const { handler, stripe } = setup();
    const res = await handler(post({ amount_cents: 5000, frequency: 'one_time', idempotency_key: UUID }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { url: 'https://checkout.stripe.com/c/pay/cs_test_123' });
    assert.equal(stripe.calls.length, 1);
    assert.equal(stripe.calls[0].opts.idempotencyKey, `give-${UUID}-one_time-5000`);
  });
  test('monthly request uses subscription mode', async () => {
    const { handler, stripe } = setup();
    const res = await handler(post({ amount_cents: 2500, frequency: 'monthly', monthly_consent: true }));
    assert.equal(res.status, 200);
    assert.equal(stripe.calls[0].params.mode, 'subscription');
  });
  test('monthly without consent does not create a session', async () => {
    const { handler, stripe } = setup();
    const res = await handler(post({ amount_cents: 2500, frequency: 'monthly' }));
    assert.equal(res.status, 400);
    assert.equal(stripe.calls.length, 0);
  });
  test('idempotency: same client key + params -> same key; new attempt -> different key', async () => {
    const { handler, stripe } = setup();
    await handler(post({ amount_cents: 5000, frequency: 'one_time', idempotency_key: UUID }));
    await handler(post({ amount_cents: 5000, frequency: 'one_time', idempotency_key: UUID }));
    await handler(post({ amount_cents: 7500, frequency: 'one_time', idempotency_key: UUID }));
    await handler(post({ amount_cents: 5000, frequency: 'one_time' }));
    await handler(post({ amount_cents: 5000, frequency: 'one_time' }));
    const keys = stripe.calls.map((c) => c.opts.idempotencyKey);
    assert.equal(keys[0], keys[1]);
    assert.notEqual(keys[0], keys[2]);
    assert.notEqual(keys[3], keys[4]);
    assert.match(keys[3], /^give-[0-9a-f-]{36}-one_time-5000$/);
  });
  test('rejects malformed idempotency key', async () => {
    const { handler, stripe } = setup();
    const res = await handler(post({ amount_cents: 5000, frequency: 'one_time', idempotency_key: 'not-a-uuid' }));
    assert.equal(res.status, 400);
    assert.equal(stripe.calls.length, 0);
  });
  test('rejects non-POST methods', async () => {
    const { handler } = setup();
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const res = await handler(post({}, { method }));
      assert.equal(res.status, 405);
      assert.equal(res.headers.get('allow'), 'POST');
    }
  });
  test('rejects missing or foreign origin', async () => {
    const { handler, stripe } = setup();
    assert.equal((await handler(post({ amount_cents: 500, frequency: 'one_time' }, { origin: null }))).status, 403);
    assert.equal((await handler(post({ amount_cents: 500, frequency: 'one_time' }, { origin: 'https://evil.example' }))).status, 403);
    assert.equal((await handler(post({ amount_cents: 500, frequency: 'one_time' }, { origin: 'http://thefillingstationchurch.org' }))).status, 403);
    assert.equal((await handler(post({ amount_cents: 500, frequency: 'one_time' }, { headers: { 'sec-fetch-site': 'cross-site' } }))).status, 403);
    assert.equal(stripe.calls.length, 0);
  });
  test('Netlify deploy-preview origin allowed; redirect still uses SITE_URL', async () => {
    const preview = 'https://deploy-preview-1--vocal-fenglisu-ae8395.netlify.app';
    const { handler, stripe } = setup({ env: { DEPLOY_PRIME_URL: preview } });
    const res = await handler(post({ amount_cents: 500, frequency: 'one_time' }, { origin: preview }));
    assert.equal(res.status, 200);
    assert.ok(stripe.calls[0].params.success_url.startsWith(SITE));
  });
  test('without SITE_URL, refuses before creating a session', async () => {
    const other = 'https://www.thefillingstationchurch.org';
    const { handler, stripe } = setup({ env: { SITE_URL: '', ALLOWED_ORIGINS: other } });
    const res = await handler(post({ amount_cents: 500, frequency: 'one_time' }, { origin: other }));
    assert.equal(res.status, 503);
    assert.equal(stripe.calls.length, 0);
    assert.match((await res.json()).error, /unavailable/i);
  });
  test('http localhost SITE_URL is ignored unless ALLOW_LOCALHOST=true', () => {
    assert.equal(loadConfig({ ...baseEnv, SITE_URL: 'http://localhost:8888' }).siteUrl, null);
    assert.equal(loadConfig({ ...baseEnv, SITE_URL: 'http://127.0.0.1:8888' }).siteUrl, null);
    assert.equal(loadConfig({ ...baseEnv, SITE_URL: 'http://[::1]:8888' }).siteUrl, null);
    assert.equal(loadConfig({ ...baseEnv, SITE_URL: 'http://localhost:8888', ALLOW_LOCALHOST: 'true' }).siteUrl, 'http://localhost:8888');
  });
  test('localhost only allowed when ALLOW_LOCALHOST=true', async () => {
    const local = 'http://localhost:8888';
    const a = setup({ env: { ALLOWED_ORIGINS: local } });
    assert.equal((await a.handler(post({ amount_cents: 500, frequency: 'one_time' }, { origin: local }))).status, 403);
    const b = setup({ env: { ALLOWED_ORIGINS: local, ALLOW_LOCALHOST: 'true' } });
    assert.equal((await b.handler(post({ amount_cents: 500, frequency: 'one_time' }, { origin: local }))).status, 200);
  });
  test('rejects oversized bodies, wrong content-type and bad JSON', async () => {
    const { handler, stripe } = setup();
    const big = JSON.stringify({ amount_cents: 500, frequency: 'one_time', pad: 'x'.repeat(MAX_BODY_BYTES) });
    assert.equal((await handler(post(null, { raw: big }))).status, 413);
    assert.equal((await handler(post(null, { raw: '{"amount_cents":500', }))).status, 400);
    assert.equal((await handler(post(null, { raw: 'amount_cents=500', headers: { 'content-type': 'application/x-www-form-urlencoded' } }))).status, 415);
    assert.equal(stripe.calls.length, 0);
  });
  test('rate limiter returns 429 after the limit', async () => {
    const { handler } = setup({ limiter: createRateLimiter({ limit: 2 }) });
    const r = [];
    for (let i = 0; i < 3; i++) r.push((await handler(post({ amount_cents: 500, frequency: 'one_time' }))).status);
    assert.deepEqual(r, [200, 200, 429]);
  });
  test('rate limiter drops expired buckets before they pile up', () => {
    let t = 0;
    const allow = createRateLimiter({ limit: 5, windowMs: 1000, now: () => t });
    for (let i = 0; i < 300; i++) allow(`ip-${i}`);
    assert.equal(allow.size(), 300);
    t = 1000;
    assert.equal(allow('someone-new'), true);
    assert.equal(allow.size(), 1);
  });
  test('missing or publishable key -> 503 generic, no Stripe call', async () => {
    for (const key of ['', 'pk_test_placeholder', 'sk_live_', 'not-a-key']) {
      const { handler, stripe } = setup({ env: { STRIPE_SECRET_KEY: key } });
      const res = await handler(post({ amount_cents: 500, frequency: 'one_time' }));
      assert.equal(res.status, 503, key);
      assert.equal(stripe.calls.length, 0);
      assert.doesNotMatch(await res.text(), /pk_|sk_|rk_|placeholder/);
    }
    assert.equal(isStripeSecretKey('rk_test_placeholder'), true);
    assert.equal(isStripeSecretKey('sk_live_placeholder'), true);
  });
  test('a non-Stripe session url is not returned to the browser', async () => {
    const { handler } = setup({ stripe: mockStripe({ url: 'https://evil.example/phish' }) });
    const res = await handler(post({ amount_cents: 500, frequency: 'one_time' }));
    assert.equal(res.status, 502);
    assert.doesNotMatch(await res.text(), /evil\.example/);
  });
  test('Stripe failure -> 502 generic message, nothing sensitive leaked or logged', async () => {
    const logged = [];
    const logger = { info() {}, warn() {}, error: (...a) => logged.push(a.join(' ')) };
    const { handler } = setup({ stripe: mockStripe({ fail: true }), logger });
    const res = await handler(post({ amount_cents: 500, frequency: 'one_time' }));
    assert.equal(res.status, 502);
    const text = await res.text();
    assert.doesNotMatch(text, /SECRET|boom|Stripe/);
    assert.doesNotMatch(logged.join('\n'), /SECRET|boom|rk_test_placeholder/);
  });
});

describe('runtime env', () => {
  test('Netlify.env is preferred over process.env', () => {
    const prev = globalThis.Netlify;
    const prevKey = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = 'sk_test_fromprocessenv';
    globalThis.Netlify = {
      env: {
        get(name) {
          return name === 'STRIPE_SECRET_KEY' ? 'rk_test_fromnetlifyenv' : undefined;
        },
      },
    };
    try {
      assert.equal(runtimeEnv().STRIPE_SECRET_KEY, 'rk_test_fromnetlifyenv');
    } finally {
      if (prev === undefined) delete globalThis.Netlify;
      else globalThis.Netlify = prev;
      if (prevKey === undefined) delete process.env.STRIPE_SECRET_KEY;
      else process.env.STRIPE_SECRET_KEY = prevKey;
    }
  });
});
