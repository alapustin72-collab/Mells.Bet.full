// ---------------------------------------------------------------------------
// Server-authoritative Mines. Unlike roulette/baccarat this is a private,
// per-player game — no shared round, no countdown, no other players
// involved. State is persisted in the DB (see db.js mines_games table) so
// an active game survives a server restart instead of silently eating the
// player's bet.
//
// Rules: a 5x5 grid (25 tiles) hides `minesCount` mines. The player reveals
// tiles one at a time; each safe reveal raises the payout multiplier.
// Hitting a mine ends the game with the bet already lost (it was debited
// at start). The player can cash out at any point after revealing at least
// one safe tile, banking bet * currentMultiplier.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import { db } from './db.js';
import { withLock } from './lock.js';

export const GRID_SIZE = 25;
const HOUSE_EDGE = 0.08; // 8% — RTP 92%
const MIN_MINES = 1;
const MAX_MINES = 24;
const MAX_BET = 50;
const MAX_MULTIPLIER = 100; // payout is capped at 100x the bet — see revealTile()

// Balances now carry 2 decimal places (see db.js) so payouts aren't shaved
// by integer flooring — round to the cent/kopeck instead.
function round2(n) {
  return Math.round(n * 100) / 100;
}

function secureRandomInt(maxExclusive) {
  const bytes = crypto.randomBytes(4);
  return bytes.readUInt32BE(0) % maxExclusive;
}

function pickMinePositions(minesCount) {
  const positions = Array.from({ length: GRID_SIZE }, (_, i) => i);
  // Partial Fisher-Yates — only need to shuffle enough to pick minesCount
  // unique positions, but shuffling the whole thing is simple and cheap
  // at this size (25 items).
  for (let i = positions.length - 1; i > 0; i--) {
    const j = secureRandomInt(i + 1);
    [positions[i], positions[j]] = [positions[j], positions[i]];
  }
  return positions.slice(0, minesCount).sort((a, b) => a - b);
}

// Fair multiplier for having safely revealed `safeCount` tiles out of a
// grid with `minesCount` mines, based on the hypergeometric probability of
// avoiding every mine that many times in a row — then shaved by the house
// edge, same as any other casino game's odds.
export function multiplierFor(minesCount, safeCount) {
  if (safeCount <= 0) return 1;
  let probability = 1;
  for (let i = 0; i < safeCount; i++) {
    probability *= (GRID_SIZE - minesCount - i) / (GRID_SIZE - i);
  }
  const fairMultiplier = 1 / probability;
  return fairMultiplier * (1 - HOUSE_EDGE);
}

// Payout-facing multiplier — same formula, but never pays out more than
// MAX_MULTIPLIER times the bet, regardless of how favorable the raw odds
// math would otherwise allow.
function cappedMultiplierFor(minesCount, safeCount) {
  return Math.min(multiplierFor(minesCount, safeCount), MAX_MULTIPLIER);
}

function toPublicGame(game, { revealMines = false } = {}) {
  return {
    id: game.id,
    betAmount: game.betAmount,
    minesCount: game.minesCount,
    revealed: game.revealed,
    status: game.status,
    multiplier: Number(cappedMultiplierFor(game.minesCount, game.revealed.length).toFixed(4)),
    minePositions: revealMines ? game.minePositions : undefined
  };
}

export async function startGame(userId, betAmount, minesCount) {
  return withLock(userId, async () => {
    if (!Number.isInteger(betAmount) || betAmount < 1 || betAmount > MAX_BET) {
      throw new Error(`Ставка от 1 до ${MAX_BET}`);
    }
    if (!Number.isInteger(minesCount) || minesCount < MIN_MINES || minesCount > MAX_MINES) {
      throw new Error(`Количество мин от ${MIN_MINES} до ${MAX_MINES}`);
    }

    const existing = await db.getActiveMinesGame(userId);
    if (existing) throw new Error('У вас уже есть активная игра');

    await db.updateUserBalance(userId, -betAmount); // throws if insufficient

    const game = await db.createMinesGame({
      id: crypto.randomUUID(),
      userId,
      betAmount,
      minesCount,
      minePositions: pickMinePositions(minesCount),
      createdAt: Date.now()
    });

    return toPublicGame(game);

  });
}

