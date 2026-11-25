// Persistence used by the webhook for (1) event de-duplication and
// (2) "record each gift once" bookkeeping.
//
// Interface (swap in a database later by implementing the same methods):
//   claim(key)          -> Promise<boolean>  true only for the first caller
//   release(key)        -> Promise<void>     undo a claim (processing failed)
//   finish(key)         -> Promise<void>     mark a claim done so it is not reclaimed
//   putOnce(key, value) -> Promise<boolean>  write if new; false if it existed
//
// A claim left in "processing" (function timeout before release) can be taken
// again after CLAIM_STALE_MS. A finished claim is the duplicate record and stays.
//
// Records hold Stripe object IDs, amounts and timestamps only — no donor
// names, emails or card data. Look donors up in the Stripe Dashboard.
//
// Netlify Blobs is used here as an idempotency marker store (onlyIfNew),
// not as a donor database.

export const CLAIM_STALE_MS = 15 * 60 * 1000;

export function createMemoryStore({ now = () => Date.now() } = {}) {
  const map = new Map();
  return {
    async claim(key) {
      const cur = map.get(key);
      if (cur) {
        const stale = cur.status === 'processing' && now() - cur.at >= CLAIM_STALE_MS;
        if (!stale) return false;
        map.delete(key);
      }
      map.set(key, { status: 'processing', at: now() });
      return true;
    },
    async release(key) {
      map.delete(key);
    },
    async finish(key) {
      if (!map.has(key)) return;
      map.set(key, { status: 'done', at: now() });
    },
    async putOnce(key, value) {
      if (map.has(key)) return false;
      map.set(key, value);
      return true;
    },
    _map: map,
  };
}

// Site-wide, strongly consistent store. The same store is shared by every
// deploy context unless DONATIONS_BLOB_STORE differs per context.
export async function createBlobsStore(name = 'donations') {
  const { getStore } = await import('@netlify/blobs');
  const store = getStore({ name, consistency: 'strong' });
  const eventKey = (key) => `events/${key}`;
  async function take(key) {
    const res = await store.setJSON(
      eventKey(key),
      { status: 'processing', at: new Date().toISOString() },
      { onlyIfNew: true },
    );
    return Boolean(res && res.modified);
  }
  return {
    async claim(key) {
      if (await take(key)) return true;
      const existing = await store.get(eventKey(key), { type: 'json' });
      if (!existing || existing.status !== 'processing') return false;
      const at = Date.parse(existing.at);
      if (!Number.isFinite(at) || Date.now() - at < CLAIM_STALE_MS) return false;
      // The previous invocation died before release. Drop the stale marker
      // and try once. onlyIfNew keeps two retries from both winning.
      await store.delete(eventKey(key));
      return take(key);
    },
    async release(key) {
      await store.delete(eventKey(key));
    },
    async finish(key) {
      await store.setJSON(eventKey(key), { status: 'done', at: new Date().toISOString() });
    },
    async putOnce(key, value) {
      const res = await store.setJSON(`gifts/${key}`, value, { onlyIfNew: true });
      return Boolean(res && res.modified);
    },
  };
}
