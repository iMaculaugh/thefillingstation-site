import { test } from 'node:test';
import assert from 'node:assert/strict';

// The real function modules read env at import time. Give them a public origin
// Netlify would inject, and no secrets, then confirm they refuse without charging.
test('checkout function fails closed when secrets and SITE_URL are missing', async () => {
  const prevUrl = process.env.URL;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.SITE_URL;
  process.env.URL = 'https://thefillingstationchurch.org';
  try {
    const { default: handler } = await import('../netlify/functions/create-checkout-session.mjs');
    const res = await handler(new Request('https://thefillingstationchurch.org/.netlify/functions/create-checkout-session', {
      method: 'POST',
      headers: { origin: 'https://thefillingstationchurch.org', 'content-type': 'application/json' },
      body: JSON.stringify({ amount_cents: 500, frequency: 'one_time' }),
    }));
    assert.equal(res.status, 503);
    const text = await res.text();
    assert.doesNotMatch(text, /sk_|rk_|whsec_|placeholder/);
    assert.match(text, /unavailable/i);
  } finally {
    if (prevUrl === undefined) delete process.env.URL;
    else process.env.URL = prevUrl;
  }
});

test('webhook function fails closed when secrets are missing', async () => {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  const { default: handler } = await import('../netlify/functions/stripe-webhook.mjs');
  const res = await handler(new Request('https://thefillingstationchurch.org/.netlify/functions/stripe-webhook', {
    method: 'POST',
    headers: { 'stripe-signature': 't=1,v1=bad', 'content-type': 'application/json' },
    body: '{}',
  }));
  assert.equal(res.status, 500);
  assert.doesNotMatch(await res.text(), /sk_|rk_|whsec_/);
});
