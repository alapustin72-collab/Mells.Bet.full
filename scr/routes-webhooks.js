import express from 'express';
import { requireAuth } from './auth.js';
import { db } from './db.js';
import * as game from './game.js';

export default function gameRoutes() {
  const router = express.Router();

  // One request = one full spin: the client sends its whole bet slip
  // (built up locally, nothing debited yet) and gets back the number,
  // color, and winnings in a single round trip. No shared round state.
  router.post('/spin', requireAuth, async (req, res) => {
    const bets = req.body.bets;
    try {
      const result = await game.spin(req.user.id, bets);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/history', async (req, res, next) => {
    try {
      const rounds = await db.recentRounds(20);
      res.json(rounds.map(r => ({ number: r.number, color: r.color })));
    } catch (err) { next(err); }
  });

  return router;
}
