/**
 * Files de jeu. IDs vérifiés dans https://static.developer.riotgames.com/docs/lol/queues.json (oct. 2026).
 */

export const MODES = {
  rsolo: [420],
  flex: [440],
  normal: [400, 430, 480, 490], // Draft, Blind, Swiftplay, Quickplay
  aram: [450, 2400], // ARAM, ARAM : Mayhem
  all: null, // toutes les files stockées
} as const satisfies Record<string, readonly number[] | null>;

export type Mode = keyof typeof MODES;
export const MODE_NAMES = Object.keys(MODES) as Mode[];

export const RANKED_QUEUE_TYPE: Record<number, RankedQueueType> = {
  420: 'RANKED_SOLO_5x5',
  440: 'RANKED_FLEX_SR',
};
export type RankedQueueType = 'RANKED_SOLO_5x5' | 'RANKED_FLEX_SR';
export const TRACKED_QUEUE_TYPES: RankedQueueType[] = ['RANKED_SOLO_5x5', 'RANKED_FLEX_SR'];

export const QUEUE_TYPE_BY_MODE: Partial<Record<Mode, RankedQueueType>> = {
  rsolo: 'RANKED_SOLO_5x5',
  flex: 'RANKED_FLEX_SR',
};

const QUEUE_LABELS: Record<number, string> = {
  400: 'Normale (Draft)',
  420: 'Classée Solo/Duo',
  430: 'Normale (Blind)',
  440: 'Classée Flex',
  450: 'ARAM',
  480: 'Swiftplay',
  490: 'Partie rapide',
  700: 'Clash',
  900: 'ARURF',
  1700: 'Arena',
  1900: 'URF',
  2400: 'ARAM : Mayhem',
};

export function queueLabel(queueId: number): string {
  return QUEUE_LABELS[queueId] ?? `File ${queueId}`;
}

export function queuesForMode(mode: Mode): readonly number[] | null {
  return MODES[mode];
}
