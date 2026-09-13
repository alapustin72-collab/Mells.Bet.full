// ---------------------------------------------------------------------------
// Server-authoritative Roulette. Now a local, per-player instant game (same
// pattern as Mines): a player builds a bet slip client-side, submits it all
// at once, and gets an immediate result — no shared round, no countdown, no
// waiting on/for other players. The client never decides the spin result or
// credits its own balance — this module is the only place that resolves a
// spin and touches balances.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import { db } from './db.js';

export const WHEEL_ORDER = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];
const RED_SET = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const MAX_BET = 250;
const MAX_OUTCOMES_PER_SPIN = 3;

const ODDS = { straight: 35, dozen: 2, column: 2, outside: 1 };

function colorOf(n) { return n === 0 ? 'green' : RED_SET.has(n) ? 'red' : 'black'; }

function oddsFor(key) {
  if (key.startsWith('num-')) return ODDS.straight;
  if (key.startsWith('dozen')) return ODDS.dozen;
  if (key.startsWith('col')) return ODDS.column;
  return ODDS.outside;
}

function checkWin(key, n) {
  if (key.startsWith('num-')) return parseInt(key.slice(4), 10) === n;
  switch (key) {
    case 'red': return n !== 0 && RED_SET.has(n);
    case 'black': return n !== 0 && !RED_SET.has(n);
    case 'even': return n !== 0 && n % 2 === 0;
    case 'odd': return n !== 0 && n % 2 === 1;
    case 'low': return n >= 1 && n <= 18;
    case 'high': return n >= 19 && n <= 36;
    case 'dozen1': return n >= 1 && n <= 12;
    case 'dozen2': return n >= 13 && n <= 24;
    case 'dozen3': return n >= 25 && n <= 36;
    case 'col1': return n !== 0 && n % 3 === 1;
    case 'col2': return n !== 0 && n % 3 === 2;
    case 'col3': return n !== 0 && n % 3 === 0;
    default: return false;
  }
}

// Cryptographically secure RNG — no client, and no other player, can predict
// or influence the outcome.
function secureRandomIndex(max) {
  return crypto.randomInt(0, max);
}

/**
 * Resolve one player's spin immediately: validates + debits the whole bet
 * slip, draws the winning number, credits any winnings, logs the spin for
 * history, and returns everything the client needs to animate the wheel and
 * show the result. No shared state between players/requests.
 */
export async function spin(userId, bets) {
  if (!Array.isArray(bets) || bets.length === 0) {
    throw new Error('Сделайте хотя бы одну ставку');
  }
  if (bets.length > MAX_OUTCOMES_PER_SPIN) {
    throw new Error(`Максимум ${MAX_OUTCOMES_PER_SPIN} исхода за раунд`);
  }

  const betMap = new Map();
  let total = 0;
  for (const b of bets) {
    if (!b || typeof b.key !== 'string' || !Number.isInteger(b.amount) || b.amount < 1) {
      throw new Error('Некорректная ставка');
    }
    const already = betMap.get(b.key) || 0;
    const merged = already + b.amount;
    if (merged > MAX_BET) throw new Error(`Максимум на поле: ${MAX_BET}`);
    betMap.set(b.key, merged);
    total += b.amount;
  }

  // Atomic, race-safe debit — throws if the balance is insufficient.
  await db.updateUserBalance(userId, -total);

  // Cryptographically secure, unforceable — nobody (including an admin
  // account) has a way to influence or predict this draw.
  const winNumber = WHEEL_ORDER[secureRandomIndex(WHEEL_ORDER.length)];

  let winnings = 0;
  for (const [key, amount] of betMap) {
    if (checkWin(key, winNumber)) winnings += amount * (oddsFor(key) + 1);
  }
  if (winnings > 0) await db.updateUserBalance(userId, winnings);

  const resultBets = Array.from(betMap.entries()).map(([key, amount]) => ({ key, amount }));

  await db.logRound({
    id: crypto.randomUUID(),
    number: winNumber,
    color: colorOf(winNumber),
    bets: resultBets,
    resolvedAt: Date.now()
  });

  await db.logBet({
    id: crypto.randomUUID(),
    userId,
    mode: 'Рулетка',
    stake: total,
    winnings,
    outcome: winnings > total ? 'win' : winnings === total ? 'push' : 'lose',
    detail: `Число ${winNumber} (${colorOf(winNumber)})`,
    createdAt: Date.now()
  });

  return {
    number: winNumber,
    color: colorOf(winNumber),
    bets: resultBets,
    totalStake: total,
    winnings
  };
}
