import { vi } from 'vitest';
import { parseConfig, type AppConfig } from '../src/config.js';

export const TEST_API_KEY = 'RGAPI-test-key-not-real';

export function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return parseConfig({ RIOT_API_KEY: TEST_API_KEY, DATA_DIR: '/tmp/unused', LOG_LEVEL: 'silent', ...overrides });
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/** Faux fetch : chaque appel consomme la réponse suivante de la liste. */
export function sequenceFetch(...responses: Array<Response | (() => Response)>) {
  const queue = [...responses];
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
    const next = queue.shift();
    if (!next) throw new Error('fetch appelé plus de fois que prévu');
    return typeof next === 'function' ? next() : next;
  });
}
