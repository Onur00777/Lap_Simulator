import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/scratch/**', 'node_modules/**'],
    environment: 'node',
    testTimeout: 60000,
  },
});
