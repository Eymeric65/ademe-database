import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Unit tests run in node. Tests that need a real D1 use the workers pool
    // and live under test/db/ with their own config -- there is no mock
    // database here on purpose (CLAUDE.md section 3).
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
  },
})
