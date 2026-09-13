// ---------------------------------------------------------------------------
// Server-authoritative Baccarat. Now a local, per-player instant game (same
// pattern as Mines/Roulette): a player places their bet(s) on player/banker/
// tie, submits them all at once, and the whole hand — deal, draws, outcome,
// payout — resolves immediately server-side. No shared round, no countdown,
// no other players' bets visible.
//
// Standard Punto Banco rules: Player and Banker each start with two cards;
// a third card is drawn for one or both according to the fixed drawing
// tableau below (no player choice involved, unlike blackjack). Closest to
// 9 wins. Bets: 'player', 'banker', 'tie'.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import { db } from './db.js';

const MAX_BET = 500;

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function cardValue(rank) {
  if (rank === 'A') return 1;
  if (rank === '10' || rank === 'J' || rank === 'Q' || rank === 'K') return 0;
  return parseInt(rank, 10);
}

function secureRandomInt(maxExclusive) {
  const bytes = crypto.randomBytes(4);
  const n = bytes.readUInt32BE(0);
  return n % maxExclusive;
}

// Fresh 8-deck shoe, shuffled, drawn from for exactly one hand. Simpler and
// just as fair as tracking a persistent shoe across hands, since every hand
// is independent and this avoids any state leaking between players/hands.
function freshShoe() {
  const cards = [];
  for (let deck = 0; deck < 8; deck++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        cards.push({ rank, suit, value: cardValue(rank) });
      }
    }
  }
  // Fisher-Yates using crypto randomness — same fairness standard as the
  // roulette wheel's secureRandomIndex.
  for (let i = cards.length - 1; i > 0; i--) {
    const j = secureRandomInt(i + 1);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

// Balances carry 2 decimal places (see db.js) so payouts aren't shaved by
// integer flooring — round to the cent/kopeck instead.
function round2(n) {
  return Math.round(n * 100) / 100;
}

function handTotal(cards) {
  return cards.reduce((sum, c) => sum + c.value, 0) % 10;
}

// The fixed drawing tableau — no discretion, this is what makes Baccarat a
// pure game of chance for the players (they only bet on the outcome).
function dealRound(shoe) {
  let i = 0;
  const draw = () => shoe[i++];

  const player = [draw(), draw()];
  const banker = [draw(), draw()];

  let playerTotal = handTotal(player);
  let bankerTotal = handTotal(banker);

  const isNatural = playerTotal >= 8 || bankerTotal >= 8;

  if (!isNatural) {
    let playerThirdValue = null;

    if (playerTotal <= 5) {
      const card = draw();
      player.push(card);
      playerThirdValue = card.value;
      playerTotal = handTotal(player);
    }

    let bankerDraws;
    if (playerThirdValue === null) {
      // Player stood (had 6 or 7) — banker plays by the same simple rule.
      bankerDraws = bankerTotal <= 5;
    } else {
      // Standard banker tableau, keyed off banker's total and the value of
      // the player's third card.
      if (bankerTotal <= 2) bankerDraws = true;
      else if (bankerTotal === 3) bankerDraws = playerThirdValue !== 8;
      else if (bankerTotal === 4) bankerDraws = playerThirdValue >= 2 && playerThirdValue <= 7;
      else if (bankerTotal === 5) bankerDraws = playerThirdValue >= 4 && playerThirdValue <= 7;
      else if (bankerTotal === 6) bankerDraws = playerThirdValue === 6 || playerThirdValue === 7;
      else bankerDraws = false; // banker total 7 always stands
    }

    if (bankerDraws) {
      banker.push(draw());
      bankerTotal = handTotal(banker);
    }
  }

  let outcome;
  if (playerTotal > bankerTotal) outcome = 'player';
  else if (bankerTotal > playerTotal) outcome = 'banker';
  else outcome = 'tie';

  return { player, banker, playerTotal, bankerTotal, outcome };
}

/**
 * Resolve one player's hand immediately: validates + debits the bet(s),
 * deals a full hand from a fresh shoe, resolves the outcome, credits any
 * winnings, logs the hand for history, and returns everything the client
 * needs to deal/flip cards and show the result. No shared state between
 * players/requests.
 */
export async function playHand(userId, bets) {
  if (!Array.isArray(bets) || bets.length === 0) {
    throw new Error('Сделайте хотя бы одну ставку');
  }

  const betMap = new Map();
  let total = 0;
  for (const b of bets) {
    if (!b || !['player', 'banker', 'tie'].includes(b.key) || !Number.isInteger(b.amount) || b.amount < 1) {
      throw new Error('Некорректная ставка');
    }
    const already = betMap.get(b.key) || 0;
    const merged = already + b.amount;
    if (merged > MAX_BET) throw new Error(`Максимум на поле: ${MAX_BET}`);
    betMap.set(b.key, merged);
    total += b.amount;
  }
  if (betMap.size > 1) throw new Error('Можно поставить только на один исход за раз');

  // Atomic, race-safe debit — throws if the balance is insufficient.
  await db.updateUserBalance(userId, -total);

  const shoe = freshShoe();
  const deal = dealRound(shoe);
  const outcome = deal.outcome;

  let winnings = 0;
  for (const [key, amount] of betMap) {
    if (outcome === 'tie') {
      if (key === 'tie') winnings += amount * 9;       // 8:1 profit + stake
      else winnings += amount;                          // push — stake back, no profit
    } else if (key === outcome) {
      winnings += key === 'banker'
        ? round2(amount + amount * 0.95)                 // 0.95:1 (5% commission)
        : amount * 2;                                     // player wins 1:1
    }
    // else: loses, already debited at bet time
  }
  winnings = round2(winnings);
  if (winnings > 0) await db.updateUserBalance(userId, winnings);

  await db.logBaccaratRound({
    id: crypto.randomUUID(),
    playerCards: deal.player,
    bankerCards: deal.banker,
    playerTotal: deal.playerTotal,
    bankerTotal: deal.bankerTotal,
    outcome,
    resolvedAt: Date.now()
  });

  await db.logBet({
    id: crypto.randomUUID(),
    userId,
    mode: 'Баккара',
    stake: total,
    winnings,
    outcome: winnings > total ? 'win' : winnings === total ? 'push' : 'lose',
    detail: `${deal.playerTotal}:${deal.bankerTotal}, победил ${outcome}`,
    createdAt: Date.now()
  });

  return {
    playerCards: deal.player,
    bankerCards: deal.banker,
    playerTotal: deal.playerTotal,
    bankerTotal: deal.bankerTotal,
    outcome,
    bets: Array.from(betMap.entries()).map(([key, amount]) => ({ key, amount })),
    totalStake: total,
    winnings
  };
}
