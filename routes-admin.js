// ---------------------------------------------------------------------------
// PostgreSQL-backed data layer (replaces the old flat-file data/db.json
// placeholder). Uses a plain connection pool + hand-written SQL (no ORM) so
// there's nothing extra to learn — just src/db.js and this file.
//
// Connection: reads DATABASE_URL from the environment. Render's managed
// Postgres injects this automatically when the DB is attached to the web
// service. For local dev, copy .env.example to .env and set DATABASE_URL to
// a local Postgres instance (or a free Render/Neon/Supabase Postgres URL).
//
// init() creates all tables if they don't exist yet — call it once on
// server startup (see server.js). Every exported function is now async and
// must be awaited by callers.
// ---------------------------------------------------------------------------

import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    'DATABASE_URL is not set. Add a Postgres database and set DATABASE_URL ' +
    '(see .env.example).'
  );
}

// Render (and most managed Postgres hosts) require SSL but use a
// self-signed-style chain that Node rejects by default — disable strict
// verification for the DB connection only. Skip SSL entirely for local
// connections (localhost/127.0.0.1), which usually don't have it enabled.
const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);
export const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false }
});

export async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id             TEXT PRIMARY KEY,
      discord_id     TEXT UNIQUE,
      mc_nick        TEXT NOT NULL,
      password_hash  TEXT,
      balance        NUMERIC(14,2) NOT NULL DEFAULT 0,
      role           TEXT NOT NULL DEFAULT 'player',
      code           TEXT UNIQUE NOT NULL,
      created_at     BIGINT NOT NULL
    );

    CREATE SEQUENCE IF NOT EXISTS user_seq START 1;

    CREATE TABLE IF NOT EXISTS deposits (
      id               TEXT PRIMARY KEY,
      user_id          TEXT NOT NULL REFERENCES users(id),
      amount           BIGINT NOT NULL,
      status           TEXT NOT NULL,
      created_at       BIGINT NOT NULL,
      expires_at       BIGINT,
      paid_clicked_at  BIGINT
    );

    CREATE TABLE IF NOT EXISTS withdrawals (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id),
      amount       BIGINT NOT NULL,
      card         TEXT NOT NULL,
      status       TEXT NOT NULL,
      created_at   BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rounds (
      id            TEXT PRIMARY KEY,
      number        INT NOT NULL,
      color         TEXT NOT NULL,
      bets          JSONB NOT NULL,
      resolved_at   BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS baccarat_rounds (
      id             TEXT PRIMARY KEY,
      player_cards   JSONB NOT NULL,
      banker_cards   JSONB NOT NULL,
      player_total   INT NOT NULL,
      banker_total   INT NOT NULL,
      outcome        TEXT NOT NULL,
      resolved_at    BIGINT NOT NULL
    );

    -- Mines: at most one 'active' row per user at a time (enforced in
    -- application code, see src/mines.js). Persisted (not just in-memory)
    -- so a server restart mid-game doesn't silently eat the player's bet.
    CREATE TABLE IF NOT EXISTS mines_games (
      id               TEXT PRIMARY KEY,
      user_id          TEXT NOT NULL REFERENCES users(id),
      bet_amount       BIGINT NOT NULL,
      mines_count      INT NOT NULL,
      mine_positions   JSONB NOT NULL,
      revealed         JSONB NOT NULL DEFAULT '[]',
      status           TEXT NOT NULL DEFAULT 'active',
      created_at       BIGINT NOT NULL,
      resolved_at      BIGINT
    );

    -- Blackjack: at most one 'active' row per user at a time (enforced in
    -- application code, see src/blackjack.js). Persisted so a server
    -- restart mid-hand doesn't silently eat the player's bet. The dealer's
    -- hole card lives in dealer_cards from the start (server is always
    -- authoritative) — the client just isn't shown it until the hand ends.
    CREATE TABLE IF NOT EXISTS blackjack_games (
      id               TEXT PRIMARY KEY,
      user_id          TEXT NOT NULL REFERENCES users(id),
      bet_amount       NUMERIC(14,2) NOT NULL,
      shoe             JSONB NOT NULL,
      player_cards     JSONB NOT NULL,
      dealer_cards     JSONB NOT NULL,
      status           TEXT NOT NULL DEFAULT 'active',
      outcome          TEXT,
      doubled          BOOLEAN NOT NULL DEFAULT false,
      created_at       BIGINT NOT NULL,
      resolved_at      BIGINT
    );

    -- Every transaction the spworlds card-level webhook reports to us
    -- (see src/routes-webhooks.js), keyed by spworlds' own transaction id.
    -- Purely an audit/idempotency log — never re-processed once inserted.
    CREATE TABLE IF NOT EXISTS spworlds_tx (
      id                TEXT PRIMARY KEY,
      amount            BIGINT NOT NULL,
      sender_username   TEXT,
      comment           TEXT,
      matched_user_id   TEXT REFERENCES users(id),
      credited          BOOLEAN NOT NULL DEFAULT false,
      created_at        BIGINT NOT NULL
    );

    -- Unified per-bet log across every mode (see src/routes-admin.js
    -- "Статистика" reports). One row per resolved bet/hand/spin/round —
    -- written in addition to (not instead of) each mode's own history
    -- table, since this one is purpose-built for admin/support reporting
    -- rather than in-game history strips. Rows are kept forever: the
    -- "last 24h" report is just a WHERE created_at filter over this same
    -- table, not a separate rotating file.
    CREATE TABLE IF NOT EXISTS bet_log (
      id             TEXT PRIMARY KEY,
      user_id        TEXT NOT NULL REFERENCES users(id),
      mode           TEXT NOT NULL,
      stake          NUMERIC(14,2) NOT NULL,
      winnings       NUMERIC(14,2) NOT NULL,
      outcome        TEXT NOT NULL,
      detail         TEXT,
      created_at     BIGINT NOT NULL
    );

    -- Singleton cache for the "Stats-7D" admin report: recomputed lazily
    -- the first time it's requested on/after a given Sunday, then served
    -- unchanged for the rest of the week (see routes-admin.js).
    CREATE TABLE IF NOT EXISTS weekly_stats_snapshot (
      id            TEXT PRIMARY KEY DEFAULT 'weekly',
      week_start    BIGINT NOT NULL,
      week_end      BIGINT NOT NULL,
      data          JSONB NOT NULL,
      computed_at   BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_deposits_user ON deposits(user_id);
    CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(user_id);
    CREATE INDEX IF NOT EXISTS idx_rounds_resolved_at ON rounds(resolved_at DESC);
    CREATE INDEX IF NOT EXISTS idx_baccarat_rounds_resolved_at ON baccarat_rounds(resolved_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bet_log_created_at ON bet_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_bet_log_user_mode ON bet_log(user_id, mode);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mines_games_active_user
      ON mines_games(user_id) WHERE status = 'active';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_blackjack_games_active_user
      ON blackjack_games(user_id) WHERE status = 'active';
  `);

  // Older deployments created discord_id/mc_nick before username/password
  // login existed. These two changes are done separately and defensively
  // (not inside the block above) because they can fail on pre-existing
  // data — a NOT NULL column that already has rows, or duplicate mc_nick
  // values from before logins were unique — and a failure here shouldn't
  // crash the whole server on startup.
  try {
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT');
  } catch (err) {
    console.warn('db init: could not add password_hash column:', err.message);
  }
  try {
    await pool.query('ALTER TABLE users ALTER COLUMN discord_id DROP NOT NULL');
  } catch (err) {
    console.warn('db init: could not relax discord_id NOT NULL (probably already relaxed):', err.message);
  }
  try {
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_mc_nick_lower ON users (lower(mc_nick))');
  } catch (err) {
    console.warn('db init: could not create unique index on mc_nick — likely duplicate nicknames already exist. Username/password login may misbehave until this is resolved manually:', err.message);
  }
  // Older deployments created balance as BIGINT (whole numbers only) before
  // winnings gained 2-decimal precision — widen it to NUMERIC so fractional
  // credits (e.g. Mines/Baccarat payouts) aren't silently truncated.
  try {
    await pool.query('ALTER TABLE users ALTER COLUMN balance TYPE NUMERIC(14,2)');
  } catch (err) {
    console.warn('db init: could not widen balance column to NUMERIC(14,2):', err.message);
  }
  // Blackjack gained Split support after blackjack_games already shipped
  // with a single-hand shape (one bet_amount/player_cards/doubled per
  // game). Splitting needs an array of hands instead, so we add the new
  // columns and relax the old single-hand ones to nullable rather than
  // dropping them — the app code now only reads/writes player_hands +
  // active_hand, but this keeps any already-deployed table happy either
  // way and never touches existing rows.
  try {
    await pool.query('ALTER TABLE blackjack_games ADD COLUMN IF NOT EXISTS player_hands JSONB');
    await pool.query('ALTER TABLE blackjack_games ADD COLUMN IF NOT EXISTS active_hand INT NOT NULL DEFAULT 0');
    await pool.query('ALTER TABLE blackjack_games ALTER COLUMN player_cards DROP NOT NULL');
    await pool.query('ALTER TABLE blackjack_games ALTER COLUMN bet_amount DROP NOT NULL');
    await pool.query('ALTER TABLE blackjack_games ALTER COLUMN doubled DROP NOT NULL');
  } catch (err) {
    console.warn('db init: could not migrate blackjack_games for split support:', err.message);
  }

  // SPWorlds Mini App migration: identity now comes from spworlds' signed
  // postMessage data (accountId/username/minecraftUUID) instead of Discord
  // OAuth or a typed username/password, so accounts are keyed by
  // spwmini_account_id going forward. Old columns are left alone (nullable
  // already) so existing rows aren't touched.
  try {
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS spwmini_account_id TEXT');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS minecraft_uuid TEXT');
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_spwmini_account_id
      ON users (spwmini_account_id) WHERE spwmini_account_id IS NOT NULL
    `);
  } catch (err) {
    console.warn('db init: could not migrate users for SPWorlds Mini App auth:', err.message);
  }
}

