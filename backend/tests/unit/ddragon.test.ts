import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DataDragon } from '../../src/ddragon/ddragon.js';
import { buildApp } from '../../src/app.js';
import { openDb } from '../../src/db/index.js';
import { jsonResponse, routerFetch, testConfig } from '../helpers.js';

const noopLogger = { debug() {}, info() {}, warn() {} };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

// Extrait au format réel de champion.json (fr_FR) : id = clé d'image, key = ID numérique.
const CHAMPIONS = {
  data: {
    Vayne: { id: 'Vayne', key: '67', name: 'Vayne' },
    MonkeyKing: { id: 'MonkeyKing', key: '62', name: 'Wukong' },
  },
};

function cdn(opts: { online: boolean }) {
  return routerFetch((url) => {
    if (!opts.online) throw new TypeError('fetch failed');
    if (url.pathname === '/api/versions.json') return jsonResponse(['16.20.1', '16.19.1']);
    if (url.pathname === '/cdn/16.20.1/data/fr_FR/champion.json') return jsonResponse(CHAMPIONS);
    if (url.pathname === '/cdn/16.20.1/img/champion/MonkeyKing.png') return new Response(PNG);
    return undefined;
  });
}

describe('DataDragon', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xlol-ddragon-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('résout les noms français par ID numérique et met les icônes en cache disque', async () => {
    const fetchFn = cdn({ online: true });
    const dd = new DataDragon(dir, noopLogger, fetchFn);
    await dd.ensureLoaded();
    expect(dd.championName(62)).toBe('Wukong');
    expect(await dd.championIcon(62)).toEqual(PNG);
    const calls = fetchFn.mock.calls.length;
    expect(await dd.championIcon(62)).toEqual(PNG); // 2e fois : disque
    expect(fetchFn.mock.calls.length).toBe(calls);
    expect(fs.existsSync(path.join(dir, 'ddragon', '16.20.1', 'img', 'MonkeyKing.png'))).toBe(true);
    expect(await dd.championIcon(99999)).toBeNull();
  });

  it('fonctionne hors ligne avec les fichiers déjà téléchargés', async () => {
    await new DataDragon(dir, noopLogger, cdn({ online: true })).ensureLoaded();
    const offline = new DataDragon(dir, noopLogger, cdn({ online: false }));
    await offline.ensureLoaded();
    expect(offline.championName(67)).toBe('Vayne');
  });

  it('ne lève jamais si le CDN est injoignable et rien n’est en cache', async () => {
    const dd = new DataDragon(dir, noopLogger, cdn({ online: false }));
    await expect(dd.ensureLoaded()).resolves.toBeUndefined();
    expect(dd.championName(67)).toBeUndefined();
  });

  it('résout un champion par nom affiché et sert le splash art', async () => {
    const SPLASH = Buffer.from([0xff, 0xd8, 0xff, 9]);
    const fetchFn = routerFetch((url) => {
      if (url.pathname === '/api/versions.json') return jsonResponse(['16.20.1']);
      if (url.pathname === '/cdn/16.20.1/data/fr_FR/champion.json') return jsonResponse(CHAMPIONS);
      if (url.pathname === '/cdn/img/champion/splash/MonkeyKing_3.jpg') return new Response(SPLASH);
      return undefined;
    });
    const db = openDb(':memory:');
    const { app } = await buildApp({ config: testConfig({ DATA_DIR: dir }), db, fetchFn, logger: false });
    const ok = await app.inject({ method: 'GET', url: '/api/assets/splash/wukong/3.jpg' });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('image/jpeg');
    expect(ok.rawPayload).toEqual(SPLASH);
    expect((await app.inject({ method: 'GET', url: '/api/assets/splash/Inconnu/3.jpg' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/assets/splash/Vayne/abc.jpg' })).statusCode).toBe(400);
    await app.close();
    db.close();
  });

  it('extrait les emblèmes officiels du zip Riot et les sert', async () => {
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip();
    zip.addFile('Ranked Emblems Latest/Rank=Emerald.png', PNG);
    zip.addFile('Ranked Emblems Latest/Wings/Emerald.png', Buffer.from('ignoré'));
    const zipBuf = zip.toBuffer();
    let downloads = 0;
    const fetchFn = routerFetch((url) => {
      if (url.pathname === '/docs/lol/ranked-emblems-latest.zip') {
        downloads++;
        return new Response(zipBuf);
      }
      return undefined;
    });
    const db = openDb(':memory:');
    const { app } = await buildApp({ config: testConfig({ DATA_DIR: dir }), db, fetchFn, logger: false });
    const ok = await app.inject({ method: 'GET', url: '/api/assets/rank/emerald.png' });
    expect(ok.statusCode).toBe(200);
    expect(ok.rawPayload).toEqual(PNG);
    expect((await app.inject({ method: 'GET', url: '/api/assets/rank/EMERALD.png' })).statusCode).toBe(200);
    expect(downloads).toBe(1); // zip téléchargé une seule fois
    expect((await app.inject({ method: 'GET', url: '/api/assets/rank/wood.png' })).statusCode).toBe(404);
    await app.close();
    db.close();
  });

  it('sert l’icône via /api/assets/champion/:id.png', async () => {
    const db = openDb(':memory:');
    const { app } = await buildApp({ config: testConfig({ DATA_DIR: dir }), db, fetchFn: cdn({ online: true }), logger: false });
    const ok = await app.inject({ method: 'GET', url: '/api/assets/champion/62.png' });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('image/png');
    expect(ok.rawPayload).toEqual(PNG);
    expect((await app.inject({ method: 'GET', url: '/api/assets/champion/..%2Fsecret.png' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/assets/champion/12345.png' })).statusCode).toBe(404);
    await app.close();
    db.close();
  });
});