export async function revealTile(userId, tileIndex) {
  return withLock(userId, async () => {
    if (!Number.isInteger(tileIndex) || tileIndex < 0 || tileIndex >= GRID_SIZE) {
      throw new Error('Некорректная клетка');
    }
    const game = await db.getActiveMinesGame(userId);
    if (!game) throw new Error('Нет активной игры');
    if (game.revealed.includes(tileIndex)) throw new Error('Эта клетка уже открыта');

    const hitMine = game.minePositions.includes(tileIndex);

    if (hitMine) {
      // Atomic claim first: only proceed if this request is the one that
      // actually transitions the game out of 'active'. If two reveal
      // requests raced (e.g. the client double-fired, or a reveal raced a
      // cashOut), only one of them gets a row back here.
      const resolved = await db.resolveMinesGame(game.id, userId, {
        revealed: game.revealed, status: 'lost', resolvedAt: Date.now()
      });
      if (!resolved) throw new Error('Игра уже завершена');
      await db.logBet({
        id: crypto.randomUUID(),
        userId,
        mode: 'Мины',
        stake: game.betAmount,
        winnings: 0,
        outcome: 'lose',
        detail: `${game.minesCount} мин, подрыв на клетке ${game.revealed.length + 1}`,
        createdAt: Date.now()
      });
      return { ...toPublicGame(resolved, { revealMines: true }), hitMine: true, winnings: 0 };
    }

    const revealed = [...game.revealed, tileIndex];
    const allSafeRevealed = revealed.length === GRID_SIZE - game.minesCount;
    const hitCap = !allSafeRevealed && multiplierFor(game.minesCount, revealed.length) >= MAX_MULTIPLIER;

    if (allSafeRevealed || hitCap) {
      // Either every safe tile is open, or this reveal pushed the multiplier
      // to/past the payout cap — either way, nothing left to gain by
      // continuing, so we auto-cash-out (capped at MAX_MULTIPLIER) instead of
      // leaving the player stuck or letting the payout grow unbounded.
      const multiplier = cappedMultiplierFor(game.minesCount, revealed.length);
      const winnings = round2(game.betAmount * multiplier);
      // Claim the terminal state atomically BEFORE paying out — if this
      // returns nothing, another concurrent request (e.g. a manual cashOut
      // that raced this reveal) already resolved the game, so we must not
      // pay out a second time.
      const resolved = await db.resolveMinesGame(game.id, userId, {
        revealed, status: 'cashed_out', resolvedAt: Date.now()
      });
      if (!resolved) throw new Error('Игра уже завершена');
      await db.updateUserBalance(userId, winnings);
      await db.logBet({
        id: crypto.randomUUID(),
        userId,
        mode: 'Мины',
        stake: game.betAmount,
        winnings,
        outcome: winnings > game.betAmount ? 'win' : winnings === game.betAmount ? 'push' : 'lose',
        detail: hitCap
          ? `${game.minesCount} мин, достигнут потолок x${MAX_MULTIPLIER}, авто-выплата`
          : `${game.minesCount} мин, все ${revealed.length} безопасных клетки открыты (авто)`,
        createdAt: Date.now()
      });
      return { ...toPublicGame(resolved, { revealMines: true }), hitMine: false, winnings, autoCashedOut: true, hitCap };
    }

    const updated = await db.updateMinesGame(game.id, { revealed });
    return { ...toPublicGame(updated), hitMine: false };

  });
}

export async function cashOut(userId) {
  return withLock(userId, async () => {
    const game = await db.getActiveMinesGame(userId);
    if (!game) throw new Error('Нет активной игры');
    if (game.revealed.length === 0) throw new Error('Откройте хотя бы одну клетку перед тем как забрать выигрыш');

    const multiplier = cappedMultiplierFor(game.minesCount, game.revealed.length);
    const winnings = round2(game.betAmount * multiplier);

    // Claim the terminal state atomically BEFORE paying out — this is the
    // fix for the reported cash-out race: two concurrent /cashout calls (or
    // a cashOut racing a losing reveal) used to both read the game as
    // 'active', both compute a payout, and both credit the balance. Now
    // only whichever request's UPDATE actually flips the row gets to pay
    // out; the loser gets `resolved === undefined` and errors out instead.
    const resolved = await db.resolveMinesGame(game.id, userId, {
      revealed: game.revealed, status: 'cashed_out', resolvedAt: Date.now()
    });
    if (!resolved) throw new Error('Игра уже завершена');

    await db.updateUserBalance(userId, winnings);
    await db.logBet({
      id: crypto.randomUUID(),
      userId,
      mode: 'Мины',
      stake: game.betAmount,
      winnings,
      outcome: winnings > game.betAmount ? 'win' : winnings === game.betAmount ? 'push' : 'lose',
      detail: `${game.minesCount} мин, забрано после ${game.revealed.length} клеток`,
      createdAt: Date.now()
    });
    return { ...toPublicGame(resolved, { revealMines: true }), winnings };

  });
}

export async function getState(userId) {
  const game = await db.getActiveMinesGame(userId);
  return game ? toPublicGame(game) : null;
}
