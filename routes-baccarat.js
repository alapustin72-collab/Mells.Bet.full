// ---------------------------------------------------------------------------
// Server-authoritative Blackjack. Same private, per-player, DB-persisted
// game pattern as Mines: a player deals a hand, then makes decisions
// (Hit / Stand / Double Down / Split) across multiple requests, so —
// unlike Roulette/Baccarat — state has to live between requests. It's
// persisted in the DB (not just in-memory) so a server restart mid-hand
// doesn't silently eat the player's bet.
//
// Rules: standard Vegas single-hand Blackjack, dealt from a 6-deck shoe.
// Blackjack (Ace + 10-value on the first two cards, BEFORE any split)
// pays 3:2. Dealer stands on all 17s (including soft 17). Split: allowed
// once (max 2 resulting hands, no re-splitting) when the first two cards
// share the same rank; each new hand gets one fresh card immediately and
// is played to completion before moving to the next. Split Aces get
// exactly one card each and can't be hit or doubled — standard rule.
// Double Down: doubles that hand's bet, draws exactly one more card, then
// auto-stands that hand. No insurance in this version.
// ---------------------------------------------------------------------------

import crypto from 'node:crypto';
import { db } from './db.js';
import { withLock } from './lock.js';

const MAX_BET = 500;
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const DECK_COUNT = 6;
const MAX_HANDS = 2; // one split allowed — no re-splitting

function secureRandomInt(maxExclusive) {
  const bytes = crypto.randomBytes(4);
  return bytes.readUInt32BE(0) % maxExclusive;
}

function freshShoe() {
  const cards = [];
  for (let deck = 0; deck < DECK_COUNT; deck++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        cards.push({ rank, suit });
      }
    }
  }
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

// Blackjack card values: aces flex between 11 and 1 — count every ace as
// 11 first, then demote aces to 1 one at a time until the total is 21 or
// under (or we run out of aces). "Soft" means at least one ace is still
// counted as 11.
function handValue(cards) {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    if (c.rank === 'A') { total += 11; aces++; }
    else if (c.rank === '10' || c.rank === 'J' || c.rank === 'Q' || c.rank === 'K') total += 10;
    else total += parseInt(c.rank, 10);
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return { total, soft: aces > 0, isBust: total > 21 };
}

function isNaturalBlackjack(cards) {
  return cards.length === 2 && handValue(cards).total === 21;
}

// Dealer draws until 17+, standing on every 17 (soft or hard) — the most
// common "stand on all 17s" house rule.
function playDealer(shoe, dealerCards) {
  const cards = dealerCards.slice();
  while (handValue(cards).total < 17) {
    cards.push(shoe.pop());
  }
  return cards;
}

function resolveVsDealer(handCards, dealerCards) {
  const player = handValue(handCards);
  if (player.isBust) return 'dealer_win';
  const dealer = handValue(dealerCards);
  if (dealer.isBust) return 'player_win';
  if (player.total > dealer.total) return 'player_win';
  if (player.total < dealer.total) return 'dealer_win';
  return 'push';
}

function newHand(cards, bet, isSplitAces = false) {
  return { cards, bet, doubled: false, isSplitAces, done: false, outcome: null, winnings: 0 };
}

function handActions(game) {
  if (game.status !== 'active') return { canHit: false, canStand: false, canDouble: false, canSplit: false };
  const hand = game.playerHands[game.activeHand];
  const canAct = hand && !hand.done && !hand.isSplitAces;
  return {
    canHit: canAct,
    canStand: canAct,
    canDouble: canAct && hand.cards.length === 2,
    canSplit: canAct
      && game.playerHands.length < MAX_HANDS
      && hand.cards.length === 2
      && hand.cards[0].rank === hand.cards[1].rank
  };
}

function toPublicGame(game, { revealDealer = false } = {}) {
  const showDealer = revealDealer || game.status !== 'active';
  const dealerCards = showDealer ? game.dealerCards : [game.dealerCards[0]];
  return {
    id: game.id,
    status: game.status,
    activeHand: game.activeHand,
    playerHands: game.playerHands.map(h => {
      const v = handValue(h.cards);
      return {
        cards: h.cards,
        bet: h.bet,
        total: v.total,
        soft: v.soft,
        doubled: h.doubled,
        isSplitAces: h.isSplitAces,
        done: h.done,
        outcome: h.outcome,
        winnings: h.winnings
      };
    }),
    dealerCards,
    dealerTotal: showDealer ? handValue(dealerCards).total : null,
    actions: handActions(game)
  };
}

