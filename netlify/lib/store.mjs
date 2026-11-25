// Persistence used by the webhook for (1) event de-duplication and
// (2) "record each gift once" bookkeeping.
//
// Interface (swap in a database later by implementing the same three methods):
//   claim(key)          -> Promise<boolean>  true only for the first caller
//   release(key)        -> Promise<void>     undo a claim (processing failed)
//   putOnce(key, value) -> Promise<boolean>  write if new; false if it existed
//
// Records hold Stripe object IDs, amounts and timestamps only — no donor
// names, emails or card data. Look donors up in the Stripe Dashboard.
//
// Netlify Blobs is used here as an idempotency marker store (onlyIfNew),
// not as a donor database.

export function createMemoryStore() {
  const map = new Map();
  return {
    async claim(key) {
      if (map.has(key)) return false;
      map.set(key, { status: 'processing', at: Date.now() });
      return true;
    },
    async release(key) {
      map.delete(key);
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
  return {
    async claim(key) {
      const res = await store.setJSON(
        `events/${key}`,
        { status: 'processing', at: new Date().toISOString() },
        { onlyIfNew: true },
      );
      return Boolean(res && res.modified);
    },
    async release(key) {
      await store.delete(`events/${key}`);
    },
    async putOnce(key, value) {
      const res = await store.setJSON(`gifts/${key}`, value, { onlyIfNew: true });
      return Boolean(res && res.modified);
    },
  };
}
