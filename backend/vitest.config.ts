import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Périodes « jour » / « semaine » calculées en heure locale : on fige le fuseau pour les tests.
    env: { TZ: 'Europe/Paris' },
  },
});
