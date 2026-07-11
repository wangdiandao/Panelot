import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Mirror .wxt/tsconfig.json's "@/*" → project root (shadcn ui imports).
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text', 'json-summary', 'lcov', 'html'],
      reportsDirectory: 'coverage',
      reportOnFailure: true,
      thresholds: {
        lines: 80,
        branches: 80,
        'src/engine/runState.ts': { branches: 90 },
        'src/gatekeeper/gatekeeper.ts': { branches: 90 },
        'src/gatekeeper/rules.ts': { branches: 90 },
        'src/gatekeeper/service.ts': { branches: 90 },
        'src/security/secretStore.ts': { branches: 90 },
        'src/data/exportImport.ts': { branches: 90 },
      },
    },
  },
});
