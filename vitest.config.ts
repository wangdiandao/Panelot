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
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text', 'json-summary', 'lcov', 'html'],
      reportsDirectory: 'coverage',
      reportOnFailure: true,
      thresholds: {
        // Ratchet the measured repository baseline. Raise these values as
        // coverage grows; reductions require an explicit review.
        lines: 58,
        branches: 50,
        'src/engine/runState.ts': { branches: 72 },
        'src/gatekeeper/gatekeeper.ts': { branches: 93 },
        'src/gatekeeper/rules.ts': { branches: 87 },
        'src/gatekeeper/service.ts': { branches: 78 },
        'src/security/secretStore.ts': { branches: 80 },
        'src/data/exportImport.ts': { branches: 52 },
      },
    },
  },
});
