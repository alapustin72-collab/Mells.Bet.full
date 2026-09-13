import 'dotenv/config';
import express from 'express';
import cookieSession from 'cookie-session';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import authRoutes, { attachUser } from './src/auth.js';
import gameRoutes from './src/routes-game.js';
import adminRoutes, { expireOldDeposits } from './src/routes-admin.js';
import webhookRoutes from './src/routes-webhooks.js';
import baccaratRoutes from './src/routes-baccarat.js';
import minesRoutes from './src/routes-mines.js';
import blackjackRoutes from './src/routes-blackjack.js';
import { init as initDb } from './src/db.js';
import { setCardWebhook } from './src/spworlds.js';
import { ensureCsrfToken, csrfProtection } from './src/csrf.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Fail closed instead of silently running with a secret anyone who's ever
// read this code already knows. A guessable/known SESSION_SECRET lets an
// attacker forge a valid session cookie for any user id — this MUST come
// from the environment, always, with no fallback.
if (!process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET is not set. Refusing to start with a default/guessable session secret — set a long random value in .env.');
  process.exit(1);
}

const app = express();
const server = http.createServer(app);

// spwmini requires this to be a real HTTP header, not a <meta> tag — the
// frame-ancestors CSP directive is explicitly ignored when set via
// <meta http-equiv="..."> (that's a bug we had, now fixed: the <meta> tag
// was decorative and did nothing). Applied to every response since it's
// harmless for non-HTML ones too.
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "frame-ancestors https://spworlds.ru;");
  next();
});

app.use(express.json({
  // Keep the exact raw bytes of every request body around — needed to
  // verify the spworlds webhook's X-Body-Hash signature, since
  // re-serializing the parsed JSON can produce different bytes than what
  // was actually sent (key order, whitespace) and break the check.
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(cookieSession({
  name: 'spm_session',
  secret: process.env.SESSION_SECRET,
  maxAge: 30 * 24 * 60 * 60 * 1000,
  // The site now runs embedded in an iframe on spworlds.ru (SPWorlds Mini
  // App), so from the browser's point of view our cookie is third-party.
  // SameSite=None + Secure is required for it to be stored/sent at all in
  // that context — plain 'lax' (the old default) gets silently dropped.
  // Needs HTTPS to work; only matters for local http:// dev.
  //
  // This also means the cookie rides along on cross-site requests too —
  // that's exactly what CSRF protection (src/csrf.js, mounted below) is
  // there to guard against.
  sameSite: 'none',
  secure: true
}));
app.use(attachUser);
app.use(ensureCsrfToken);
app.use(csrfProtection);

// Serve the frontend (put your index.html / roulette assets in /public).
app.use(express.static(path.join(__dirname, 'public')));

app.use('/auth', authRoutes);
app.use('/api/game', gameRoutes());
app.use('/api/baccarat', baccaratRoutes());
app.use('/api/mines', minesRoutes);
app.use('/api/blackjack', blackjackRoutes());
app.use('/api/admin', adminRoutes());
app.use('/webhooks', webhookRoutes);

app.get('/api/me', (req, res) => {
  const csrfToken = req.session ? req.session.csrfToken : null;
  if (!req.user) return res.json({ user: null, csrfToken });
  const { id, mcNick, balance, role, code } = req.user;
  res.json({ user: { id, nick: mcNick, balance, role, code }, csrfToken });
});

// Sweep expired deposit tickets every few seconds.
setInterval(() => {
  expireOldDeposits().catch(err => console.error('expireOldDeposits failed:', err));
}, 5000);

const PORT = process.env.PORT || 3000;

initDb()
  .then(async () => {
    // Register the card-level webhook (catches manual AR transfers players
    // send straight to our card, not just our own payment links). Safe to
    // call on every boot — spworlds just overwrites the stored URL.
    // Falls back to RENDER_EXTERNAL_URL (set automatically by Render on
    // every web service) if BASE_URL wasn't configured — this was likely
    // why auto-crediting wasn't firing before: no webhook URL meant
    // spworlds had nothing to call.
    const baseUrl = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
    if (baseUrl) {
      const webhookUrl = `${baseUrl}/webhooks/spworlds/card`;
      try {
        await setCardWebhook(webhookUrl);
        console.log(`spworlds card-level webhook registered: ${webhookUrl}`);
      } catch (err) {
        console.error(`Failed to register spworlds card webhook at ${webhookUrl} (manual-transfer auto-crediting will NOT work until this succeeds):`, err);
      }
    } else {
      console.warn('BASE_URL / RENDER_EXTERNAL_URL not set — skipping spworlds card-webhook registration, auto-crediting will not work');
    }

    server.listen(PORT, () => {
      console.log(`Mells.Bet backend running on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
