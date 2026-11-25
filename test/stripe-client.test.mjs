import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStripeClient, STRIPE_API_VERSION } from '../netlify/lib/stripe-client.mjs';

test('pins stripe-node 23.2.0 and API version 2026-11-18.endive', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.dependencies.stripe, '23.2.0');
  assert.equal(STRIPE_API_VERSION, '2026-11-18.endive');
  const stripe = createStripeClient('rk_test_placeholder');
  assert.equal(typeof stripe.checkout.sessions.create, 'function');
  assert.equal(stripe.getApiField('version'), STRIPE_API_VERSION);
});
