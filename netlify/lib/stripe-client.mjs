// One Stripe client per warm function. Methods are called on this instance.
// Do not assign Stripe.apiKey / the module-level key (deprecated).
import Stripe from 'stripe';

// stripe-node 23.2.0 pins this API version. Set it explicitly so a later
// SDK bump cannot silently change the contract.
export const STRIPE_API_VERSION = '2026-11-18.endive';

export function createStripeClient(secretKey) {
  return new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: 2,
    timeout: 10_000,
  });
}
