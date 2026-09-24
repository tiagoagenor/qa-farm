import path from "node:path"

import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // o repositório é a raiz (evita o Next "adivinhar" outra pasta com package-lock)
  outputFileTracingRoot: path.resolve(__dirname),
  poweredByHeader: false,
}

export default nextConfig