// After a hand becomes done (stood, busted, doubled-out, or split-aces
// auto-done), move to the next not-done hand if any; if every hand is
// done, play the dealer once and settle every hand against that single
// dealer result, then credit the combined winnings in one balance update.
async function advance(game) {
  const nextIndex = game.playerHands.findIndex(h => !h.done);
  if (nextIndex !== -1) {
    return db.updateBlackjackGame(game.id, { activeHand: nextIndex });
  }

  const shoe = game.shoe.slice();
  const dealerCards = playDealer(shoe, game.dealerCards);

  let totalWinnings = 0;
  const playerHands = game.playerHands.map(h => {
    if (h.outcome) return h; // already settled (shouldn't normally happen pre-dealer, but safe)
    const outcome = resolveVsDealer(h.cards, dealerCards);
    let winnings = 0;
    if (outcome === 'player_win') winnings = round2(h.bet * 2);
    else if (outcome === 'push') winnings = h.bet;
    totalWinnings += winnings;
    return { ...h, outcome, winnings };
  });

  if (totalWinnings > 0) await db.updateUserBalance(game.userId, totalWinnings);

  for (const h of playerHands) {
    await db.logBet({
      id: crypto.randomUUID(),
      userId: game.userId,
      mode: 'Блэкджек',
      stake: h.bet,
      winnings: h.winnings,
      outcome: h.winnings > h.bet ? 'win' : h.winnings === h.bet ? 'push' : 'lose',
      detail: `Рука: ${h.outcome}${h.doubled ? ', удвоено' : ''}`,
      createdAt: Date.now()
    });
  }

  return db.updateBlackjackGame(game.id, {
    shoe, dealerCards, playerHands,
    status: 'finished',
    resolvedAt: Date.now()
  });
}

export async function deal(userId, betAmount) {
  return withLock(userId, async () => {
    if (!Number.isInteger(betAmount) || betAmount < 1 || betAmount > MAX_BET) {
      throw new Error(`Ставка от 1 до ${MAX_BET}`);
    }

    const existing = await db.getActiveBlackjackGame(userId);
    if (existing) throw new Error('У вас уже есть активная игра');

    await db.updateUserBalance(userId, -betAmount); // throws if insufficient

    const shoe = freshShoe();
    const playerCards = [shoe.pop(), shoe.pop()];
    const dealerCards = [shoe.pop(), shoe.pop()];

    let game = await db.createBlackjackGame({
      id: crypto.randomUUID(),
      userId,
      shoe,
      playerHands: [newHand(playerCards, betAmount)],
      dealerCards,
      createdAt: Date.now()
    });

    const playerBJ = isNaturalBlackjack(playerCards);
    const dealerBJ = isNaturalBlackjack(dealerCards);

    if (playerBJ || dealerBJ) {
      let outcome, winnings;
      if (playerBJ && dealerBJ) { outcome = 'push'; winnings = betAmount; }
      else if (playerBJ) { outcome = 'blackjack'; winnings = round2(betAmount + betAmount * 1.5); }
      else { outcome = 'dealer_win'; winnings = 0; }

      if (winnings > 0) await db.updateUserBalance(userId, winnings);
      game = await db.updateBlackjackGame(game.id, {
        playerHands: [{ ...game.playerHands[0], done: true, outcome, winnings }],
        status: 'finished',
        resolvedAt: Date.now()
      });
      await db.logBet({
        id: crypto.randomUUID(),
        userId,
        mode: 'Блэкджек',
        stake: betAmount,
        winnings,
        outcome: winnings > betAmount ? 'win' : winnings === betAmount ? 'push' : 'lose',
        detail: `Рука: ${outcome} (натуральный)`,
        createdAt: Date.now()
      });
      return toPublicGame(game, { revealDealer: true });
    }

    return toPublicGame(game);

  });
}