function rowToUser(r) {
  if (!r) return null;
  return {
    id: r.id,
    discordId: r.discord_id,
    spwminiAccountId: r.spwmini_account_id,
    minecraftUUID: r.minecraft_uuid,
    mcNick: r.mc_nick,
    hasPassword: !!r.password_hash, // never expose the hash itself
    balance: Number(r.balance),
    role: r.role,
    code: r.code,
    createdAt: Number(r.created_at)
  };
}

function rowToDeposit(r) {
  if (!r) return null;
  return {
    id: r.id,
    userId: r.user_id,
    amount: Number(r.amount),
    status: r.status,
    createdAt: Number(r.created_at),
    expiresAt: r.expires_at !== null ? Number(r.expires_at) : null,
    paidClickedAt: r.paid_clicked_at !== null ? Number(r.paid_clicked_at) : null
  };
}

function rowToWithdrawal(r) {
  if (!r) return null;
  return {
    id: r.id,
    userId: r.user_id,
    amount: Number(r.amount),
    card: r.card,
    status: r.status,
    createdAt: Number(r.created_at)
  };
}

function rowToRound(r) {
  if (!r) return null;
  return {
    id: r.id,
    number: r.number,
    color: r.color,
    bets: r.bets,
    resolvedAt: Number(r.resolved_at)
  };
}

