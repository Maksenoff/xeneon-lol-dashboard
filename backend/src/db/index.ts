import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { migrations } from './migrations.js';

export type Db = Database.Database;

/** Ouvre (ou crée) la base. `':memory:'` pour les tests. */
export function openDb(dataDir: string | ':memory:'): Db {
  let file = ':memory:';
  if (dataDir !== ':memory:') {
    fs.mkdirSync(dataDir, { recursive: true });
    file = path.join(dataDir, 'xeneon-lol.db');
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

/** Applique les migrations manquantes, versionnées via PRAGMA user_version. */
export function migrate(db: Db): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < migrations.length; v++) {
    db.transaction(() => {
      const migration = migrations[v]!;
      if (typeof migration === 'string') db.exec(migration);
      else migration(db);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
