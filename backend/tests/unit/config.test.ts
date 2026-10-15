import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config.js';

describe('parseConfig', () => {
  it('refuse de démarrer sans RIOT_API_KEY', () => {
    expect(() => parseConfig({})).toThrow(/RIOT_API_KEY/);
    expect(() => parseConfig({ RIOT_API_KEY: '   ' })).toThrow(/RIOT_API_KEY/);
  });

  it('applique les valeurs par défaut et découpe le Riot ID', () => {
    const c = parseConfig({ RIOT_API_KEY: 'k', DATA_DIR: 'x' });
    expect(c.riotId).toEqual({ gameName: 'Maksenoff', tagLine: 'EUW' });
    expect(c.region).toBe('europe');
    expect(c.platform).toBe('euw1');
    expect(c.port).toBe(3417);
    expect(c.host).toBe('localhost');
  });

  it('accepte un Riot ID avec espaces et rejette un format invalide', () => {
    expect(parseConfig({ RIOT_API_KEY: 'k', RIOT_ID: 'Some Name#1234' }).riotId).toEqual({
      gameName: 'Some Name',
      tagLine: '1234',
    });
    expect(() => parseConfig({ RIOT_API_KEY: 'k', RIOT_ID: 'SansTag' })).toThrow(/RIOT_ID/);
  });
});
