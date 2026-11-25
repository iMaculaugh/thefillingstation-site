// Small HTTP helpers shared by the functions.

export function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
  });
}

// Generic, donor-facing error messages. Never include Stripe error details,
// stack traces, keys, or configuration values in responses.
export const MESSAGES = Object.freeze({
  method: 'Method not allowed.',
  origin: 'This request is not allowed.',
  tooLarge: 'Request too large.',
  badRequest: 'We could not read that request. Please try again.',
  amount: 'Please enter an amount within the allowed range.',
  frequency: 'Please choose one time or monthly.',
  consent: 'Please confirm the monthly gift before continuing.',
  rateLimited: 'Too many attempts. Please wait a minute and try again.',
  unavailable: 'Online giving is temporarily unavailable. Please try again later.',
  generic: 'Something went wrong starting your gift. Please try again.',
});

// Read a request body while enforcing a byte limit, even when Content-Length
// is missing or lies. Returns the exact bytes (needed for webhook signatures).
export async function readLimitedBytes(req, maxBytes) {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return { tooLarge: true };
  if (!req.body) return { bytes: new Uint8Array(0) };
  const reader = req.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  return { bytes };
}

export async function readLimitedText(req, maxBytes) {
  const result = await readLimitedBytes(req, maxBytes);
  if (result.tooLarge) return { tooLarge: true };
  return { text: new TextDecoder().decode(result.bytes) };
}

// Fixed-window limiter kept in function memory. It only slows bursts that hit
// one warm instance; it is a speed bump, not a security boundary.
export function createRateLimiter({ limit = 10, windowMs = 60_000, now = () => Date.now() } = {}) {
  const hits = new Map();
  function allow(key) {
    const t = now();
    // Drop expired buckets before the map can grow without bound. The old
    // 5000-key cap left quiet addresses around until that cap was hit.
    if (hits.size > 256) {
      for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
    }
    const entry = hits.get(key);
    if (!entry || t - entry.start >= windowMs) {
      hits.set(key, { start: t, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  }
  allow.size = () => hits.size;
  return allow;
}
