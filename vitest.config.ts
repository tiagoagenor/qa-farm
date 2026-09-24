import path from "node:path"

import react from "@vitejs/plugin-react"
import tsconfigPaths from "vite-tsconfig-paths"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  resolve: { alias: { "server-only": path.resolve(__dirname, "tests/stubs/empty.ts") } },
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    restoreMocks: true,
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
})
