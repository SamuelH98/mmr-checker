const express = require('express');
const cors    = require('cors');
const path    = require('path');
require('dotenv').config();

const app          = express();
const PORT         = process.env.PORT || 3001;
const RIOT_API_KEY = process.env.RIOT_API_KEY;

// ─── Season config ─────────────────────────────────────────────────────────────
const CURRENT_SEASON = 'S2026_1';

// ─── SQLite setup ──────────────────────────────────────────────────────────────
let db   = null;
let stmt = null;
try {
  const Database = require('better-sqlite3');
  const DB_PATH  = path.join(__dirname, 'mmr_cache.db');
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS matches (
      match_id   TEXT PRIMARY KEY,
      season     TEXT NOT NULL,
      data       TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS player_ranks (
      puuid      TEXT PRIMARY KEY,
      season     TEXT NOT NULL,
      mmr        INTEGER,
      fetched_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS leaderboard (
      key           TEXT PRIMARY KEY,
      season        TEXT NOT NULL,
      display_name  TEXT NOT NULL,
      tag           TEXT NOT NULL,
      region        TEXT NOT NULL,
      puuid         TEXT NOT NULL DEFAULT '',
      ranked_mmr    INTEGER,
      ranked_tier   TEXT,
      normal_mmr    INTEGER,
      normal_wr     INTEGER,
      normal_games  INTEGER NOT NULL DEFAULT 0,
      checked_at    INTEGER NOT NULL
    );
  `);

  // Wipe old-season cache rows (leaderboard entries survive — they're display data)
  const m = db.prepare('DELETE FROM matches      WHERE season != ?').run(CURRENT_SEASON);
  const r = db.prepare('DELETE FROM player_ranks WHERE season != ?').run(CURRENT_SEASON);
  if (m.changes || r.changes)
    console.log(`[DB] Season wipe: removed ${m.changes} matches, ${r.changes} rank rows`);

  stmt = {
    // ── match cache ──
    getMatch: db.prepare('SELECT data FROM matches WHERE match_id = ? AND season = ?'),
    setMatches: db.transaction((rows) => {
      const ins = db.prepare('INSERT OR REPLACE INTO matches (match_id, season, data, fetched_at) VALUES (?, ?, ?, ?)');
      for (const { id, data } of rows) ins.run(id, CURRENT_SEASON, JSON.stringify(data), Date.now());
    }),

    // ── rank cache ──
    getRanks: (puuids) => {
      if (!puuids.length) return [];
      const q = puuids.map(() => '?').join(',');
      return db.prepare(`SELECT puuid, mmr FROM player_ranks WHERE puuid IN (${q}) AND season = ?`)
               .all(...puuids, CURRENT_SEASON);
    },
    setRanks: db.transaction((rows) => {
      const ins = db.prepare('INSERT OR REPLACE INTO player_ranks (puuid, season, mmr, fetched_at) VALUES (?, ?, ?, ?)');
      for (const { puuid, mmr } of rows) ins.run(puuid, CURRENT_SEASON, mmr, Date.now());
    }),

    // ── leaderboard ──
    lbGetAll: db.prepare(`
      SELECT key, display_name, tag, region, puuid,
             ranked_mmr, ranked_tier, normal_mmr, normal_wr, normal_games, checked_at
      FROM leaderboard
      ORDER BY normal_mmr DESC NULLS LAST
    `),
    lbUpsert: db.prepare(`
      INSERT INTO leaderboard
        (key, season, display_name, tag, region, puuid,
         ranked_mmr, ranked_tier, normal_mmr, normal_wr, normal_games, checked_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET
        season       = excluded.season,
        display_name = excluded.display_name,
        tag          = excluded.tag,
        region       = excluded.region,
        puuid        = excluded.puuid,
        ranked_mmr   = excluded.ranked_mmr,
        ranked_tier  = excluded.ranked_tier,
        normal_mmr   = excluded.normal_mmr,
        normal_wr    = excluded.normal_wr,
        normal_games = excluded.normal_games,
        checked_at   = excluded.checked_at
    `),
    lbDelete: db.prepare('DELETE FROM leaderboard WHERE key = ?'),

    stats: db.prepare('SELECT (SELECT COUNT(*) FROM matches WHERE season=?) as matches, (SELECT COUNT(*) FROM player_ranks WHERE season=?) as ranks'),
  };

  console.log(`[DB] SQLite ready — season ${CURRENT_SEASON}`);
} catch (e) {
  console.warn('[DB] better-sqlite3 unavailable — caching disabled.\n     Error:', e.message);
}

// ─── SSE: live leaderboard push ────────────────────────────────────────────────
// Each connected browser gets an SSE stream. Whenever the leaderboard changes
// (upsert or delete), we push the full updated list to all clients.
const sseClients = new Set();

function sseBroadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

function lbRows() {
  if (!stmt) return [];
  return stmt.lbGetAll.all().map(r => ({
    key:         r.key,
    displayName: r.display_name,
    tag:         r.tag,
    region:      r.region,
    puuid:       r.puuid,
    rankedMMR:   r.ranked_mmr,
    rankedTier:  r.ranked_tier,
    normalMMR:   r.normal_mmr,
    normalWR:    r.normal_wr,
    normalGames: r.normal_games,
    checkedAt:   r.checked_at,
  }));
}

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

// ─── SSE endpoint ──────────────────────────────────────────────────────────────
app.get('/leaderboard/stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if present
  res.flushHeaders();

  // Send current state immediately on connect
  res.write(`event: init\ndata: ${JSON.stringify(lbRows())}\n\n`);

  sseClients.add(res);
  console.log(`[SSE] client connected (${sseClients.size} total)`);

  // Heartbeat every 25 s to keep the connection alive through proxies
  const hb = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { clearInterval(hb); }
  }, 25000);

  req.on('close', () => {
    clearInterval(hb);
    sseClients.delete(res);
    console.log(`[SSE] client disconnected (${sseClients.size} total)`);
  });
});

// ─── Leaderboard REST ──────────────────────────────────────────────────────────
// GET  /leaderboard       — full list (for initial load without SSE)
app.get('/leaderboard', (req, res) => {
  res.json(lbRows());
});

// POST /leaderboard       — upsert one entry (called after a successful lookup)
// body: { key, displayName, tag, region, puuid, rankedMMR, rankedTier,
//         normalMMR, normalWR, normalGames }
app.post('/leaderboard', (req, res) => {
  if (!stmt) return res.json({ ok: false });
  const { key, displayName, tag, region, puuid = '',
          rankedMMR = null, rankedTier = null,
          normalMMR = null, normalWR = null, normalGames = 0 } = req.body;
  if (!key || !displayName || !tag || !region)
    return res.status(400).json({ error: 'missing required fields' });

  stmt.lbUpsert.run(
    key, CURRENT_SEASON, displayName, tag, region, puuid,
    rankedMMR, rankedTier, normalMMR, normalWR, normalGames, Date.now()
  );

  sseBroadcast('update', lbRows());
  res.json({ ok: true });
});

// DELETE /leaderboard/:key — remove one entry
app.delete('/leaderboard/:key', (req, res) => {
  if (!stmt) return res.json({ ok: false });
  stmt.lbDelete.run(decodeURIComponent(req.params.key));
  sseBroadcast('update', lbRows());
  res.json({ ok: true });
});

// ─── Riot proxy ────────────────────────────────────────────────────────────────
app.get('/riot', async (req, res) => {
  const riotUrl = req.query.url;
  if (!riotUrl || !riotUrl.startsWith('https://'))
    return res.status(400).json({ error: 'Missing or invalid ?url= param' });
  try {
    const response = await fetch(riotUrl, {
      headers: { 'X-Riot-Token': RIOT_API_KEY, 'Accept': 'application/json' },
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    console.error('Proxy error:', err);
    res.status(500).json({ error: 'Proxy request failed', details: err.message });
  }
});

// ─── DB: match cache ───────────────────────────────────────────────────────────
app.get('/db/match/:id', (req, res) => {
  if (!stmt) return res.json({ hit: false });
  const row = stmt.getMatch.get(req.params.id, CURRENT_SEASON);
  if (!row) return res.json({ hit: false });
  res.json({ hit: true, data: JSON.parse(row.data) });
});

app.post('/db/matches', (req, res) => {
  if (!stmt) return res.json({ ok: false });
  const { matches } = req.body;
  if (!Array.isArray(matches)) return res.status(400).json({ error: 'expected matches array' });
  stmt.setMatches(matches);
  res.json({ ok: true, stored: matches.length });
});

// ─── DB: rank cache ────────────────────────────────────────────────────────────
app.post('/db/ranks/get', (req, res) => {
  if (!stmt) return res.json({ ranks: {} });
  const { puuids } = req.body;
  if (!Array.isArray(puuids)) return res.status(400).json({ error: 'expected puuids array' });
  const rows = stmt.getRanks(puuids);
  const ranks = {};
  for (const row of rows) ranks[row.puuid] = row.mmr;
  res.json({ ranks });
});

app.post('/db/ranks/set', (req, res) => {
  if (!stmt) return res.json({ ok: false });
  const { ranks } = req.body;
  if (!Array.isArray(ranks)) return res.status(400).json({ error: 'expected ranks array' });
  stmt.setRanks(ranks);
  res.json({ ok: true });
});

// ─── DB: stats ─────────────────────────────────────────────────────────────────
app.get('/db/stats', (req, res) => {
  if (!stmt) return res.json({ available: false, season: CURRENT_SEASON });
  const row = stmt.stats.get(CURRENT_SEASON, CURRENT_SEASON);
  res.json({ available: true, season: CURRENT_SEASON, matches: row.matches, ranks: row.ranks });
});

// ─── Config ────────────────────────────────────────────────────────────────────
app.get('/config', (req, res) => {
  res.json({ season: CURRENT_SEASON });
});

// ─── Static ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('//riot.txt', (req, res) => res.sendFile(path.join(__dirname, 'riot.txt')));

app.listen(PORT, () => {
  console.log(`MMR proxy + cache running on http://localhost:${PORT}`);
});