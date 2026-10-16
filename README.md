# Xeneon LoL Dashboard

League of Legends dashboard widgets for the **Corsair Xeneon Edge** touchscreen (14.5", 2560×720), displayed through **iCUE** HTML widgets and powered exclusively by the **official Riot Games API**.

> *Xeneon LoL Dashboard isn't endorsed by Riot Games and doesn't reflect the views or opinions of Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games, and all associated properties are trademarks or registered trademarks of Riot Games, Inc.*

## Features

- **Play session tracking** — wins/losses, LP gained per game (derived from League-V4 rank snapshots taken before and after each game), win/loss streaks, KDA, CS/min, damage, vision, kill participation, play time. Filters: Solo/Duo, Flex, Normal, ARAM, all queues; session, day or week.
- **Rank** — official ranked emblem, LP progress, season win rate.
- **Top champions** — most played champions of the period with detailed stats and champion mastery.
- **Match details** — the 10 players with KDA, CS, damage share, gold, kill participation and current rank, best-of-game highlights, and a lane-by-lane duel comparison (Top vs Top, …).
- **Live game** (only once the game has loaded — never during champion select) — the 10 players sorted by role, with rank, recent win rate, champion mastery and factual tags (win/loss streak, one-trick, low experience on the champion). No timers, no automation, nothing hidden by the game client.

## Architecture

```
iCUE widget (HTML/CSS/JS, display only)  ──HTTP──▶  Node.js backend (Fastify, TypeScript)
                                                     ├─ Riot API client: SQLite cache, rate limiter
                                                     │  (reads X-Rate-Limit headers, honors Retry-After on 429)
                                                     ├─ SQLite: matches, rank snapshots, sessions
                                                     └─ Data Dragon + official ranked emblems (cached on disk)
```

Riot APIs used: **Account-V1, Match-V5, League-V4, Champion-Mastery-V4, Spectator-V5**, plus **Data Dragon** and the local **Live Client Data API**. No third-party site is scraped.

The API key is read from a local `.env` file and never committed (see `.gitignore`).

## Setup (local development)

Requirements: Windows, Node.js 20+, iCUE 5.47+, a Corsair Xeneon Edge.

```powershell
copy .env.example .env          # then set RIOT_API_KEY
cd backend
npm install
npm test                         # Vitest, Riot responses are mocked
npm run dev                      # http://localhost:3417
```

Run the backend in the background at Windows logon: `.\scripts\install-autostart.ps1` (remove with `.\scripts\uninstall-autostart.ps1`).

Widgets: package with the official Corsair CLI (`npx icuewidget-cli package widgets/lol-session`) and import the `.icuewidget` file in iCUE (Xeneon Edge → Widgets → **+**).

## Project layout

| Path | Content |
|---|---|
| `backend/src/riot/` | Riot API client, rate limiter, cache, endpoints |
| `backend/src/domain/` | Pure logic: LP attribution, rank scale, periods, streaks, queues |
| `backend/src/services/` | Match sync, rank snapshots, session, live game, match detail |
| `backend/src/routes/` | HTTP API consumed by the widgets |
| `backend/tests/` | Unit and integration tests (Vitest) |
| `widgets/lol-session/` | iCUE widget (session, match details, live game) |
| `scripts/` | Windows autostart scripts |
