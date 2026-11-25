import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import Stripe from 'stripe';
import { loadConfig } from '../netlify/lib/config.mjs';
import { createMemoryStore } from '../netlify/lib/store.mjs';
import { createWebhookHandler, interpretEvent, subscriptionIdFromInvoice } from '../netlify/lib/webhook.mjs';

// Real SDK used only for offline signature checks; no network calls are made.
const sdk = new Stripe('rk_test_placeholder');
const SECRET = 'whsec_' + randomBytes(16).toString('hex'); // generated per run, never stored
const quiet = { info() {}, warn() {}, error() {} };

function setup({ store = createMemoryStore(), env = {} } = {}) {
  const config = loadConfig({ STRIPE_SECRET_KEY: 'rk_test_placeholder', STRIPE_WEBHOOK_SECRET: SECRET, SITE_URL: 'https://thefillingstationchurch.org', ...env });
  const handler = createWebhookHandler({ config, getStripe: () => sdk, getStore: async () => store, logger: quiet });
  return { handler, store };
}

let n = 0;
function evt(type, object, extra = {}) {
  n += 1;
  return { id: `evt_test_${n}`, object: 'event', type, created: 1764000000 + n, livemode: false, data: { object }, ...extra };
}

function signed(event, { secret = SECRET, tamper = false } = {}) {
  const payload = JSON.stringify(event);
  const header = sdk.webhooks.generateTestHeaderString({ payload, secret });
  const body = tamper ? payload.replace('"livemode":false', '"livemode":true') : payload;
  return new Request('https://thefillingstationchurch.org/.netlify/functions/stripe-webhook', {
    method: 'POST', headers: { 'stripe-signature': header, 'content-type': 'application/json' }, body,
  });
}

