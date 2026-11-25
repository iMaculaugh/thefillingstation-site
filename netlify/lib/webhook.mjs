// Stripe webhook handling: signature verification on the raw body,
// de-duplication, and idempotent bookkeeping that tolerates out-of-order events.
import { json, readLimitedBytes } from './http.mjs';
import { isStripeSecretKey, isWebhookSecret } from './config.mjs';

export const MAX_WEBHOOK_BYTES = 512 * 1024;
const GIFT_SOURCE = 'website_give_page';

export const HANDLED_EVENTS = Object.freeze([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'invoice.paid',
  'invoice.payment_failed',
  'customer.subscription.deleted',
  // Risk-side events are logged (IDs only). Act on them in the Dashboard.
  'charge.refunded',
  'charge.dispute.created',
  'radar.early_fraud_warning.created',
]);

function idOf(v) {
  return v && typeof v === 'object' ? v.id : v || null;
}

// Current invoice shape (invoice.parent.subscription_details) and the legacy
// top-level invoice.subscription field.
export function subscriptionIdFromInvoice(invoice) {
  return (
    idOf(invoice?.parent?.subscription_details?.subscription) ||
    idOf(invoice?.subscription) ||
    null
  );
}

// Counting rules (no double counting):
//   - One-time gifts are counted from the Checkout Session (payment mode) once
//     payment_status is 'paid' — completed or async_payment_succeeded.
//   - Monthly gifts are counted ONLY from invoice.paid, including the first
//     invoice (billing_reason subscription_create). A subscription-mode
//     checkout.session.completed is never counted as money.
export function interpretEvent(event) {
  const obj = event.data && event.data.object ? event.data.object : {};
  const at = new Date((event.created || 0) * 1000).toISOString();
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      if (obj.mode === 'subscription') {
        return { gifts: [], note: `monthly signup ${obj.id} sub=${idOf(obj.subscription)}` };
      }
      if (obj.mode === 'payment' && obj.payment_status === 'paid') {
        return {
          gifts: [{
            key: `session_${obj.id}`,
            record: {
              kind: 'one_time', session: obj.id, payment_intent: idOf(obj.payment_intent),
              amount: obj.amount_total, currency: obj.currency, livemode: !!event.livemode, at,
            },
          }],
          note: `one-time paid ${obj.id}`,
        };
      }
      return { gifts: [], note: `session ${obj.id} awaiting payment (${obj.payment_status})` };
    }
    case 'checkout.session.async_payment_failed':
      return { gifts: [], note: `async payment failed ${obj.id}` };
    case 'invoice.paid': {
      const sub = subscriptionIdFromInvoice(obj);
      if (!sub || !(obj.amount_paid > 0)) return { gifts: [], note: `invoice ${obj.id} not a paid gift` };
      const meta = obj.parent?.subscription_details?.metadata;
      if (meta && typeof meta.source === 'string' && meta.source !== GIFT_SOURCE) {
        return { gifts: [], note: `invoice ${obj.id} ignored (not a website gift)` };
      }
      return {
        gifts: [{
          key: `invoice_${obj.id}`,
          record: {
            kind: 'monthly', invoice: obj.id, subscription: sub, billing_reason: obj.billing_reason || null,
            amount: obj.amount_paid, currency: obj.currency, livemode: !!event.livemode, at,
          },
        }],
        note: `monthly paid ${obj.id} sub=${sub} reason=${obj.billing_reason}`,
      };
    }
    case 'invoice.payment_failed':
      return { gifts: [], note: `monthly payment failed ${obj.id} sub=${subscriptionIdFromInvoice(obj)} attempt=${obj.attempt_count}` };
    case 'customer.subscription.deleted':
      return { gifts: [], note: `monthly gift ended ${obj.id}` };
    case 'charge.refunded':
      return { gifts: [], note: `ATTENTION refund charge=${obj.id} pi=${idOf(obj.payment_intent)} refunded=${obj.amount_refunded}` };
    case 'charge.dispute.created':
      return { gifts: [], note: `ATTENTION dispute ${obj.id} charge=${idOf(obj.charge)} reason=${obj.reason}` };
    case 'radar.early_fraud_warning.created':
      return { gifts: [], note: `ATTENTION early fraud warning ${obj.id} charge=${idOf(obj.charge)}` };
    default:
      return null;
  }
}

export function createWebhookHandler({ config, getStripe, getStore, logger = console }) {
  return async function handler(req) {
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed.' }, { allow: 'POST' });

    if (!isWebhookSecret(config.webhookSecret) || !isStripeSecretKey(config.stripeSecretKey)) {
      logger.error('[stripe-webhook] not configured');
      return json(500, { error: 'Not configured.' }); // Stripe will retry later
    }
    const signature = req.headers.get('stripe-signature');
    if (!signature) return json(400, { error: 'Bad signature.' });

    // Signature is over the exact bytes Stripe sent. Read those bytes and
    // verify BEFORE parsing anything.
    const { bytes, tooLarge } = await readLimitedBytes(req, MAX_WEBHOOK_BYTES);
    if (tooLarge) return json(413, { error: 'Too large.' });

    let event;
    try {
      event = getStripe().webhooks.constructEvent(Buffer.from(bytes), signature, config.webhookSecret);
    } catch {
      logger.warn('[stripe-webhook] signature verification failed');
      return json(400, { error: 'Bad signature.' });
    }

    if (!HANDLED_EVENTS.includes(event.type)) {
      return json(200, { received: true, ignored: true });
    }

    const store = await getStore();
    const fresh = await store.claim(event.id);
    if (!fresh) {
      logger.info('[stripe-webhook] duplicate', event.id, event.type);
      return json(200, { received: true, duplicate: true });
    }

    try {
      const result = interpretEvent(event);
      for (const g of result.gifts) {
        const isNew = await store.putOnce(g.key, { ...g.record, event: event.id });
        if (!isNew) logger.info('[stripe-webhook] gift already recorded', g.key);
      }
      logger.info('[stripe-webhook]', event.id, event.type, result.note);
      return json(200, { received: true });
    } catch (err) {
      // Let Stripe retry: undo the claim so the retry is processed.
      try { await store.release(event.id); } catch { /* ignore */ }
      logger.error('[stripe-webhook] processing failed', event.id, event.type, err && err.name);
      return json(500, { error: 'Processing failed.' });
    }
  };
}
