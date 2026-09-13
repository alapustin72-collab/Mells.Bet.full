import express from 'express';
import { requireAuth } from './auth.js';
import { db } from './db.js';
import * as baccarat from './baccarat.js';

export default function baccaratRoutes() {
  const router = express.Router();

  // One request = one full hand: the client sends its bet(s) (built up
  // locally, nothing debited yet) and gets back the whole dealt hand plus
  // outcome and winnings in a single round trip. No shared round state.
  router.post('/play', requireAuth, async (req, res) => {
    const bets = req.body.bets;
    try {
      const result = await baccarat.playHand(req.user.id, bets);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/history', async (req, res, next) => {
    try {
      const rounds = await db.recentBaccaratRounds(20);
      res.json(rounds.map(r => ({ outcome: r.outcome, playerTotal: r.playerTotal, bankerTotal: r.bankerTotal })));
    } catch (err) { next(err); }
  });

  return router;
}
