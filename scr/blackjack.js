import express from 'express';
import { requireAuth } from './auth.js';
import * as blackjack from './blackjack.js';

export default function blackjackRoutes() {
  const router = express.Router();

  router.get('/state', requireAuth, async (req, res, next) => {
    try {
      const game = await blackjack.getState(req.user.id);
      res.json({ game });
    } catch (err) { next(err); }
  });

  router.post('/deal', requireAuth, async (req, res) => {
    const betAmount = parseInt(req.body.betAmount, 10);
    try {
      const game = await blackjack.deal(req.user.id, betAmount);
      res.json({ game });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/hit', requireAuth, async (req, res) => {
    try {
      const game = await blackjack.hit(req.user.id);
      res.json(game);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/stand', requireAuth, async (req, res) => {
    try {
      const game = await blackjack.stand(req.user.id);
      res.json(game);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/double', requireAuth, async (req, res) => {
    try {
      const game = await blackjack.doubleDown(req.user.id);
      res.json(game);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/split', requireAuth, async (req, res) => {
    try {
      const game = await blackjack.split(req.user.id);
      res.json(game);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}
