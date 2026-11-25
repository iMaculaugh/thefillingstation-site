// Runtime configuration for the donation functions.
// Secrets come from Netlify environment variables. Nothing secret lives in this file.

const DEFAULTS = Object.freeze({
  currency: 'usd',
  minCents: 100, // $1.00
  maxCents: 1_000_000, // $10,000.00
  blobStore: 'donations',
});

// Zero-decimal currencies need different amount handling, so they are not allowed.
const SUPPORTED_CURRENCIES = new Set(['usd']);

const ENV_NAMES = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'SITE_URL',
  'ALLOWED_ORIGINS',
  'DONATION_CURRENCY',
  'DONATION_MIN_CENTS',
  'DONATION_MAX_CENTS',
  'DONATION_PRODUCT_NAME',
  'DONATION_MONTHLY_PRODUCT_NAME',
  'DONATIONS_BLOB_STORE',
  'ALLOW_LOCALHOST',
  'URL',
  'DEPLOY_PRIME_URL',
  'DEPLOY_URL',
  'CONTEXT',
];

function readInt(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function normalizeOrigin(value) {
  if (!value) return null;
  try {
    const u = new URL(String(value).trim());
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocalHost(u.hostname))) return null;
    return u.origin;
  } catch {
    return null;
  }
}

function blobStoreName(value) {
  const name = String(value || '').trim();
  if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) return name;
  return DEFAULTS.blobStore;
}

// Restricted keys (rk_) are preferred. Secret keys (sk_) are accepted.
// Publishable keys and empty values are rejected so a mis-set key cannot charge.
export function isStripeSecretKey(value) {
  return typeof value === 'string' && /^(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+$/.test(value);
}

// Signing secrets are whsec_ plus a base64-ish payload. Prefix and length only.
export function isWebhookSecret(value) {
  return typeof value === 'string' && /^whsec_[A-Za-z0-9+/=_-]{16,}$/.test(value);
}

// Netlify functions should read Netlify.env. process.env is only the fallback
// for `node --test` and `npm run check`, where the Netlify runtime is absent.
export function runtimeEnv() {
  const netlify = globalThis.Netlify;
  const out = {};
  for (const name of ENV_NAMES) {
    let value;
    if (netlify && netlify.env && typeof netlify.env.get === 'function') {
      value = netlify.env.get(name);
    }
    if (value == null || value === '') value = process.env[name];
    if (value != null && value !== '') out[name] = value;
  }
  return out;
}

export function loadConfig(env = process.env) {
  const currency = String(env.DONATION_CURRENCY || DEFAULTS.currency).trim().toLowerCase();
  let minCents = readInt(env.DONATION_MIN_CENTS, DEFAULTS.minCents);
  let maxCents = readInt(env.DONATION_MAX_CENTS, DEFAULTS.maxCents);
  if (minCents > maxCents) {
    minCents = DEFAULTS.minCents;
    maxCents = DEFAULTS.maxCents;
  }

  const siteUrl = normalizeOrigin(env.SITE_URL);

  // Allowed browser origins: SITE_URL, extra ALLOWED_ORIGINS, and the URLs
  // Netlify injects for this deploy. http origins are ignored unless
  // ALLOW_LOCALHOST=true (never set that in production).
  const allowed = new Set();
  const add = (v) => {
    const o = normalizeOrigin(v);
    if (!o) return;
    if (o.startsWith('http:') && env.ALLOW_LOCALHOST !== 'true') return;
    allowed.add(o);
  };
  add(env.SITE_URL);
  String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .forEach(add);
  add(env.URL);
  add(env.DEPLOY_PRIME_URL);
  add(env.DEPLOY_URL);

  return Object.freeze({
    stripeSecretKey: env.STRIPE_SECRET_KEY || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    currency,
    currencySupported: SUPPORTED_CURRENCIES.has(currency),
    minCents,
    maxCents,
    siteUrl,
    allowedOrigins: allowed,
    blobStore: blobStoreName(env.DONATIONS_BLOB_STORE),
    productName: (env.DONATION_PRODUCT_NAME || 'Gift to The Filling Station').slice(0, 120),
    monthlyProductName: (env.DONATION_MONTHLY_PRODUCT_NAME || 'Monthly gift to The Filling Station').slice(0, 120),
  });
}

export { DEFAULTS };
