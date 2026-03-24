# MMR Checker

> Estimate true MMR for any League of Legends summoner — ranked and normals — using the Riot Games API.

---

## What it does

MMR Checker looks up a summoner's match history and reverse-engineers their hidden matchmaking rating (MMR) by analyzing the ranked ratings of everyone they've been matched with. It works for both **ranked queues** (using actual LP/rank data) and **normal games** (using opponent rank as a proxy).

**Features:**
- Ranked MMR — pulls Solo/Duo and Flex rank directly from the Riot API and converts to a numeric MMR
- Normal MMR — scans full normal match history, fetches the rank of every opponent/teammate, and estimates MMR from the average
- SQLite caching — match data and player ranks are cached locally so repeat lookups are near-instant
- Season-aware cache — old-season data is automatically wiped on startup when you bump the season constant
- Dark/light theme toggle
- Works across all regions (NA, EUW, KR, BR, etc.)

---

## Setup

### Prerequisites

- Node.js 18+
- A [Riot Games API key](https://developer.riotgames.com/) (free, but rate-limited; production key recommended for heavy use)

### Install

```bash
npm install
```

### Configure

Set your Riot API key as an environment variable:

```bash
export RIOT_API_KEY=RGAPI-your-key-here
```

Or create a `.env` file (requires `dotenv` package):

```
RIOT_API_KEY=RGAPI-your-key-here
```

### Run

```bash
node server.js
```

Open [http://localhost:3001](http://localhost:3001) in your browser.

---

## Deployment

### Railway (recommended — free tier)

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Add `RIOT_API_KEY` in the **Variables** tab
4. Railway auto-detects Node.js and deploys — you get a free `.railway.app` URL

> **Note:** The free tier uses an ephemeral filesystem, so the SQLite cache resets on each restart. The app works fine without persistence; repeat lookups within a session are still cached in memory.

### Render

1. Connect your GitHub repo at [render.com](https://render.com)
2. Create a **Web Service**
3. Build command: `npm install` | Start command: `node server.js`
4. Add `RIOT_API_KEY` as an environment variable

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `RIOT_API_KEY` | *(hardcoded fallback)* | Your Riot Games API key |
| `PORT` | `3001` | Port the server listens on |

---

## API Endpoints

The server exposes these endpoints (used internally by the frontend):

| Endpoint | Method | Description |
|---|---|---|
| `/riot?url=...` | GET | Proxy for Riot API calls (adds auth header) |
| `/db/match/:id` | GET | Get a single cached match |
| `/db/matches` | POST | Store a batch of matches |
| `/db/ranks/get` | POST | Bulk-fetch cached player ranks |
| `/db/ranks/set` | POST | Store a batch of player ranks |
| `/db/stats` | GET | Cache stats (match count, rank count) |
| `/config` | GET | Returns current season string |

---

## Season Config

To reset the cache for a new ranked season, update the constant at the top of `server.js`:

```js
const CURRENT_SEASON = 'S2026_1';
```

All cached rows from previous seasons are wiped automatically on startup.

---

## Tech Stack

- **Backend:** Node.js, Express, better-sqlite3
- **Frontend:** Vanilla JS, HTML/CSS (no framework)
- **Data:** Riot Games Match v5 API, League v4 API