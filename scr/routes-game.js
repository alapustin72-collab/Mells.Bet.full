// ---------------------------------------------------------------------------
// SPWorlds Mini App auth. There is no registration or login screen — the
// app only ever runs embedded inside spworlds.ru, which hands the frontend
// the player's signed identity (accountId, username = their spworlds/MC
// nickname, minecraftUUID, hash) via postMessage (see the `spwmini`
// package used in public/index.html). The frontend POSTs that object here
// on every load; we verify the signature server-side with checkUser() and
// either find the matching account or create one on the spot — the player
// is playing under their real spworlds account the instant the app opens.
// ---------------------------------------------------------------------------

import express from 'express';
import { checkUser } from 'spwmini/middleware';
import { db } from './db.js';

const router = express.Router();

router.post('/spwmini', async (req, res) => {
  const body = req.body || {};
  const { accountId, username, minecraftUUID, hash } = body;
  if (!accountId || !username || !hash) {
    return res.status(400).json({ error: 'Missing SPWorlds identity data' });
  }

  const token = process.env.SPWORLDS_MINIAPP_TOKEN;
  if (!token) {
    console.error('SPWORLDS_MINIAPP_TOKEN not set in .env — cannot verify mini app identity');
    return res.status(500).json({ error: 'Server not configured' });
  }

  let valid;
  try {
    // Pass the FULL payload spworlds sent — checkUser() recomputes the
    // signature from every field of the object except `hash`. An earlier
    // version of this route rebuilt a smaller object with only
    // {accountId, username, minecraftUUID, hash} before calling
    // checkUser(), silently dropping any other signed fields spworlds
    // includes (e.g. timestamp, roles, isAdmin) — that makes the
    // recomputed hash mismatch even a completely genuine payload. Only
    // pull out the specific fields we actually use AFTER the signature
    // has been confirmed valid, from `body` (already have it above).
    valid = checkUser(body, token);
  } catch (err) {
    console.error('checkUser threw:', err);
    return res.status(400).json({ error: 'Invalid SPWorlds signature' });
  }
  if (!valid) {
    return res.status(403).json({ error: 'Invalid SPWorlds signature' });
  }

  // Note: `body` may also contain fields like `timestamp`, `roles`, or
  // `isAdmin` depending on what spworlds includes in the signed payload —
  // those are only used above to make the signature check itself pass;
  // we deliberately never read them for authorization. Admin status is
  // decided solely by our own DB (`user.role`, set via db.setUserRole),
  // never by anything the client — or a payload replayed/edited by the
  // client — claims about itself.
  try {
    let user = await db.getUserBySpwminiAccountId(accountId);    if (!user) {
      user = await db.createUserFromSpwmini({ accountId, mcNick: username, minecraftUUID });

      // Bootstrap admin role from env, one time, on first login only.
      const bootstrapIds = (process.env.BOOTSTRAP_ADMIN_SPWMINI_IDS || '')
        .split(',').map(s => s.trim()).filter(Boolean);
      if (bootstrapIds.includes(String(accountId))) {
        await db.setUserRole(user.id, 'admin');
      }
    } else if (user.mcNick !== username) {
      // Player renamed on spworlds since their last visit — keep it synced.
      try {
        await db.updateUserNick(user.id, username);
        user = await db.getUser(user.id);
      } catch (err) {
        console.warn(`Could not sync nickname for ${user.id} to "${username}":`, err.message);
      }
    }

    req.session.userId = user.id;
    // ensureCsrfToken (server.js) already minted req.session.csrfToken for
    // this session before this handler ran — just hand it back so the
    // frontend can start sending it on every mutating request.
    const { id, mcNick, balance, role, code } = user;
    res.json({ user: { id, nick: mcNick, balance, role, code }, csrfToken: req.session.csrfToken });
  } catch (err) {
    console.error('spwmini login failed:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

// Middleware: attaches req.user if logged in.
export async function attachUser(req, res, next) {
  try {
    if (req.session && req.session.userId) {
      req.user = await db.getUser(req.session.userId);
    }
    next();
  } catch (err) {
    next(err);
  }
}

// Middleware: requires login.
export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}

// Middleware: requires admin role (checked against the DB, never the nickname).
export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

export default router;
