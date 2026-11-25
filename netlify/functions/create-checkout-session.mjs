// POST /.netlify/functions/create-checkout-session
// Body: { "amount_cents": 5000, "frequency": "one_time" | "monthly", "monthly_consent"?: true, "idempotency_key"?: "<uuid>" }
// Returns: { "url": "https://checkout.stripe.com/..." }
import { loadConfig, runtimeEnv } from '../lib/config.mjs';
import { createCheckoutHandler } from '../lib/checkout.mjs';
import { createStripeClient } from '../lib/stripe-client.mjs';

const config = loadConfig(runtimeEnv());
let stripe;
function getStripe() {
  if (!stripe) stripe = createStripeClient(config.stripeSecretKey);
  return stripe;
}

export default createCheckoutHandler({ config, getStripe });
