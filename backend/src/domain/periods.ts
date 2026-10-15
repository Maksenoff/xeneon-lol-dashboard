/** Périodes calendaires, en heure locale de la machine. */

export const PERIODS = ['session', 'jour', 'semaine'] as const;
export type Period = (typeof PERIODS)[number];

/** Minuit local du jour de `now`. */
export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Lundi 00:00 local de la semaine de `now`. */
export function startOfWeek(now: number): number {
  const d = new Date(now);
  const daysSinceMonday = (d.getDay() + 6) % 7; // getDay : 0 = dimanche
  d.setDate(d.getDate() - daysSinceMonday);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
