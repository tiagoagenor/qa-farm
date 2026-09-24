import { defineConfig } from "tsup"

export default defineConfig({
  entry: { runner: "src/runner/main.ts" },
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node22",
  bundle: true,
  sourcemap: true,
  clean: true,
  // dependências de node_modules continuam externas (instaladas via npm ci)
  skipNodeModulesBundle: true,
})
