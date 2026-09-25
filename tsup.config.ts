import { defineConfig } from "tsup"

export default defineConfig([
  {
    entry: { runner: "src/runner/main.ts" },
    outDir: "dist",
    format: ["esm"],
    platform: "node",
    target: "node22",
    bundle: true,
    sourcemap: true,
    clean: false,
    // dependências de node_modules continuam externas (instaladas via npm ci)
    skipNodeModulesBundle: true,
  },
  {
    // agente do worker: um arquivo só, com as dependências embutidas (o worker não roda npm)
    entry: { agent: "src/agent/main.ts" },
    outDir: "dist",
    format: ["esm"],
    platform: "node",
    target: "node22",
    bundle: true,
    sourcemap: false,
    clean: false,
    noExternal: [/.*/],
  },
])