export async function hit(userId) {
  return withLock(userId, async () => {
    const game = await db.getActiveBlackjackGame(userId);
    if (!game) throw new Error('Нет активной игры');
    const hand = game.playerHands[game.activeHand];
    if (!hand || hand.done || hand.isSplitAces) throw new Error('Нельзя взять карту');

    const shoe = game.shoe.slice();
    const cards = [...hand.cards, shoe.pop()];
    const v = handValue(cards);
    const updatedHand = { ...hand, cards };
    if (v.isBust) { updatedHand.done = true; updatedHand.outcome = 'dealer_win'; updatedHand.winnings = 0; }
    else if (v.total === 21) { updatedHand.done = true; } // auto-stand on 21

    const playerHands = game.playerHands.slice();
    playerHands[game.activeHand] = updatedHand;
    let updated = await db.updateBlackjackGame(game.id, { shoe, playerHands });

    if (updatedHand.done) updated = await advance(updated);
    return toPublicGame(updated, { revealDealer: updated.status !== 'active' });

  });
}

export async function stand(userId) {
  return withLock(userId, async () => {
    const game = await db.getActiveBlackjackGame(userId);
    if (!game) throw new Error('Нет активной игры');
    const hand = game.playerHands[game.activeHand];
    if (!hand || hand.done) throw new Error('Нельзя остановиться');

    const playerHands = game.playerHands.slice();
    playerHands[game.activeHand] = { ...hand, done: true };
    let updated = await db.updateBlackjackGame(game.id, { playerHands });
    updated = await advance(updated);
    return toPublicGame(updated, { revealDealer: updated.status !== 'active' });

  });
}

export async function doubleDown(userId) {
  return withLock(userId, async () => {
    const game = await db.getActiveBlackjackGame(userId);
    if (!game) throw new Error('Нет активной игры');
    const hand = game.playerHands[game.activeHand];
    if (!hand || hand.done || hand.isSplitAces || hand.cards.length !== 2) {
      throw new Error('Удвоить можно только первые две карты');
    }

    // Debit the matching second half of the bet — throws if insufficient.
    await db.updateUserBalance(userId, -hand.bet);

    const shoe = game.shoe.slice();
    const cards = [...hand.cards, shoe.pop()];
    const v = handValue(cards);
    const updatedHand = { ...hand, cards, bet: round2(hand.bet * 2), doubled: true, done: true };
    if (v.isBust) { updatedHand.outcome = 'dealer_win'; updatedHand.winnings = 0; }

    const playerHands = game.playerHands.slice();
    playerHands[game.activeHand] = updatedHand;
    let updated = await db.updateBlackjackGame(game.id, { shoe, playerHands });
    updated = await advance(updated);
    return toPublicGame(updated, { revealDealer: updated.status !== 'active' });

  });
}

export async function split(userId) {
  return withLock(userId, async () => {
    const game = await db.getActiveBlackjackGame(userId);
    if (!game) throw new Error('Нет активной игры');
    const hand = game.playerHands[game.activeHand];
    const canSplit = hand && !hand.done
      && game.playerHands.length < MAX_HANDS
      && hand.cards.length === 2
      && hand.cards[0].rank === hand.cards[1].rank;
    if (!canSplit) throw new Error('Сплит недоступен');

    // Second hand needs its own matching bet — throws if insufficient.
    await db.updateUserBalance(userId, -hand.bet);

    const shoe = game.shoe.slice();
    const isAces = hand.cards[0].rank === 'A';
    const handA = newHand([hand.cards[0], shoe.pop()], hand.bet, isAces);
    const handB = newHand([hand.cards[1], shoe.pop()], hand.bet, isAces);
    if (isAces) { handA.done = true; handB.done = true; }

    const playerHands = game.playerHands.slice();
    playerHands.splice(game.activeHand, 1, handA, handB);
    let updated = await db.updateBlackjackGame(game.id, { shoe, playerHands, activeHand: game.activeHand });

    if (isAces) updated = await advance(updated);
    return toPublicGame(updated, { revealDealer: updated.status !== 'active' });

  });
}

export async function getState(userId) {
  const game = await db.getActiveBlackjackGame(userId);
  return game ? toPublicGame(game) : null;
}
