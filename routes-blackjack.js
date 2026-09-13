import express from 'express';
import crypto from 'node:crypto';
import { requireAuth, requireAdmin } from './auth.js';
import { db } from './db.js';
import { createDepositLink, sendPayment } from './spworlds.js';
import { buildFullDayReport, buildStatsWorkbookBuffer, getWeeklyAggregateRows } from './stats.js';

const DEPOSIT_MAX = 100_000;
const DEPOSIT_TIMEOUT_MS = 10 * 60 * 1000;
const WITHDRAW_MAX = 100_000;

function statusLabel(s) {
  return {
    pending: 'Ожидает оплаты',
    paid_pending: 'Оплачено, ждёт подтверждения',
    processing: 'Отправляется автоматически…',
    completed: 'Выполнено',
    failed: 'Ошибка отправки, средства возвращены',
    cancelled_admin: 'Отменено админом',
    cancelled_player: 'Отменено игроком',
    expired: 'Истекло'
  }[s] || s;
}

// Wrap async route handlers so a thrown/rejected error reaches Express's
// error handling instead of crashing the process.
function ah(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

export default function adminRoutes() {
  const router = express.Router();

  // ---- player-facing: deposits ----
  router.post('/deposits', requireAuth, ah(async (req, res) => {
    const amount = parseInt(req.body.amount, 10);
    if (!Number.isInteger(amount) || amount < 1 || amount > DEPOSIT_MAX) {
      return res.status(400).json({ error: `Сумма от 1 до ${DEPOSIT_MAX}` });
    }
    const deposit = await db.createDeposit({
      id: crypto.randomUUID(),
      userId: req.user.id,
      amount,
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + DEPOSIT_TIMEOUT_MS
    });

    // Manual-transfer flow: player transfers AR to our card themselves via
    // spworlds.ru and writes their casino code (req.user.code) in the
    // transfer comment. Auto-crediting happens via the card-level webhook
    // (src/routes-webhooks.js /spworlds/card), which reads every incoming
    // transaction's comment, matches the 5-digit code against this pending
    // deposit, and credits it automatically — no admin action needed.
    res.json({
      deposit,
      casinoCode: req.user.code,
      card: process.env.SPWORLDS_CARD_NUMBER || null
    });
  }));

  router.get('/deposits/:id/status', requireAuth, ah(async (req, res) => {
    const d = await db.getDeposit(req.params.id);
    if (!d || d.userId !== req.user.id) return res.status(404).json({ error: 'Not found' });
    res.json({ status: d.status, statusLabel: statusLabel(d.status) });
  }));

  // ---- player-facing: SPWorlds Mini App payment popup ----
  // Creates a real spworlds transaction and hands the frontend just the
  // short "code" (the last segment of the returned pay URL) it needs to
  // call spm.openPayment(code) — the player pays inside spworlds' own
  // popup, never leaving the mini app. Crediting happens automatically
  // via the per-payment webhook in src/routes-webhooks.js once spworlds
  // confirms the transfer; this route only sets that up.
  router.post('/deposits/miniapp', requireAuth, ah(async (req, res) => {
    const amount = parseInt(req.body.amount, 10);
    if (!Number.isInteger(amount) || amount < 1 || amount > DEPOSIT_MAX) {
      return res.status(400).json({ error: `Сумма от 1 до ${DEPOSIT_MAX}` });
    }

    const deposit = await db.createDeposit({
      id: crypto.randomUUID(),
      userId: req.user.id,
      amount,
      status: 'pending',
      createdAt: Date.now(),
      expiresAt: Date.now() + DEPOSIT_TIMEOUT_MS
    });

    const baseUrl = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
    if (!baseUrl) {
      return res.status(500).json({ error: 'BASE_URL не настроен на сервере' });
    }

    let link;
    try {
      link = await createDepositLink({
        amount,
        comment: `Пополнение Mells.Bet (${req.user.code})`,
        data: deposit.id,
        // Required by spwmini's openPayment() for transactions meant to be
        // paid inside the mini app popup rather than via page redirect —
        // see the spwmini package README.
        redirectUrl: '#MINIAPP',
        webhookUrl: `${baseUrl}/webhooks/spworlds`
      });
    } catch (err) {
      await db.updateDeposit(deposit.id, { status: 'cancelled_admin' });
      console.error('createDepositLink (miniapp) failed:', err);
      return res.status(502).json({ error: 'Не удалось создать транзакцию SPWorlds' });
    }

    // spwmini's openPayment() wants the short code from the pay URL
    // (https://spworlds.ru/pay/<code>). spworlds' /payment response isn't
    // documented as returning a separate `code` field as of this writing,
    // so fall back to pulling it from the URL path; prefer an explicit
    // `code` field if spworlds ever adds one.
    let code = link.code;
    if (!code && link.url) {
      try { code = new URL(link.url).pathname.split('/').filter(Boolean).pop(); }
      catch { /* leave undefined, checked below */ }
    }
    if (!code) {
      await db.updateDeposit(deposit.id, { status: 'cancelled_admin' });
      return res.status(502).json({ error: 'SPWorlds не вернул код оплаты' });
    }

    res.json({ depositId: deposit.id, code });
  }));

  router.post('/deposits/:id/paid', requireAuth, ah(async (req, res) => {
    const all = await db.listDeposits();
    const d = all.find(x => x.id === req.params.id && x.userId === req.user.id);
    if (!d || d.status !== 'pending') return res.status(404).json({ error: 'Not found' });
    await db.updateDeposit(d.id, { status: 'paid_pending', paidClickedAt: Date.now() });
    res.json({ ok: true });
  }));

  router.post('/deposits/:id/cancel', requireAuth, ah(async (req, res) => {
    const all = await db.listDeposits();
    const d = all.find(x => x.id === req.params.id && x.userId === req.user.id);
    if (!d || d.status !== 'pending') return res.status(404).json({ error: 'Not found' });
    await db.updateDeposit(d.id, { status: 'cancelled_player' });
    res.json({ ok: true });
  }));

  // ---- player-facing: withdrawals ----
  router.post('/withdrawals', requireAuth, ah(async (req, res) => {
    const amount = parseInt(req.body.amount, 10);
    const card = String(req.body.card || '').trim();
    if (!card) return res.status(400).json({ error: 'Укажите номер карты' });
    if (!Number.isInteger(amount) || amount < 1 || amount > WITHDRAW_MAX) {
      return res.status(400).json({ error: `Сумма от 1 до ${WITHDRAW_MAX}` });
    }

    try {
      await db.updateUserBalance(req.user.id, -amount); // throws if insufficient
    } catch {
      return res.status(400).json({ error: 'Недостаточно средств' });
    }
    const w = await db.createWithdrawal({
      id: crypto.randomUUID(),
      userId: req.user.id,
      amount, card,
      status: 'pending',
      createdAt: Date.now()
    });

    // Automatic payout: send the AR for real, right now, instead of
    // leaving it for an admin to pay out by hand. Claim the withdrawal
    // out of 'pending' BEFORE calling spworlds — this is the fix for the
    // race a real automatic payout introduces that manual payout never
    // had: without this atomic claim, a cancel request arriving while the
    // spworlds transfer is still in flight could refund the balance via
    // cancelPendingWithdrawal (which only ever matches 'pending' rows) at
    // the same moment the transfer actually succeeds — the player would
    // end up with BOTH their site balance back AND the real AR. Once this
    // claim succeeds, the row is 'processing' and cancelPendingWithdrawal
    // can no longer touch it.
    const claimed = await db.claimWithdrawalForPayout(w.id, req.user.id);
    if (!claimed) {
      // Nothing else could plausibly have raced us this early — we only
      // just created the row — but if it ever happens, fail safe: leave
      // it 'pending' for manual handling rather than assuming anything.
      console.warn(`Withdrawal ${w.id} could not be claimed for payout immediately after creation`);
      return res.json({ withdrawal: w });
    }

    try {
      await sendPayment({
        amount,
        receiver: card,
        comment: `Вывод с Mells.Bet (код ${req.user.code})`
      });
      const completed = await db.updateWithdrawal(claimed.id, { status: 'completed' });
      return res.json({ withdrawal: completed, autoCompleted: true });
    } catch (err) {
      // The transfer request itself failed — no AR left our card, so the
      // balance debit above must be undone. (If spworlds ever partially
      // succeeds — e.g. we get a network timeout but the transfer still
      // went through on their end — this would incorrectly refund; that
      // failure mode is inherent to any non-idempotent payment call
      // without a idempotency-key/reconciliation API, which spworlds'
      // public API doesn't currently offer. Flagged here rather than
      // silently assumed away.)
      console.error(`Automatic withdrawal payout failed for withdrawal ${claimed.id}:`, err);
      await db.updateUserBalance(req.user.id, amount);
      const failed = await db.updateWithdrawal(claimed.id, { status: 'failed' });
      return res.status(502).json({
        error: 'Не удалось автоматически отправить АР — проверьте номер карты и попробуйте снова. Баланс возвращён.',
        withdrawal: failed
      });
    }
  }));

  router.post('/withdrawals/:id/cancel', requireAuth, ah(async (req, res) => {
    // Atomic claim first: only refund if THIS request is the one that
    // actually flips the withdrawal out of 'pending'. Previously this
    // read the withdrawal, checked status==='pending' in JS, then made
    // two separate writes — concurrent cancel requests (double-click,
    // replay, etc.) could all pass that check before any of them
    // committed, refunding the same withdrawal more than once. This also
    // covers the automatic-payout race described above: once a payout
    // attempt has moved the row to 'processing', this simply won't match
    // it any more, so cancel correctly fails with 404 instead of
    // refunding money that's already on its way out.
    const w = await db.cancelPendingWithdrawal(req.params.id, req.user.id);
    if (!w) return res.status(404).json({ error: 'Not found' });
    await db.updateUserBalance(w.userId, w.amount); // refund
    res.json({ ok: true });
  }));

  // ---- player-facing: own history ----
  router.get('/history', requireAuth, ah(async (req, res) => {
    const deposits = (await db.listDeposits())
      .filter(d => d.userId === req.user.id)
      .map(d => ({ ...d, statusLabel: statusLabel(d.status) }));
    const withdrawals = (await db.listWithdrawals())
      .filter(w => w.userId === req.user.id)
      .map(w => ({ ...w, statusLabel: statusLabel(w.status) }));
    res.json({ deposits, withdrawals });
  }));

  // ---- admin only, from here down ----
  router.use(requireAuth, requireAdmin);

  router.get('/players', ah(async (req, res) => {
    const users = await db.listUsers();
    res.json(users.map(u => ({
      id: u.id, nick: u.mcNick, code: u.code, balance: u.balance, role: u.role
    })));
  }));

  router.post('/credit', ah(async (req, res) => {
    const { target, amount } = req.body; // target = nick or 5-digit code
    const n = parseInt(amount, 10);
    if (!Number.isInteger(n)) return res.status(400).json({ error: 'Введите число' });
    const users = await db.listUsers();
    const user = users.find(u => u.mcNick === target || u.code === target);
    if (!user) return res.status(404).json({ error: 'Игрок не найден' });
    const newBalance = await db.updateUserBalance(user.id, n);
    res.json({ ok: true, balance: newBalance });
  }));

  router.post('/role', ah(async (req, res) => {
    const { target, role } = req.body; // target = nick or 5-digit code
    if (!['admin', 'player'].includes(role)) return res.status(400).json({ error: 'Некорректная роль' });
    const users = await db.listUsers();
    const user = users.find(u => u.mcNick === target || u.code === target);
    if (!user) return res.status(404).json({ error: 'Игрок не найден' });
    await db.setUserRole(user.id, role);
    res.json({ ok: true });
  }));

  router.get('/spworlds-unmatched', ah(async (req, res) => {
    // Manual AR transfers whose sender nickname didn't match any
    // registered player (see src/routes-webhooks.js /spworlds/card).
    // Nothing was credited for these — resolve by figuring out who it
    // was and crediting them manually via /api/admin/credit.
    const list = await db.listUnmatchedSpworldsTx();
    res.json(list);
  }));

  router.get('/deposits', ah(async (req, res) => {
    const deposits = await db.listDeposits();
    const all = [];
    for (const d of deposits) {
      const user = await db.getUser(d.userId);
      all.push({ ...d, nick: user ? user.mcNick : d.userId, statusLabel: statusLabel(d.status) });
    }
    res.json({
      active: all.filter(d => d.status === 'pending' || d.status === 'paid_pending'),
      history: all.filter(d => ['completed', 'cancelled_admin', 'cancelled_player', 'expired'].includes(d.status))
    });
  }));

  router.post('/deposits/:id/fund', ah(async (req, res) => {
    const d = await db.getDeposit(req.params.id);
    if (!d) return res.status(404).json({ error: 'Not found' });
    await db.updateUserBalance(d.userId, d.amount);
    await db.updateDeposit(d.id, { status: 'completed' });
    res.json({ ok: true });
  }));

  router.post('/deposits/:id/reject', ah(async (req, res) => {
    const d = await db.getDeposit(req.params.id);
    if (!d) return res.status(404).json({ error: 'Not found' });
    await db.updateDeposit(d.id, { status: 'cancelled_admin' });
    res.json({ ok: true });
  }));

  router.get('/withdrawals', ah(async (req, res) => {
    const withdrawals = await db.listWithdrawals();
    const all = [];
    for (const w of withdrawals) {
      const user = await db.getUser(w.userId);
      all.push({ ...w, nick: user ? user.mcNick : w.userId, statusLabel: statusLabel(w.status) });
    }
    res.json({
      // 'processing' should only ever exist for the few hundred ms an
      // automatic payout call is in flight — it shows up here (rather
      // than being invisible) so that if the server ever crashes mid
      // payout, an admin can actually see the stuck request and resolve
      // it via /withdrawals/:id/paid (transfer did go through) or
      // /withdrawals/:id/refund (it didn't) below, instead of it quietly
      // sitting there forever with the player's balance already debited.
      active: all.filter(w => ['pending', 'processing'].includes(w.status)),
      history: all.filter(w => ['completed', 'failed', 'cancelled_admin', 'cancelled_player'].includes(w.status))
    });
  }));

  // Manual recovery for a withdrawal stuck in 'processing' (e.g. the
  // server crashed between the spworlds transfer call and recording its
  // result) where an admin has confirmed via spworlds' own transaction
  // history that the AR was NOT actually sent — refunds the player and
  // marks it failed, same end state as an automatic payout failure.
  router.post('/withdrawals/:id/refund', requireAdmin, ah(async (req, res) => {
    const w = await db.getWithdrawal(req.params.id);
    if (!w) return res.status(404).json({ error: 'Not found' });
    if (!['pending', 'processing'].includes(w.status)) {
      return res.status(400).json({ error: `Нельзя вернуть заявку в статусе ${w.status}` });
    }
    await db.updateWithdrawal(w.id, { status: 'failed' });
    await db.updateUserBalance(w.userId, w.amount);
    res.json({ ok: true });
  }));

  router.post('/withdrawals/:id/paid', requireAdmin, ah(async (req, res) => {
    const w = await db.getWithdrawal(req.params.id);
    if (!w) return res.status(404).json({ error: 'Not found' });
    await db.updateWithdrawal(w.id, { status: 'completed' });
    res.json({ ok: true });
  }));

  // ---- statistics reports (download) ----
  router.get('/stats/full-1d', ah(async (req, res) => {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const [bets, deposits] = await Promise.all([
      db.listBetsSince(since),
      db.listDepositsSince(since)
    ]);
    const text = buildFullDayReport(bets, deposits);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="Full-stats-1D.txt"');
    res.send(text);
  }));

  router.get('/stats/7d', ah(async (req, res) => {
    const [rows, users] = await Promise.all([
      getWeeklyAggregateRows(),
      db.listUsers()
    ]);
    const buffer = await buildStatsWorkbookBuffer(rows, users, { title: 'Stats-7D' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Stats-7D.xlsx"');
    res.send(Buffer.from(buffer));
  }));

  router.get('/stats/all', ah(async (req, res) => {
    const [rows, users] = await Promise.all([
      db.aggregateBetsByUserMode(),
      db.listUsers()
    ]);
    const buffer = await buildStatsWorkbookBuffer(rows, users, { title: 'Stats-All' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Stats-All.xlsx"');
    res.send(Buffer.from(buffer));
  }));

  return router;
}

// Background sweep: expire pending deposits whose time ran out.
// server.js calls this on an interval.
export async function expireOldDeposits() {
  const now = Date.now();
  const deposits = await db.listDeposits();
  for (const d of deposits) {
    if (d.status === 'pending' && now > d.expiresAt) {
      await db.updateDeposit(d.id, { status: 'expired' });
    }
  }
}