async function generateUniqueCode() {
  // 100,000 possible 5-digit codes; loop is essentially always 1 iteration.
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = String(Math.floor(Math.random() * 100000)).padStart(5, '0');
    const { rows } = await pool.query('SELECT 1 FROM users WHERE code = $1', [code]);
    if (rows.length === 0) return code;
  }
  throw new Error('Could not generate a unique code');
}

// All reads/writes go through these helpers so callers never touch SQL
// directly. Every function here is async — callers must await it.
export const db = {
  async getUserByDiscordId(discordId) {
    const { rows } = await pool.query('SELECT * FROM users WHERE discord_id = $1', [discordId]);
    return rowToUser(rows[0]);
  },

  // Case-insensitive — Minecraft nicknames as reported by spworlds should
  // match exactly, but this guards against stray case differences.
  async getUserByNick(nick) {
    const { rows } = await pool.query('SELECT * FROM users WHERE lower(mc_nick) = lower($1)', [nick]);
    return rowToUser(rows[0]);
  },

  async createUser({ discordId, mcNick }) {
    const { rows: seqRows } = await pool.query("SELECT nextval('user_seq') AS n");
    const id = 'u' + seqRows[0].n;
    const code = await generateUniqueCode();
    const createdAt = Date.now();
    const { rows } = await pool.query(
      `INSERT INTO users (id, discord_id, mc_nick, balance, role, code, created_at)
       VALUES ($1, $2, $3, 0, 'player', $4, $5)
       RETURNING *`,
      [id, discordId, mcNick, code, createdAt]
    );
    return rowToUser(rows[0]);
  },

  // SPWorlds Mini App auth: account keyed by the player's spwmini
  // accountId, no registration step — created automatically on first
  // launch inside the mini app, right after checkUser() verifies the
  // signed identity spworlds handed us.
  async getUserBySpwminiAccountId(accountId) {
    const { rows } = await pool.query('SELECT * FROM users WHERE spwmini_account_id = $1', [String(accountId)]);
    return rowToUser(rows[0]);
  },

  async createUserFromSpwmini({ accountId, mcNick, minecraftUUID }) {
    const { rows: seqRows } = await pool.query("SELECT nextval('user_seq') AS n");
    const id = 'u' + seqRows[0].n;
    const code = await generateUniqueCode();
    const createdAt = Date.now();
    const { rows } = await pool.query(
      `INSERT INTO users (id, spwmini_account_id, mc_nick, minecraft_uuid, balance, role, code, created_at)
       VALUES ($1, $2, $3, $4, 0, 'player', $5, $6)
       RETURNING *`,
      [id, String(accountId), mcNick, minecraftUUID || null, code, createdAt]
    );
    return rowToUser(rows[0]);
  },

  async updateUserNick(userId, nick) {
    await pool.query('UPDATE users SET mc_nick = $1 WHERE id = $2', [nick, userId]);
  },

  // Username/password registration ("Регистрация" → "Имя"). No Discord ID,
  // no spworlds verification — the username is just whatever the player
  // typed. See auth-local.js for the caveats around not being able to
  // verify server membership this way while Discord OAuth is down.
  async createUserLocal({ username, passwordHash }) {
    const { rows: seqRows } = await pool.query("SELECT nextval('user_seq') AS n");
    const id = 'u' + seqRows[0].n;
    const code = await generateUniqueCode();
    const createdAt = Date.now();
    const { rows } = await pool.query(
      `INSERT INTO users (id, discord_id, mc_nick, password_hash, balance, role, code, created_at)
       VALUES ($1, NULL, $2, $3, 0, 'player', $4, $5)
       RETURNING *`,
      [id, username, passwordHash, code, createdAt]
    );
    return rowToUser(rows[0]);
  },

  // Raw row including password_hash, for login verification only — never
  // pass this straight back out through an API response.
  async getAuthRowByUsername(username) {
    const { rows } = await pool.query('SELECT * FROM users WHERE lower(mc_nick) = lower($1)', [username]);
    return rows[0] || null;
  },

  async isUsernameTaken(username) {
    const { rows } = await pool.query('SELECT 1 FROM users WHERE lower(mc_nick) = lower($1)', [username]);
    return rows.length > 0;
  },

  async getUserByCode(code) {
    const { rows } = await pool.query('SELECT * FROM users WHERE code = $1', [code]);
    return rowToUser(rows[0]);
  },

  async getUser(id) {
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return rowToUser(rows[0]);
  },

  // Atomic, race-safe balance update: the WHERE clause enforces
  // "don't go below zero" inside the database itself instead of a
  // read-then-write in JS (which was safe only because the old JSON file
  // was accessed from a single process with no real concurrency).
  async updateUserBalance(id, delta) {
    // Balance now carries 2 decimal places — round the delta to the
    // nearest cent/kopeck so float rounding noise never accumulates.
    const roundedDelta = Math.round(delta * 100) / 100;
    const { rows } = await pool.query(
      `UPDATE users SET balance = balance + $1
       WHERE id = $2 AND balance + $1 >= 0
       RETURNING balance`,
      [roundedDelta, id]
    );
    if (rows.length === 0) {
      const user = await db.getUser(id);
      if (!user) throw new Error('User not found');
      throw new Error('Insufficient balance');
    }
    return Number(rows[0].balance);
  },

  async setUserRole(id, role) {
    const { rowCount } = await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
    if (rowCount === 0) throw new Error('User not found');
  },

  async listUsers() {
    const { rows } = await pool.query('SELECT * FROM users ORDER BY created_at ASC');
    return rows.map(rowToUser);
  },

  // ---- deposits ----
  async createDeposit(deposit) {
    await pool.query(
      `INSERT INTO deposits (id, user_id, amount, status, created_at, expires_at, paid_clicked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [deposit.id, deposit.userId, deposit.amount, deposit.status,
       deposit.createdAt, deposit.expiresAt ?? null, deposit.paidClickedAt ?? null]
    );
    return deposit;
  },
  async listDeposits() {
    const { rows } = await pool.query('SELECT * FROM deposits ORDER BY created_at DESC');
    return rows.map(rowToDeposit);
  },
  async getDeposit(id) {
    const { rows } = await pool.query('SELECT * FROM deposits WHERE id = $1', [id]);
    return rowToDeposit(rows[0]);
  },
  // Used by the spworlds card webhook (src/routes-webhooks.js): atomically
  // claims (and marks 'completed') the one pending deposit for this user
  // whose requested amount exactly matches the transfer amount — so a
  // deposit only ever gets credited once, even if two webhook deliveries
  // for it arrive at nearly the same moment (FOR UPDATE SKIP LOCKED makes
  // the claim itself race-safe, not just the status check). Returns the
  // claimed deposit row, or null if there's no pending request from this
  // user for that exact amount.
  async claimPendingDepositForUser(userId, amount) {
    const { rows } = await pool.query(
      `WITH claimed AS (
         SELECT id FROM deposits
         WHERE user_id = $1 AND amount = $2 AND status IN ('pending', 'paid_pending')
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE deposits SET status = 'completed'
       WHERE id IN (SELECT id FROM claimed)
       RETURNING *`,
      [userId, amount]
    );
    return rowToDeposit(rows[0]);
  },
  // Used by the main per-payment webhook (src/routes-webhooks.js
  // POST /spworlds): atomically flips a specific deposit to 'completed'
  // ONLY if it's still pending/paid_pending, in one statement — so two
  // concurrent webhook deliveries for the same deposit can't both see it
  // as "not yet completed" and both trigger a balance credit. The caller
  // must only credit the balance if this returns a row.
  async claimDepositById(id) {
    const { rows } = await pool.query(
      `WITH claimed AS (
         SELECT id FROM deposits
         WHERE id = $1 AND status IN ('pending', 'paid_pending')
         FOR UPDATE SKIP LOCKED
       )
       UPDATE deposits SET status = 'completed'
       WHERE id IN (SELECT id FROM claimed)
       RETURNING *`,
      [id]
    );
    return rowToDeposit(rows[0]);
  },
  async updateDeposit(id, patch) {
    const current = await db.getDeposit(id);
    if (!current) return null;
    const merged = { ...current, ...patch };
    const { rows } = await pool.query(
      `UPDATE deposits SET status = $1, expires_at = $2, paid_clicked_at = $3
       WHERE id = $4 RETURNING *`,
      [merged.status, merged.expiresAt ?? null, merged.paidClickedAt ?? null, id]
    );
    return rowToDeposit(rows[0]);
  },

  // ---- withdrawals ----
  async createWithdrawal(w) {
    await pool.query(
      `INSERT INTO withdrawals (id, user_id, amount, card, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [w.id, w.userId, w.amount, w.card, w.status, w.createdAt]
    );
    return w;
  },
  async listWithdrawals() {
    const { rows } = await pool.query('SELECT * FROM withdrawals ORDER BY created_at DESC');
    return rows.map(rowToWithdrawal);
  },
  async getWithdrawal(id) {
    const { rows } = await pool.query('SELECT * FROM withdrawals WHERE id = $1', [id]);
    return rowToWithdrawal(rows[0]);
  },
  // Atomically flips a withdrawal from 'pending' to 'cancelled_player' in
  // one statement, only if it's still pending — so two concurrent cancel
  // requests for the same withdrawal (e.g. double-clicked, or replayed)
  // can't both pass a "is it still pending?" check and both trigger a
  // refund. The caller must only refund the balance if this returns a row.
  //
  // Note this also naturally protects against a cancel racing an
  // in-flight automatic payout (see claimWithdrawalForPayout below):
  // once a payout attempt has claimed the row into 'processing', this
  // WHERE clause simply no longer matches it.
  async cancelPendingWithdrawal(id, userId) {
    const { rows } = await pool.query(
      `UPDATE withdrawals SET status = 'cancelled_player'
       WHERE id = $1 AND user_id = $2 AND status = 'pending'
       RETURNING *`,
      [id, userId]
    );
    return rowToWithdrawal(rows[0]);
  },
  // Atomic claim used right before attempting an automatic payout (see
  // POST /withdrawals in routes-admin.js): flips 'pending' -> 'processing'
  // in one statement. This is what stops the exact race the security
  // review flagged for automatic payouts specifically — without it, a
  // cancel request arriving while the real spworlds transfer is in
  // flight could refund the balance via cancelPendingWithdrawal (still
  // 'pending' as far as it's concerned) at the same time the transfer
  // actually succeeds, leaving the player with BOTH their balance back
  // AND the real AR. Once this claim succeeds, cancelPendingWithdrawal's
  // own `WHERE status = 'pending'` can no longer match this row, so
  // cancellation is impossible from this point until the payout attempt
  // finishes and moves it to a terminal status.
  async claimWithdrawalForPayout(id, userId) {
    const { rows } = await pool.query(
      `UPDATE withdrawals SET status = 'processing'
       WHERE id = $1 AND user_id = $2 AND status = 'pending'
       RETURNING *`,
      [id, userId]
    );
    return rowToWithdrawal(rows[0]);
  },
  async updateWithdrawal(id, patch) {
    const current = await db.getWithdrawal(id);
    if (!current) return null;
    const merged = { ...current, ...patch };
    const { rows } = await pool.query(
      'UPDATE withdrawals SET status = $1 WHERE id = $2 RETURNING *',
      [merged.status, id]
    );
    return rowToWithdrawal(rows[0]);
  },

  // ---- round history ----
  async logRound(round) {
    await pool.query(
      `INSERT INTO rounds (id, number, color, bets, resolved_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [round.id, round.number, round.color, JSON.stringify(round.bets), round.resolvedAt]
    );
    // Keep the table from growing forever — trim anything beyond the most
    // recent 500 rounds. Cheap enough to run every insert at this volume.
    await pool.query(`
      DELETE FROM rounds WHERE id IN (
        SELECT id FROM rounds ORDER BY resolved_at DESC OFFSET 500
      )
    `);
  },
  async recentRounds(limit = 20) {
    const { rows } = await pool.query(
      'SELECT * FROM rounds ORDER BY resolved_at DESC LIMIT $1',
      [limit]
    );
    return rows.map(rowToRound);
  },

  // ---- baccarat round history ----
  async logBaccaratRound(round) {
    await pool.query(
      `INSERT INTO baccarat_rounds (id, player_cards, banker_cards, player_total, banker_total, outcome, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [round.id, JSON.stringify(round.playerCards), JSON.stringify(round.bankerCards),
       round.playerTotal, round.bankerTotal, round.outcome, round.resolvedAt]
    );
    await pool.query(`
      DELETE FROM baccarat_rounds WHERE id IN (
        SELECT id FROM baccarat_rounds ORDER BY resolved_at DESC OFFSET 500
      )
    `);
  },
  async recentBaccaratRounds(limit = 20) {
    const { rows } = await pool.query(
      'SELECT * FROM baccarat_rounds ORDER BY resolved_at DESC LIMIT $1',
      [limit]
    );
    return rows.map(r => ({
      id: r.id,
      playerCards: r.player_cards,
      bankerCards: r.banker_cards,
      playerTotal: r.player_total,
      bankerTotal: r.banker_total,
      outcome: r.outcome,
      resolvedAt: Number(r.resolved_at)
    }));
  },

  // ---- spworlds card-level transaction log (see src/routes-webhooks.js) ----
  async hasSpworldsTx(id) {
    const { rows } = await pool.query('SELECT 1 FROM spworlds_tx WHERE id = $1', [id]);
    return rows.length > 0;
  },
  async recordSpworldsTx({ id, amount, senderUsername, comment, matchedUserId, credited, createdAt }) {
    await pool.query(
      `INSERT INTO spworlds_tx (id, amount, sender_username, comment, matched_user_id, credited, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [id, amount, senderUsername ?? null, comment ?? null, matchedUserId ?? null, !!credited, createdAt]
    );
  },
  // Transfers that arrived with no matching registered player — surfaced to
  // admins so they can manually credit once they figure out who it was.
  async listUnmatchedSpworldsTx() {
    const { rows } = await pool.query(
      'SELECT * FROM spworlds_tx WHERE matched_user_id IS NULL ORDER BY created_at DESC LIMIT 100'
    );
    return rows.map(r => ({
      id: r.id,
      amount: Number(r.amount),
      senderUsername: r.sender_username,
      comment: r.comment,
      createdAt: Number(r.created_at)
    }));
  },

  // ---- mines games (see src/mines.js) ----
  async createMinesGame({ id, userId, betAmount, minesCount, minePositions, createdAt }) {
    try {
      const { rows } = await pool.query(
        `INSERT INTO mines_games (id, user_id, bet_amount, mines_count, mine_positions, revealed, status, created_at)
         VALUES ($1, $2, $3, $4, $5, '[]', 'active', $6)
         RETURNING *`,
        [id, userId, betAmount, minesCount, JSON.stringify(minePositions), createdAt]
      );
      return rowToMinesGame(rows[0]);
    } catch (err) {
      // Hits the partial unique index (idx_mines_games_active_user) if a
      // second "start" request raced in before the first one committed.
      if (err.code === '23505') throw new Error('У вас уже есть активная игра');
      throw err;
    }
  },
  async getActiveMinesGame(userId) {
    const { rows } = await pool.query(
      "SELECT * FROM mines_games WHERE user_id = $1 AND status = 'active'",
      [userId]
    );
    return rowToMinesGame(rows[0]);
  },
  async updateMinesGame(id, patch) {
    const current = await pool.query('SELECT * FROM mines_games WHERE id = $1', [id]);
    if (!current.rows[0]) return null;
    const cur = rowToMinesGame(current.rows[0]);
    const merged = { ...cur, ...patch };
    const { rows } = await pool.query(
      `UPDATE mines_games SET revealed = $1, status = $2, resolved_at = $3
       WHERE id = $4 RETURNING *`,
      [JSON.stringify(merged.revealed), merged.status, merged.resolvedAt ?? null, id]
    );
    return rowToMinesGame(rows[0]);
  },
  // Atomic terminal transition ('active' -> 'lost'/'cashed_out') in one
  // statement — only succeeds if the game is still 'active'. Two
  // concurrent requests that both resolve the same game (e.g. two
  // cash-out clicks, or cash-out racing a losing reveal) can no longer
  // both pass a "is it still active?" check and both trigger a payout:
  // whichever request's UPDATE commits first wins, the other gets 0 rows
  // back. The caller must only credit balance / log the bet if this
  // returns a row.
  async resolveMinesGame(id, userId, patch) {
    const { rows } = await pool.query(
      `UPDATE mines_games SET revealed = $1, status = $2, resolved_at = $3
       WHERE id = $4 AND user_id = $5 AND status = 'active'
       RETURNING *`,
      [JSON.stringify(patch.revealed), patch.status, patch.resolvedAt ?? null, id, userId]
    );
    return rowToMinesGame(rows[0]);
  },

  // ---- blackjack games (see src/blackjack.js) ----
  async createBlackjackGame({ id, userId, shoe, playerHands, dealerCards, createdAt }) {
    try {
      const { rows } = await pool.query(
        `INSERT INTO blackjack_games (id, user_id, shoe, player_hands, active_hand, dealer_cards, status, created_at)
         VALUES ($1, $2, $3, $4, 0, $5, 'active', $6)
         RETURNING *`,
        [id, userId, JSON.stringify(shoe), JSON.stringify(playerHands), JSON.stringify(dealerCards), createdAt]
      );
      return rowToBlackjackGame(rows[0]);
    } catch (err) {
      // Hits the partial unique index (idx_blackjack_games_active_user) if a
      // second "deal" request raced in before the first one committed.
      if (err.code === '23505') throw new Error('У вас уже есть активная игра');
      throw err;
    }
  },
  async getActiveBlackjackGame(userId) {
    const { rows } = await pool.query(
      "SELECT * FROM blackjack_games WHERE user_id = $1 AND status = 'active'",
      [userId]
    );
    return rowToBlackjackGame(rows[0]);
  },
  async updateBlackjackGame(id, patch) {
    const current = await pool.query('SELECT * FROM blackjack_games WHERE id = $1', [id]);
    if (!current.rows[0]) return null;
    const cur = rowToBlackjackGame(current.rows[0]);
    const merged = { ...cur, ...patch };
    const { rows } = await pool.query(
      `UPDATE blackjack_games SET shoe = $1, player_hands = $2, active_hand = $3,
         dealer_cards = $4, status = $5, resolved_at = $6
       WHERE id = $7 RETURNING *`,
      [
        JSON.stringify(merged.shoe), JSON.stringify(merged.playerHands), merged.activeHand,
        JSON.stringify(merged.dealerCards), merged.status, merged.resolvedAt ?? null,
        id
      ]
    );
    return rowToBlackjackGame(rows[0]);
  },

  // ---- unified bet log (see src/routes-admin.js "Статистика" reports) ----
  async logBet({ id, userId, mode, stake, winnings, outcome, detail, createdAt }) {
    await pool.query(
      `INSERT INTO bet_log (id, user_id, mode, stake, winnings, outcome, detail, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, userId, mode, stake, winnings, outcome, detail ?? null, createdAt]
    );
  },
  // Raw rows for the "Full-stats-1D" text report — every bet AND deposit
  // from the last 24h (each entry ages out of THIS report 24h after it
  // was written, not on some fixed daily boundary), joined with the
  // player's nickname/code for support to look them up by.
  async listBetsSince(sinceTs) {
    const { rows } = await pool.query(
      `SELECT b.*, u.mc_nick, u.code FROM bet_log b
       JOIN users u ON u.id = b.user_id
       WHERE b.created_at >= $1
       ORDER BY b.created_at ASC`,
      [sinceTs]
    );
    return rows.map(r => ({
      id: r.id, userId: r.user_id, nick: r.mc_nick, code: r.code, mode: r.mode,
      stake: Number(r.stake), winnings: Number(r.winnings), outcome: r.outcome,
      detail: r.detail, createdAt: Number(r.created_at)
    }));
  },
  async listDepositsSince(sinceTs) {
    const { rows } = await pool.query(
      `SELECT d.*, u.mc_nick, u.code FROM deposits d
       JOIN users u ON u.id = d.user_id
       WHERE d.created_at >= $1
       ORDER BY d.created_at ASC`,
      [sinceTs]
    );
    return rows.map(r => ({
      id: r.id, userId: r.user_id, nick: r.mc_nick, code: r.code,
      amount: Number(r.amount), status: r.status, createdAt: Number(r.created_at)
    }));
  },
  // Aggregated (user × mode) totals for the "Stats-7D"/"Stats-All" Excel
  // reports — summed in SQL rather than pulled row-by-row into Node, since
  // "Stats-All" has no time bound and can cover the whole table's history.
  async aggregateBetsByUserMode({ sinceTs = null, untilTs = null } = {}) {
    const params = [];
    let where = '';
    if (sinceTs !== null) { params.push(sinceTs); where += ` AND b.created_at >= $${params.length}`; }
    if (untilTs !== null) { params.push(untilTs); where += ` AND b.created_at < $${params.length}`; }
    const { rows } = await pool.query(
      `SELECT u.id AS user_id, u.mc_nick, b.mode,
              SUM(b.stake) AS stake, SUM(b.winnings) AS winnings, COUNT(*) AS bets
       FROM bet_log b
       JOIN users u ON u.id = b.user_id
       WHERE true ${where}
       GROUP BY u.id, u.mc_nick, b.mode
       ORDER BY u.mc_nick ASC, b.mode ASC`,
      params
    );
    return rows.map(r => ({
      userId: r.user_id, nick: r.mc_nick, mode: r.mode,
      stake: Number(r.stake), winnings: Number(r.winnings), bets: Number(r.bets)
    }));
  },

  // ---- weekly stats snapshot (see src/routes-admin.js Stats-7D) ----
  async getWeeklySnapshot() {
    const { rows } = await pool.query("SELECT * FROM weekly_stats_snapshot WHERE id = 'weekly'");
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      weekStart: Number(r.week_start), weekEnd: Number(r.week_end),
      data: r.data, computedAt: Number(r.computed_at)
    };
  },
  async saveWeeklySnapshot({ weekStart, weekEnd, data, computedAt }) {
    await pool.query(
      `INSERT INTO weekly_stats_snapshot (id, week_start, week_end, data, computed_at)
       VALUES ('weekly', $1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET week_start = $1, week_end = $2, data = $3, computed_at = $4`,
      [weekStart, weekEnd, JSON.stringify(data), computedAt]
    );
  }
};

function rowToMinesGame(r) {
  if (!r) return null;
  return {
    id: r.id,
    userId: r.user_id,
    betAmount: Number(r.bet_amount),
    minesCount: r.mines_count,
    minePositions: r.mine_positions,
    revealed: r.revealed,
    status: r.status,
    createdAt: Number(r.created_at),
    resolvedAt: r.resolved_at !== null ? Number(r.resolved_at) : null
  };
}

function rowToBlackjackGame(r) {
  if (!r) return null;
  return {
    id: r.id,
    userId: r.user_id,
    shoe: r.shoe,
    playerHands: r.player_hands,
    activeHand: r.active_hand,
    dealerCards: r.dealer_cards,
    status: r.status,
    createdAt: Number(r.created_at),
    resolvedAt: r.resolved_at !== null ? Number(r.resolved_at) : null
  };
}
