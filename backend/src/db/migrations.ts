/**
 * Migrations SQL ordonnées. L'index + 1 correspond à PRAGMA user_version.
 * Ne jamais modifier une migration déjà appliquée : en ajouter une nouvelle.
 * (Gardées en TS plutôt qu'en .sql pour ne pas avoir à copier de fichiers au build.)
 */
import type { Db } from './index.js';

/** Une migration est du SQL, ou une fonction quand il faut lire du JSON (backfill). */
export type Migration = string | ((db: Db) => void);

export const migrations: Migration[] = [
  // 1 — socle : réglages, comptes, cache HTTP Riot
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE accounts (
    puuid      TEXT PRIMARY KEY,
    game_name  TEXT NOT NULL,
    tag_line   TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX accounts_riot_id ON accounts (lower(game_name), lower(tag_line));

  CREATE TABLE http_cache (
    key        TEXT PRIMARY KEY,
    status     INTEGER NOT NULL,
    body       TEXT,
    fetched_at INTEGER NOT NULL,
    expires_at INTEGER           -- NULL = n'expire jamais (ex. détail de partie)
  );
  CREATE INDEX http_cache_expires ON http_cache (expires_at);
  `,

  // 2 — parties, snapshots de rang, sessions
  // Le gain de LP par partie n'est pas stocké : il est recalculé à la volée depuis les snapshots
  // (cf. domain/lp.ts), ce qui corrige tout seul les attributions quand une partie arrive en retard.
  `
  CREATE TABLE matches (
    match_id     TEXT PRIMARY KEY,
    queue_id     INTEGER NOT NULL,
    game_start   INTEGER NOT NULL,   -- ms epoch
    game_end     INTEGER NOT NULL,   -- ms epoch
    duration_s   INTEGER NOT NULL,
    game_version TEXT,
    raw_json     TEXT NOT NULL       -- MatchDto complet, pour les besoins futurs (objets, runes…)
  );
  CREATE INDEX matches_end ON matches (game_end);

  CREATE TABLE match_participants (
    match_id           TEXT NOT NULL REFERENCES matches (match_id) ON DELETE CASCADE,
    puuid              TEXT NOT NULL,
    team_id            INTEGER NOT NULL,
    champion_id        INTEGER NOT NULL,
    champion_name      TEXT NOT NULL,
    position           TEXT,
    win                INTEGER NOT NULL,
    remake             INTEGER NOT NULL,   -- gameEndedInEarlySurrender
    kills              INTEGER NOT NULL,
    deaths             INTEGER NOT NULL,
    assists            INTEGER NOT NULL,
    cs                 INTEGER NOT NULL,   -- totalMinionsKilled + neutralMinionsKilled
    vision             INTEGER NOT NULL,
    gold               INTEGER NOT NULL,
    damage             INTEGER NOT NULL,   -- totalDamageDealtToChampions
    kill_participation REAL,               -- challenges.killParticipation (absent sur certains modes)
    champ_level        INTEGER,
    riot_id_name       TEXT,
    riot_id_tag        TEXT,
    PRIMARY KEY (match_id, puuid)
  );
  CREATE INDEX match_participants_puuid ON match_participants (puuid);

  CREATE TABLE rank_snapshots (
    id         INTEGER PRIMARY KEY,
    puuid      TEXT NOT NULL,
    queue_type TEXT NOT NULL,            -- RANKED_SOLO_5x5 | RANKED_FLEX_SR
    tier       TEXT NOT NULL,
    division   TEXT NOT NULL,            -- I..IV (I pour Master+)
    lp         INTEGER NOT NULL,
    wins       INTEGER NOT NULL,
    losses     INTEGER NOT NULL,
    taken_at   INTEGER NOT NULL,         -- ms epoch
    trigger    TEXT NOT NULL             -- poll | session_start | startup
  );
  CREATE INDEX rank_snapshots_lookup ON rank_snapshots (puuid, queue_type, taken_at);

  CREATE TABLE sessions (
    id         INTEGER PRIMARY KEY,
    started_at INTEGER NOT NULL,
    ended_at   INTEGER
  );
  `,

  // 3 — solo kills et objectifs épiques volés par joueur (repères Duelliste et Smite),
  //     remplis pour les parties déjà stockées à partir du JSON brut (une lecture par partie).
  //     `.all()` et non `.iterate()` : better-sqlite3 interdit d'écrire pendant qu'un curseur est ouvert.
  (db) => {
    db.exec('ALTER TABLE match_participants ADD COLUMN solo_kills INTEGER');
    db.exec('ALTER TABLE match_participants ADD COLUMN epic_steals INTEGER');
    const update = db.prepare('UPDATE match_participants SET solo_kills = ?, epic_steals = ? WHERE match_id = ? AND puuid = ?');
    for (const row of db.prepare<[], { match_id: string; raw_json: string }>('SELECT match_id, raw_json FROM matches').all()) {
      const dto = JSON.parse(row.raw_json) as { info?: { participants?: Array<{ puuid: string; challenges?: { soloKills?: number; epicMonsterSteals?: number } }> } };
      for (const p of dto.info?.participants ?? []) {
        update.run(p.challenges?.soloKills ?? null, p.challenges?.epicMonsterSteals ?? null, row.match_id, p.puuid);
      }
    }
  },
];
