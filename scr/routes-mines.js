// ---------------------------------------------------------------------------
// Admin "Статистика" reports — three downloads driven by the same
// underlying bet_log data (see db.js):
//
//  - Full-stats-1D: a plain-text dump of every bet and deposit from the
//    last 24 hours, for support to look up a specific player's recent
//    activity. Each entry ages out of the report exactly 24h after it was
//    written (a rolling window enforced by the query itself, not a file
//    that gets wiped once a day) — support has a full day to react to any
//    single bet.
//  - Stats-7D: an Excel pivot (players × modes) covering the most recently
//    completed week, cached and served unchanged until the next Sunday.
//  - Stats-All: the same pivot shape, but always freshly computed over the
//    entire history (no caching, nothing ever resets).
//
// Both Excel reports list every registered user (not just ones who bet in
// that window) so the roster/row count stays stable between refreshes —
// only the figures change.
// ---------------------------------------------------------------------------

import ExcelJS from 'exceljs';
import { db } from './db.js';

export const MODES = ['Рулетка', 'Баккара', 'Мины', 'Блэкджек'];

function fmt2(n) {
  return Number(n ?? 0).toFixed(2);
}

function fmtDateTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// Full-stats-1D — plain text
// ---------------------------------------------------------------------------
export function buildFullDayReport(bets, deposits) {
  const lines = [];
  lines.push('=== SPM КАЗИНО — статистика за последние 24 часа ===');
  lines.push(`Сформировано: ${fmtDateTime(Date.now())}`);
  lines.push('Каждая запись хранится в этом отчёте ровно 24 часа с момента её создания.');
  lines.push('');

  lines.push(`--- Пополнения (${deposits.length}) ---`);
  if (deposits.length === 0) lines.push('(нет записей за 24 часа)');
  for (const d of deposits) {
    lines.push(
      `[${fmtDateTime(d.createdAt)}] ${d.nick} (код ${d.code}, id ${d.userId}) | +${fmt2(d.amount)} | статус: ${d.status}`
    );
  }
  lines.push('');

  lines.push(`--- Ставки (${bets.length}) ---`);
  if (bets.length === 0) lines.push('(нет записей за 24 часа)');
  for (const b of bets) {
    const delta = b.winnings - b.stake;
    const sign = delta >= 0 ? '+' : '';
    lines.push(
      `[${fmtDateTime(b.createdAt)}] ${b.nick} (код ${b.code}, id ${b.userId}) | ${b.mode} | ` +
      `ставка ${fmt2(b.stake)} | выплата ${fmt2(b.winnings)} | баланс ${sign}${fmt2(delta)} | ` +
      `${b.outcome}${b.detail ? ' | ' + b.detail : ''}`
    );
  }
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Stats-7D / Stats-All — Excel pivot
// ---------------------------------------------------------------------------

// aggregateRows: [{ userId, nick, mode, stake, winnings, bets }, ...] from
// db.aggregateBetsByUserMode(). allUsers: [{ id, mcNick }, ...] — the full
// roster, so every registered player gets a row even with zero bets.
export async function buildStatsWorkbookBuffer(aggregateRows, allUsers, { title = 'Статистика' } = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Mells.Bet';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet(title);

  // key `${userId}|${mode}` -> { stake, winnings }
  const cell = new Map();
  for (const r of aggregateRows) {
    cell.set(`${r.userId}|${r.mode}`, { stake: r.stake, winnings: r.winnings });
  }

  const header = ['Игрок', ...MODES, 'Итог игрока', 'RTP игрока (%)'];
  sheet.addRow(header);
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2A1854' } }; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; });
  sheet.views = [{ state: 'frozen', ySplit: 1, xSplit: 1 }];

  // Running totals per mode, across every user, for the summary rows below.
  const modeTotals = Object.fromEntries(MODES.map(m => [m, { stake: 0, winnings: 0 }]));

  const usersSorted = allUsers.slice().sort((a, b) => a.mcNick.localeCompare(b.mcNick, 'ru'));
  for (const u of usersSorted) {
    let playerStake = 0;
    let playerWinnings = 0;
    const row = [u.mcNick];
    for (const mode of MODES) {
      const v = cell.get(`${u.id}|${mode}`) || { stake: 0, winnings: 0 };
      const net = v.winnings - v.stake;
      row.push(Number(net.toFixed(2)));
      playerStake += v.stake;
      playerWinnings += v.winnings;
      modeTotals[mode].stake += v.stake;
      modeTotals[mode].winnings += v.winnings;
    }
    const playerNet = playerWinnings - playerStake;
    const playerRtp = playerStake > 0 ? (playerWinnings / playerStake) * 100 : null;
    row.push(Number(playerNet.toFixed(2)));
    row.push(playerRtp === null ? '—' : Number(playerRtp.toFixed(2)));
    sheet.addRow(row);
  }

  sheet.addRow([]); // spacer

  const rtpRow = ['RTP режима (%)'];
  const revenueRow = ['Доход режима'];
  for (const mode of MODES) {
    const t = modeTotals[mode];
    const rtp = t.stake > 0 ? (t.winnings / t.stake) * 100 : null;
    rtpRow.push(rtp === null ? '—' : Number(rtp.toFixed(2)));
    revenueRow.push(Number((t.stake - t.winnings).toFixed(2)));
  }
  const rtpRowIdx = sheet.rowCount + 1;
  sheet.addRow(rtpRow);
  const revenueRowIdx = sheet.rowCount + 1;
  sheet.addRow(revenueRow);
  [rtpRowIdx, revenueRowIdx].forEach(i => { sheet.getRow(i).font = { bold: true }; });

  sheet.getColumn(1).width = 22;
  for (let i = 2; i <= header.length; i++) sheet.getColumn(i).width = 16;

  return workbook.xlsx.writeBuffer();
}

// Resolves the most recently completed week's Sun 00:00 -> Sun 00:00 range
// (UTC) and returns { weekStart, weekEnd } timestamps in ms.
export function currentWeekBounds(now = Date.now()) {
  const d = new Date(now);
  const dayOfWeek = d.getUTCDay(); // 0 = Sunday
  const mostRecentSunday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dayOfWeek, 0, 0, 0, 0);
  return { weekStart: mostRecentSunday - 7 * 24 * 60 * 60 * 1000, weekEnd: mostRecentSunday };
}

// Serves the cached snapshot for the current week if it's already been
// computed; otherwise (first request on/after a new Sunday) recomputes it
// from bet_log and caches it, so every request for the rest of the week
// gets the exact same numbers.
export async function getWeeklyAggregateRows() {
  const { weekStart, weekEnd } = currentWeekBounds();
  const existing = await db.getWeeklySnapshot();
  if (existing && existing.weekEnd === weekEnd) {
    return existing.data;
  }
  const rows = await db.aggregateBetsByUserMode({ sinceTs: weekStart, untilTs: weekEnd });
  await db.saveWeeklySnapshot({ weekStart, weekEnd, data: rows, computedAt: Date.now() });
  return rows;
}
