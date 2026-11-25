// Sanity check: import each function module without network or secrets.
const mods = ['../netlify/functions/create-checkout-session.mjs', '../netlify/functions/stripe-webhook.mjs'];
for (const m of mods) {
  const mod = await import(new URL(m, import.meta.url));
  if (typeof mod.default !== 'function') throw new Error(`${m} has no default handler`);
  console.log('ok', m.split('/').pop());
}
