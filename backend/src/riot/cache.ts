import type { Db } from '../db/index.js';

export interface CacheEntry {
  status: number;
  body: string | null;
  fetchedAt: number;
  expiresAt: number | null;
}

/** Cache disque (SQLite) des réponses Riot, indexé par URL. */
export class HttpCache {
  private readonly getStmt;
  private readonly setStmt;
  private readonly purgeStmt;

  constructor(db: Db, private readonly now: () => number = Date.now) {
    this.getStmt = db.prepare<[string], { status: number; body: string | null; fetched_at: number; expires_at: number | null }>(
      'SELECT status, body, fetched_at, expires_at FROM http_cache WHERE key = ?',
    );
    this.setStmt = db.prepare(
      `INSERT INTO http_cache (key, status, body, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET status = excluded.status, body = excluded.body,
         fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
    );
    this.purgeStmt = db.prepare('DELETE FROM http_cache WHERE expires_at IS NOT NULL AND expires_at < ?');
  }

  /** Entrée encore valide, sinon undefined. */
  get(key: string): CacheEntry | undefined {
    const entry = this.getAny(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) return undefined;
    return entry;
  }

  /** Entrée même expirée (repli si Riot est indisponible). */
  getAny(key: string): CacheEntry | undefined {
    const row = this.getStmt.get(key);
    if (!row) return undefined;
    return { status: row.status, body: row.body, fetchedAt: row.fetched_at, expiresAt: row.expires_at };
  }

  /** ttlMs = Infinity pour une donnée immuable. */
  set(key: string, status: number, body: string | null, ttlMs: number): void {
    const now = this.now();
    this.setStmt.run(key, status, body, now, Number.isFinite(ttlMs) ? now + ttlMs : null);
  }

  /** Supprime les entrées expirées depuis plus de `graceMs`. */
  purge(graceMs = 24 * 3600_000): number {
    return this.purgeStmt.run(this.now() - graceMs).changes;
  }
}
