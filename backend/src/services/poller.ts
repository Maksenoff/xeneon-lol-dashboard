import type { Logger } from '../riot/client.js';
import { Priority } from '../riot/rateLimiter.js';
import type { AccountService } from './accountService.js';
import type { MatchSyncService } from './matchSync.js';
import type { RankSnapshotService } from './rankSnapshots.js';
import { BACKFILL_MS } from './sessionService.js';

export interface PollerDeps {
  accounts: AccountService;
  matches: MatchSyncService;
  ranks: RankSnapshotService;
  logger: Logger;
  intervalMs?: number;
}

/**
 * Tâche de fond : snapshot League-V4 + synchro Match-V5 toutes les `intervalMs`.
 * Coût : ~2 requêtes par minute, très loin des 100 / 2 min d'une clé de développement.
 * Au démarrage : historique des 14 derniers jours (100 parties max) en basse priorité.
 */
export class Poller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly deps: PollerDeps) {}

  start(): void {
    void this.tick('startup');
    this.timer = setInterval(() => void this.tick('poll'), this.deps.intervalMs ?? 60_000);
    this.timer.unref();
  }

  /** Lance un cycle immédiatement (ex. après un changement de compte suivi). */
  kick(): void {
    void this.tick('poll');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(trigger: 'startup' | 'poll'): Promise<void> {
    if (this.running) return;
    this.running = true;
    const { accounts, matches, ranks, logger } = this.deps;
    try {
      const { puuid } = await accounts.me();
      await ranks.capture(puuid, trigger, { priority: Priority.Background });
      const now = Date.now();
      const lastEnd = matches.lastGameEnd(puuid);
      const sinceMs = trigger === 'startup' || !lastEnd ? now - BACKFILL_MS : Math.max(lastEnd - 3600_000, now - BACKFILL_MS);
      await matches.sync(puuid, { sinceMs, maxMatches: 100, priority: Priority.Background });
    } catch (err) {
      logger.warn({ err: String(err), trigger }, 'Cycle de synchro en échec');
    } finally {
      this.running = false;
    }
  }
}
