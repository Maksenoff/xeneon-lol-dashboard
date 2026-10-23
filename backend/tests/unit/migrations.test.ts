import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/index.js';
import { migrations } from '../../src/db/migrations.js';
import { makeMatch, ME } from '../fixtures/factories.js';

describe('migrations', () => {
  it('migration 3 : remplit solo kills et objectifs volés pour les parties déjà stockées', () => {
    // Base « ancienne » (version 2) contenant déjà une partie, comme chez l'utilisateur.
    const db = new Database(':memory:');
    for (const m of migrations.slice(0, 2)) db.exec(m as string);
    db.pragma('user_version = 2');

    const dto = makeMatch({ id: 'EUW1_42', endedAt: Date.now(), win: true });
    dto.info.participants[0]!.challenges = { killParticipation: 0.5, soloKills: 3, epicMonsterSteals: 1 };
    db.prepare('INSERT INTO matches (match_id, queue_id, game_start, game_end, duration_s, raw_json) VALUES (?, 420, 0, 0, 1800, ?)').run(
      'EUW1_42',
      JSON.stringify(dto),
    );
    const insert = db.prepare(
      `INSERT INTO match_participants (match_id, puuid, team_id, champion_id, champion_name, win, remake, kills, deaths, assists, cs, vision, gold, damage)
       VALUES ('EUW1_42', ?, 100, 1, 'Annie', 1, 0, 0, 0, 0, 0, 0, 0, 0)`,
    );
    for (const p of dto.info.participants) insert.run(p.puuid);

    migrate(db);

    expect(db.pragma('user_version', { simple: true })).toBe(migrations.length);
    expect(db.prepare('SELECT solo_kills, epic_steals FROM match_participants WHERE puuid = ?').get(ME)).toEqual({ solo_kills: 3, epic_steals: 1 });
    db.close();
  });
});
