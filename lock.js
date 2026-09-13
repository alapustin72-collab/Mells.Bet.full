// ---------------------------------------------------------------------------
// Thin wrapper around the spworlds.ru public API.
// Docs: https://github.com/sp-worlds/api-docs
//
// Auth header is base64("CARD_ID:CARD_TOKEN"), same pattern as the official
// client libraries. Keep SPWORLDS_CARD_TOKEN out of any client-side code —
// it must only ever live on this server, in .env.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';

const API_URL = process.env.SPWORLDS_API_URL || 'https://spworlds.ru/api/public';

function authHeader() {
  const id = process.env.SPWORLDS_CARD_ID;
  const token = process.env.SPWORLDS_CARD_TOKEN;
  if (!id || !token) {
    throw new Error('SPWORLDS_CARD_ID / SPWORLDS_CARD_TOKEN not set in .env');
  }
  return 'Bearer ' + Buffer.from(`${id}:${token}`).toString('base64');
}

/**
 * Looks up a player's verified Minecraft nickname from their Discord ID.
 * Returns null if that Discord account has no access to the server.
 */
export async function findUserByDiscordId(discordId) {
  const res = await fetch(`${API_URL}/users/${discordId}`, {
    headers: { Authorization: authHeader() }
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`spworlds findUser failed: ${res.status}`);
  const data = await res.json();
  return data.username || null;
}

/**
 * Creates a real spworlds payment link for automatic AR deposits.
 * spworlds redirects the player to `redirectUrl` after payment, and POSTs
 * a signed confirmation to `webhookUrl` once the AR actually lands on our
 * card — see src/routes-webhooks.js, which is what actually credits the
 * site balance. `data` is an opaque string spworlds echoes back verbatim
 * in that webhook payload — we pass our internal deposit id so the
 * webhook handler knows exactly which ticket to credit, without relying
 * on the player typing anything.
 */
export async function createDepositLink({ amount, comment, data, redirectUrl, webhookUrl }) {
  const res = await fetch(`${API_URL}/payment`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      items: [{ name: 'Пополнение баланса Mells.Bet', count: 1, price: amount, comment }],
      redirectUrl,
      webhookUrl,
      data
    })
  });
  if (!res.ok) throw new Error(`spworlds createTransaction failed: ${res.status}`);
  return res.json(); // { url: "https://spworlds.ru/pay/..." }
}

/**
 * Sends AR directly from our card to a player's card — this is what
 * powers automatic withdrawal payouts (src/routes-admin.js's
 * POST /withdrawals). `receiver` is the recipient's CARD NUMBER (not
 * username), `comment` is capped at 64 characters by spworlds.
 * Confirmed against the official Go client (sp-worlds/api-docs, via
 * xligenda/spworlds's restapi.go): POST /transactions with
 * {receiver, amount, comment}, returning {balance} — our card's
 * remaining balance after the transfer.
 */
export async function sendPayment({ amount, receiver, comment }) {
  const res = await fetch(`${API_URL}/transactions`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ receiver, amount, comment })
  });
  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()); } catch { /* ignore */ }
    throw new Error(`spworlds sendPayment failed: ${res.status} ${detail}`);
  }
  return res.json(); // { balance }
}

/**
 * Registers (or updates) the card-level webhook. Unlike createDepositLink's
 * per-payment webhookUrl (which only fires once, for that one payment
 * session), this one fires for EVERY transaction that ever touches our
 * card — including manual peer-to-peer AR transfers players send directly
 * from their spworlds wallet. src/routes-webhooks.js's /spworlds/card
 * handler reads each transfer's comment, looks for a player's 5-digit
 * casino code in it, and — if that player has a pending deposit request —
 * credits it automatically.
 *
 * Safe to call repeatedly (e.g. once on every server startup) — spworlds
 * just overwrites the previously registered URL.
 */
export async function setCardWebhook(url) {
  const res = await fetch(`${API_URL}/card/webhook`, {
    method: 'PUT',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ url })
  });
  if (!res.ok) throw new Error(`spworlds setCardWebhook failed: ${res.status}`);
  return res.json(); // { id, webhook }
}

/**
 * Verifies the X-Body-Hash header spworlds sends with every webhook POST,
 * so we only ever trust payloads that actually came from spworlds (and not
 * e.g. someone POSTing straight to /webhooks/spworlds pretending a deposit
 * was paid). HMAC-SHA256 of the raw request body, keyed with our card
 * token, base64-encoded — same scheme used by the official client
 * libraries' validateHash() helper.
 *
 * `rawBody` must be the exact bytes spworlds sent (a Buffer), not a
 * re-serialized JSON.stringify() of the parsed object — re-serializing can
 * change key order/whitespace and make a genuine webhook fail verification.
 */
export function verifyWebhookHash(rawBody, hashHeader) {
  const token = process.env.SPWORLDS_CARD_TOKEN;
  if (!token || !hashHeader) return false;
  const expected = crypto.createHmac('sha256', token).update(rawBody).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(hashHeader));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
