import express from 'express';
import { requireAuth } from './auth.js';
import * as mines from './mines.js';

const router = express.Router();

router.get('/state', requireAuth, async (req, res, next) => {
  try {
    res.json({ game: await mines.getState(req.user.id) });
  } catch (err) { next(err); }
});

router.post('/start', requireAuth, async (req, res) => {
  const betAmount = parseInt(req.body.betAmount, 10);
  const minesCount = parseInt(req.body.minesCount, 10);
  try {
    const game = await mines.startGame(req.user.id, betAmount, minesCount);
    res.json({ game });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/reveal', requireAuth, async (req, res) => {
  const tileIndex = parseInt(req.body.tileIndex, 10);
  try {
    const result = await mines.revealTile(req.user.id, tileIndex);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/cashout', requireAuth, async (req, res) => {
  try {
    const result = await mines.cashOut(req.user.id);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
