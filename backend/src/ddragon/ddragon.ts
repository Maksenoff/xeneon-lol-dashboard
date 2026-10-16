import fs from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../riot/client.js';

/**
 * Data Dragon (CDN officiel Riot) : noms français et icônes des champions.
 * Tout est mis en cache sur disque dans <DATA_DIR>/ddragon/<version>/ ; aucune clé API n'est envoyée.
 */

const CDN = 'https://ddragon.leagueoflegends.com';
const VERSION_TTL_MS = 6 * 3600_000;
const SAFE_KEY = /^[A-Za-z0-9]+$/;
const FETCH_TIMEOUT_MS = 10_000;

interface ChampionJson {
  data: Record<string, { id: string; key: string; name: string }>;
}

export class DataDragon {
  private version: string | null = null;
  private versionCheckedAt = 0;
  private champions = new Map<number, { key: string; name: string }>();
  private loading: Promise<void> | null = null;

  constructor(
    private readonly dataDir: string,
    private readonly logger: Logger,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private get root(): string {
    return path.join(this.dataDir, 'ddragon');
  }

  /** Charge (ou rafraîchit toutes les 6 h) la version courante et la liste des champions. Ne lève jamais. */
  ensureLoaded(): Promise<void> {
    if (this.version && this.now() - this.versionCheckedAt < VERSION_TTL_MS) return Promise.resolve();
    if (!this.loading) {
      this.loading = this.load()
        .catch((err) => this.logger.warn({ err: String(err) }, 'Data Dragon indisponible'))
        .finally(() => {
          this.loading = null;
        });
    }
    return this.loading;
  }

  /** Nom affiché (français), ou undefined si Data Dragon n'est pas chargé. */
  championName(championId: number): string | undefined {
    return this.champions.get(championId)?.name;
  }

  /** Icône PNG du champion, téléchargée une fois puis servie depuis le disque. */
  async championIcon(championId: number): Promise<Buffer | null> {
    await this.ensureLoaded();
    const champ = this.champions.get(championId);
    if (!this.version || !champ || !SAFE_KEY.test(champ.key)) return null;
    return this.cached(
      path.join(this.root, this.version, 'img', `${champ.key}.png`),
      `${CDN}/cdn/${this.version}/img/champion/${champ.key}.png`,
    );
  }

  /**
   * Retrouve la clé Data Dragon d'un champion à partir de sa clé (« MonkeyKing ») ou de son
   * nom affiché (« Wukong »), sans tenir compte de la casse ni des accents/espaces.
   */
  async resolveChampionKey(input: string): Promise<string | null> {
    await this.ensureLoaded();
    const norm = (s: string) => s.normalize('NFD').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
    const wanted = norm(input);
    for (const c of this.champions.values()) {
      if (norm(c.key) === wanted || norm(c.name) === wanted) return c.key;
    }
    return null;
  }

  /** Splash art plein format (ex. Vayne_25.jpg = Vayne Sentinelle), mis en cache disque. */
  async splash(championKey: string, skinNum: number): Promise<Buffer | null> {
    if (!SAFE_KEY.test(championKey) || !Number.isInteger(skinNum) || skinNum < 0 || skinNum > 999) return null;
    return this.cached(
      path.join(this.root, 'splash', `${championKey}_${skinNum}.jpg`),
      `${CDN}/cdn/img/champion/splash/${championKey}_${skinNum}.jpg`,
    );
  }

  /** Lit `file`, ou le télécharge depuis `url` puis l'enregistre. */
  private async cached(file: string, url: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(file);
    } catch {
      const res = await this.fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, buf);
      return buf;
    }
  }

  private async load(): Promise<void> {
    let version: string | null = null;
    try {
      const res = await this.fetchFn(`${CDN}/api/versions.json`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) version = ((await res.json()) as string[])[0] ?? null;
    } catch (err) {
      this.logger.warn({ err: String(err) }, 'versions.json Data Dragon injoignable');
    }
    version ??= this.version ?? (await this.latestOnDisk());
    if (!version || !/^[0-9.]+$/.test(version)) throw new Error('Aucune version Data Dragon disponible');

    const file = path.join(this.root, version, 'champion.fr_FR.json');
    let json: ChampionJson;
    try {
      json = JSON.parse(await fs.readFile(file, 'utf8')) as ChampionJson;
    } catch {
      const res = await this.fetchFn(`${CDN}/cdn/${version}/data/fr_FR/champion.json`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`champion.json Data Dragon : HTTP ${res.status}`);
      const text = await res.text();
      json = JSON.parse(text) as ChampionJson;
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, text);
    }

    const champions = new Map<number, { key: string; name: string }>();
    for (const c of Object.values(json.data)) champions.set(Number(c.key), { key: c.id, name: c.name });
    this.champions = champions;
    this.version = version;
    this.versionCheckedAt = this.now();
  }

  /** Repli hors ligne : la plus récente version déjà téléchargée. */
  private async latestOnDisk(): Promise<string | null> {
    try {
      const dirs = (await fs.readdir(this.root)).filter((d) => /^[0-9.]+$/.test(d));
      dirs.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      return dirs[0] ?? null;
    } catch {
      return null;
    }
  }
}