const paidSession = (id = 'cs_test_a') => ({ id, object: 'checkout.session', mode: 'payment', payment_status: 'paid', amount_total: 5000, currency: 'usd', payment_intent: 'pi_test_a' });
const subSession = (id = 'cs_test_s') => ({ id, object: 'checkout.session', mode: 'subscription', payment_status: 'paid', amount_total: 2500, currency: 'usd', subscription: 'sub_test_1' });
const invoice = (id, reason) => ({ id, object: 'invoice', amount_paid: 2500, currency: 'usd', billing_reason: reason, parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_test_1' } } });

const gifts = (store) => [...store._map.entries()].filter(([k]) => k.startsWith('session_') || k.startsWith('invoice_'));

describe('signature verification', () => {
  test('valid signature accepted', async () => {
    const { handler } = setup();
    const res = await handler(signed(evt('checkout.session.completed', paidSession())));
    assert.equal(res.status, 200);
  });
  test('wrong secret rejected with 400', async () => {
    const { handler, store } = setup();
    const res = await handler(signed(evt('checkout.session.completed', paidSession()), { secret: 'whsec_wrong' }));
    assert.equal(res.status, 400);
    assert.equal(store._map.size, 0);
  });
  test('tampered body rejected with 400', async () => {
    const { handler, store } = setup();
    const res = await handler(signed(evt('checkout.session.completed', paidSession()), { tamper: true }));
    assert.equal(res.status, 400);
    assert.equal(store._map.size, 0);
  });
  test('missing signature header rejected; non-POST 405', async () => {
    const { handler } = setup();
    const r1 = await handler(new Request('https://x.test/', { method: 'POST', body: '{}' }));
    assert.equal(r1.status, 400);
    const r2 = await handler(new Request('https://x.test/', { method: 'GET' }));
    assert.equal(r2.status, 405);
  });
  test('missing webhook secret -> 500 so Stripe retries', async () => {
    const { handler } = setup({ env: { STRIPE_WEBHOOK_SECRET: '' } });
    const res = await handler(signed(evt('invoice.paid', invoice('in_x', 'subscription_cycle'))));
    assert.equal(res.status, 500);
  });
  test('oversized body is rejected and nothing is stored', async () => {
    const { handler, store } = setup();
    const body = 'x'.repeat(512 * 1024 + 1);
    const res = await handler(new Request('https://x.test/', {
      method: 'POST',
      headers: {
        'stripe-signature': 't=1,v1=abc',
        'content-type': 'application/json',
        'content-length': String(body.length),
      },
      body,
    }));
    assert.equal(res.status, 413);
    assert.equal(store._map.size, 0);
  });
});

describe('dedupe and counting', () => {
  test('duplicate event id is ignored', async () => {
    const { handler, store } = setup();
    const e = evt('checkout.session.completed', paidSession('cs_dup'));
    const r1 = await handler(signed(e));
    const r2 = await handler(signed(e));
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal((await r2.json()).duplicate, true);
    assert.equal(gifts(store).length, 1);
  });
  test('one-time gift counted once across completed + async_succeeded', async () => {
    const { handler, store } = setup();
    await handler(signed(evt('checkout.session.completed', { ...paidSession('cs_async'), payment_status: 'unpaid' })));
    assert.equal(gifts(store).length, 0);
    await handler(signed(evt('checkout.session.async_payment_succeeded', paidSession('cs_async'))));
    await handler(signed(evt('checkout.session.async_payment_succeeded', paidSession('cs_async')))); // different event id, same session
    assert.equal(gifts(store).length, 1);
  });
  test('async failure records nothing', async () => {
    const { handler, store } = setup();
    const res = await handler(signed(evt('checkout.session.async_payment_failed', { ...paidSession('cs_f'), payment_status: 'unpaid' })));
    assert.equal(res.status, 200);
    assert.equal(gifts(store).length, 0);
  });
  test('monthly: first invoice counted once, checkout completion not counted', async () => {
    const { handler, store } = setup();
    await handler(signed(evt('checkout.session.completed', subSession())));
    await handler(signed(evt('invoice.paid', invoice('in_first', 'subscription_create'))));
    await handler(signed(evt('invoice.paid', invoice('in_second', 'subscription_cycle'))));
    const g = gifts(store).map(([k]) => k).sort();
    assert.deepEqual(g, ['invoice_in_first', 'invoice_in_second']);
  });
  test('out-of-order: invoice.paid before checkout.session.completed, and deletion before renewal', async () => {
    const { handler, store } = setup();
    const statuses = [];
    statuses.push((await handler(signed(evt('customer.subscription.deleted', { id: 'sub_test_1', object: 'subscription', status: 'canceled' })))).status);
    statuses.push((await handler(signed(evt('invoice.paid', invoice('in_first', 'subscription_create'))))).status);
    statuses.push((await handler(signed(evt('invoice.payment_failed', { ...invoice('in_fail', 'subscription_cycle'), amount_paid: 0, attempt_count: 1 })))).status);
    statuses.push((await handler(signed(evt('checkout.session.completed', subSession())))).status);
    assert.deepEqual(statuses, [200, 200, 200, 200]);
    assert.deepEqual(gifts(store).map(([k]) => k), ['invoice_in_first']);
  });
  test('unhandled event types acknowledged without storing', async () => {
    const { handler, store } = setup();
    const res = await handler(signed(evt('customer.created', { id: 'cus_1' })));
    assert.equal(res.status, 200);
    assert.equal(store._map.size, 0);
  });
  test('processing failure releases claim so Stripe retry is processed', async () => {
    const base = createMemoryStore();
    let fail = true;
    const store = { ...base, putOnce: async (k, v) => { if (fail) throw new Error('db down'); return base.putOnce(k, v); } };
    const { handler } = setup({ store });
    const e = evt('invoice.paid', invoice('in_retry', 'subscription_cycle'));
    assert.equal((await handler(signed(e))).status, 500);
    fail = false;
    assert.equal((await handler(signed(e))).status, 200);
    assert.ok(base._map.has('invoice_in_retry'));
  });
  test('stored records contain ids and amounts only (no email/name)', async () => {
    const { handler, store } = setup();
    await handler(signed(evt('checkout.session.completed', { ...paidSession('cs_pii'), customer_details: { email: 'donor@example.com', name: 'Donor Name' } })));
    assert.doesNotMatch(JSON.stringify([...store._map.values()]), /donor@example|Donor Name/);
  });
});

describe('risk events', () => {
  test('refund / dispute / fraud warning acknowledged and logged without counting', async () => {
    const { handler, store } = setup();
    for (const [t, o] of [['charge.refunded', { id: 'ch_1', payment_intent: 'pi_1', amount_refunded: 500 }], ['charge.dispute.created', { id: 'dp_1', charge: 'ch_1', reason: 'fraudulent' }], ['radar.early_fraud_warning.created', { id: 'issfr_1', charge: 'ch_1' }]]) {
      assert.equal((await handler(signed(evt(t, o)))).status, 200);
    }
    assert.equal(gifts(store).length, 0);
  });
});

describe('helpers', () => {
  test('subscription id from new and legacy invoice shapes', () => {
    assert.equal(subscriptionIdFromInvoice(invoice('in_1', 'x')), 'sub_test_1');
    assert.equal(subscriptionIdFromInvoice({ subscription: 'sub_legacy' }), 'sub_legacy');
    assert.equal(subscriptionIdFromInvoice({}), null);
  });
  test('non-subscription invoice is not counted', () => {
    const r = interpretEvent(evt('invoice.paid', { id: 'in_oneoff', amount_paid: 100 }));
    assert.equal(r.gifts.length, 0);
  });
  test('invoice with a different source is not counted', () => {
    const foreign = invoice('in_other', 'subscription_cycle');
    foreign.parent.subscription_details.metadata = { source: 'some_other_product' };
    const r = interpretEvent(evt('invoice.paid', foreign));
    assert.equal(r.gifts.length, 0);
  });
});
