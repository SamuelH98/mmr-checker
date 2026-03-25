const express = require('express');
const cors    = require('cors');
const path    = require('path');

const app          = express();
const PORT         = process.env.PORT || 3001;
const RIOT_API_KEY = process.env.RIOT_API_KEY;

// ─── Season config ─────────────────────────────────────────────────────────────
// Bump this string whenever a new ranked season starts.
// All cached data from previous seasons is wiped on startup.
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
  `);

  // Wipe any rows from old seasons
  const m = db.prepare('DELETE FROM matches      WHERE season != ?').run(CURRENT_SEASON);
  const r = db.prepare('DELETE FROM player_ranks WHERE season != ?').run(CURRENT_SEASON);
  if (m.changes || r.changes)
    console.log(`[DB] Season wipe: removed ${m.changes} matches, ${r.changes} rank rows`);

  stmt = {
    getMatch:  db.prepare('SELECT data FROM matches       WHERE match_id = ? AND season = ?'),
    setMatches: db.transaction((rows) => {
      const ins = db.prepare('INSERT OR REPLACE INTO matches (match_id, season, data, fetched_at) VALUES (?, ?, ?, ?)');
      for (const { id, data } of rows) ins.run(id, CURRENT_SEASON, JSON.stringify(data), Date.now());
    }),
    getRanks: (puuids) => {
      const qmarks = puuids.map(() => '?').join(',');
      if (!puuids.length) return [];
      return db.prepare(`SELECT puuid, mmr FROM player_ranks WHERE puuid IN (${qmarks}) AND season = ?`)
               .all(...puuids, CURRENT_SEASON);
    },
    setRanks: db.transaction((rows) => {
      const ins = db.prepare('INSERT OR REPLACE INTO player_ranks (puuid, season, mmr, fetched_at) VALUES (?, ?, ?, ?)');
      for (const { puuid, mmr } of rows) ins.run(puuid, CURRENT_SEASON, mmr, Date.now());
    }),
    stats: db.prepare('SELECT (SELECT COUNT(*) FROM matches WHERE season=?) as matches, (SELECT COUNT(*) FROM player_ranks WHERE season=?) as ranks'),
  };

  console.log(`[DB] SQLite ready — season ${CURRENT_SEASON}`);
} catch (e) {
  console.warn('[DB] better-sqlite3 unavailable — caching disabled. Run: npm install better-sqlite3\n     Error:', e.message);
}

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

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

// ─── DB: get one cached match ───────────────────────────────────────────────────
app.get('/db/match/:id', (req, res) => {
  if (!stmt) return res.json({ hit: false });
  const row = stmt.getMatch.get(req.params.id, CURRENT_SEASON);
  if (!row) return res.json({ hit: false });
  res.json({ hit: true, data: JSON.parse(row.data) });
});

// ─── DB: store match batch ──────────────────────────────────────────────────────
// POST /db/matches  body: { matches: [{ id, data }] }
app.post('/db/matches', (req, res) => {
  if (!stmt) return res.json({ ok: false, cached: false });
  const { matches } = req.body;
  if (!Array.isArray(matches)) return res.status(400).json({ error: 'expected matches array' });
  stmt.setMatches(matches);
  res.json({ ok: true, stored: matches.length });
});

// ─── DB: bulk get cached ranks ──────────────────────────────────────────────────
// POST /db/ranks/get  body: { puuids: [...] }
app.post('/db/ranks/get', (req, res) => {
  if (!stmt) return res.json({ ranks: {} });
  const { puuids } = req.body;
  if (!Array.isArray(puuids)) return res.status(400).json({ error: 'expected puuids array' });
  const rows = stmt.getRanks(puuids);
  const ranks = {};
  for (const row of rows) ranks[row.puuid] = row.mmr; // null = confirmed unranked
  res.json({ ranks });
});

// ─── DB: store rank batch ───────────────────────────────────────────────────────
// POST /db/ranks/set  body: { ranks: [{ puuid, mmr }] }
app.post('/db/ranks/set', (req, res) => {
  if (!stmt) return res.json({ ok: false });
  const { ranks } = req.body;
  if (!Array.isArray(ranks)) return res.status(400).json({ error: 'expected ranks array' });
  stmt.setRanks(ranks);
  res.json({ ok: true });
});

// ─── DB: stats ──────────────────────────────────────────────────────────────────
app.get('/db/stats', (req, res) => {
  if (!stmt) return res.json({ available: false, season: CURRENT_SEASON });
  const row = stmt.stats.get(CURRENT_SEASON, CURRENT_SEASON);
  res.json({ available: true, season: CURRENT_SEASON, matches: row.matches, ranks: row.ranks });
});

// ─── Config ─────────────────────────────────────────────────────────────────────
app.get('/config', (req, res) => {
  res.json({ season: CURRENT_SEASON });
});

// ─── Static ─────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// This file is used to verify domain ownership for Riot's API key system. It must be served from the root.
app.get('//riot.txt', (req, res) => res.sendFile(path.join(__dirname, 'riot.txt')));

app.listen(PORT, () => {
  console.log(`MMR proxy + cache running on http://localhost:${PORT}`);
});