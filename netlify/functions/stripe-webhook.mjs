// POST /.netlify/functions/stripe-webhook
// Point a Stripe webhook endpoint at this URL. Do not create one from this repo.
import { loadConfig, runtimeEnv } from '../lib/config.mjs';
import { createBlobsStore } from '../lib/store.mjs';
import { createWebhookHandler } from '../lib/webhook.mjs';
import { createStripeClient } from '../lib/stripe-client.mjs';

const config = loadConfig(runtimeEnv());
let stripe;
let storePromise;

export default createWebhookHandler({
  config,
  getStripe: () => (stripe ||= createStripeClient(config.stripeSecretKey)),
  getStore: () =>
    (storePromise ||= createBlobsStore(config.blobStore).catch((err) => {
      storePromise = undefined; // retry on the next request
      throw err;
    })),
});
