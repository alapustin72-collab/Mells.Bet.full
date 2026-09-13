// ---------------------------------------------------------------------------
// Public webhook endpoint that spworlds calls after a payment succeeds.
// This is what actually credits a player's balance automatically — no
// admin action needed once this fires. Every request is verified against
// the X-Body-Hash signature before we trust anything in it (see
// src/spworlds.js verifyWebhookHash).
// ---------------------------------------------------------------------------

import express from 'express';
import { verifyWebhookHash } from './spworlds.js';
import { db } from './db.js';

const router = express.Router();

router.post('/spworlds', async (req, res) => {
  // req.rawBody is populated by the express.json({ verify }) hook in
  // server.js — we need the exact bytes spworlds sent, not a
  // re-serialized copy, or the signature check can fail spuriously.
  const rawBody = req.rawBody;
  const hashHeader = req.get('X-Body-Hash');

  if (!rawBody || !verifyWebhookHash(rawBody, hashHeader)) {
    console.warn('spworlds webhook: invalid or missing X-Body-Hash — rejected');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    const { amount, data: depositId, payer } = req.body || {};
    if (!depositId) {
      console.warn('spworlds webhook: no data/depositId in payload, ignoring');
      return res.status(200).json({ ok: true }); // acknowledge so spworlds stops retrying
    }

    const deposit = await db.getDeposit(depositId);
    if (!deposit) {
      console.warn(`spworlds webhook: unknown deposit id ${depositId}`);
      return res.status(200).json({ ok: true });
    }

    // Atomic claim FIRST, then pay out — this is the fix for the reported
    // race: the old code checked deposit.status in JS, then made two
    // separate writes (credit balance, THEN flip status to 'completed').
    // Two webhook deliveries arriving close together could both read
    // 'pending' before either write landed, crediting the balance twice.
    // Flipping the status is now the single atomic gate: only the
    // delivery that actually transitions the row out of
    // pending/paid_pending gets to credit anything.
    const claimed = await db.claimDepositById(deposit.id);
    if (!claimed) {
      // Either already completed by an earlier delivery, or in some other
      // terminal state (cancelled/expired) — nothing to do either way.
      return res.status(200).json({ ok: true });
    }

    try {
      await db.updateUserBalance(claimed.userId, claimed.amount);
    } catch (err) {
      // We've already marked this deposit 'completed' — if crediting the
      // balance then fails for any reason, we must not leave it silently
      // marked completed with no money moved (the second half of the
      // race the report called out). Roll the status back so it's picked
      // up again (retried delivery, or funded manually from the admin
      // panel) instead of quietly vanishing.
      console.error(`CRITICAL: spworlds webhook claimed deposit ${claimed.id} but balance credit failed, rolling status back:`, err);
      await db.updateDeposit(claimed.id, { status: 'pending' }).catch(rollbackErr => {
        console.error(`CRITICAL: could not even roll back deposit ${claimed.id} status:`, rollbackErr);
      });
      throw err;
    }

    console.log(`spworlds webhook: credited deposit ${depositId} (${claimed.amount} AR) from ${payer || 'unknown payer'}, spworlds reported amount=${amount}`);

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('spworlds webhook handling failed:', err);
    // Still 200 — we don't want spworlds hammering retries for an error on
    // our side once we've logged it; the deposit stays pending and can be
    // funded manually from the admin panel as a fallback.
    res.status(200).json({ ok: false });
  }
});

// ---------------------------------------------------------------------------
// Card-level webhook — registered once via spworlds.setCardWebhook(), see
// server.js. Fires for EVERY transaction that touches our card, including
// a player manually opening spworlds.ru and transferring AR straight to
// our card with their own comment (the flow this route exists for).
//
// Matching rule: every casino account has a permanent 5-digit `code`
// (shown to the player as their "ID казино"). We scan the transfer's
// comment for that code, find the matching user, and — only if that user
// currently has a pending deposit request — credit that request's amount
// and mark it completed. No pending request for that user = nothing is
// credited (so a random comment that happens to contain someone's code
// doesn't trigger anything unless they actually clicked "Пополнить" first).
// ---------------------------------------------------------------------------
router.post('/spworlds/card', async (req, res) => {
  const rawBody = req.rawBody;
  const hashHeader = req.get('X-Body-Hash');

  if (!rawBody || !verifyWebhookHash(rawBody, hashHeader)) {
    console.warn('spworlds card webhook: invalid or missing X-Body-Hash — rejected');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    const { id: txId, amount, sender, comment } = req.body || {};
    if (!txId) return res.status(200).json({ ok: true });

    // Idempotency — spworlds may redeliver the same event, and this webhook
    // also sees transactions already credited by the /spworlds route above
    // (that one is scoped to a single payment session; this one sees the
    // card's entire transaction history) — never process the same tx twice.
    if (await db.hasSpworldsTx(txId)) {
      return res.status(200).json({ ok: true });
    }

    const codeMatch = typeof comment === 'string' ? comment.match(/\b(\d{5})\b/) : null;
    const code = codeMatch ? codeMatch[1] : null;
    const transferAmount = Number(amount);

    let credited = false;
    let matchedUserId = null;

    if (code && Number.isFinite(transferAmount) && transferAmount > 0) {
      const user = await db.getUserByCode(code);
      if (user) {
        matchedUserId = user.id;
        // Matches strictly on code AND the exact requested amount, and
        // claims the deposit atomically — so a deposit is credited at
        // most once, even under concurrent webhook deliveries, and a
        // transfer for the wrong amount never accidentally closes out an
        // unrelated pending request.
        const deposit = await db.claimPendingDepositForUser(user.id, transferAmount);
        if (deposit) {
          await db.updateUserBalance(user.id, deposit.amount);
          credited = true;
          console.log(`spworlds card webhook: credited deposit ${deposit.id} (${deposit.amount} AR) for ${user.mcNick} (code ${code}), tx ${txId}`);
        } else {
          console.warn(`spworlds card webhook: code ${code} (${user.mcNick}) matched but no pending deposit for exactly ${transferAmount} AR — not crediting, tx ${txId}`);
        }
      } else {
        console.warn(`spworlds card webhook: comment contains code ${code} but no user has that code, tx ${txId}`);
      }
    } else {
      console.warn(`spworlds card webhook: no 5-digit code found in comment "${comment || ''}", tx ${txId}, sender=${sender?.username || '(none)'}`);
    }

    await db.recordSpworldsTx({
      id: txId, amount, senderUsername: sender?.username || null, comment,
      matchedUserId, credited, createdAt: Date.now()
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('spworlds card webhook handling failed:', err);
    res.status(200).json({ ok: false });
  }
});

export default router;
