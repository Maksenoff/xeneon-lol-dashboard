/**
 * Migrations SQL ordonnées. L'index + 1 correspond à PRAGMA user_version.
 * Ne jamais modifier une migration déjà appliquée : en ajouter une nouvelle.
 * (Gardées en TS plutôt qu'en .sql pour ne pas avoir à copier de fichiers au build.)
 */
export const migrations: string[] = [
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
];
