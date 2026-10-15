export type Result = 'W' | 'L';

export interface StreakInfo {
  /** Série en cours (dernière partie incluse), null si aucune partie. */
  current: { result: Result; count: number } | null;
  longestWin: number;
  longestLoss: number;
}

/** `results` en ordre chronologique (plus ancienne d'abord), remakes déjà exclus. */
export function computeStreaks(results: readonly Result[]): StreakInfo {
  let longestWin = 0;
  let longestLoss = 0;
  let run = 0;
  let prev: Result | null = null;

  for (const r of results) {
    run = r === prev ? run + 1 : 1;
    prev = r;
    if (r === 'W') longestWin = Math.max(longestWin, run);
    else longestLoss = Math.max(longestLoss, run);
  }

  return {
    current: prev ? { result: prev, count: run } : null,
    longestWin,
    longestLoss,
  };
}
