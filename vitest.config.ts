import { defineConfig } from 'vitest/config';
import baseline from './coverage-baseline.json' with { type: 'json' };

// The floor is 85 percent; once the committed baseline is higher, it becomes
// the floor, so coverage can rise but never quietly fall.
const FLOOR = 85;

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        lines: Math.max(FLOOR, baseline.lines),
        branches: Math.max(FLOOR, baseline.branches),
      },
    },
  },
});
