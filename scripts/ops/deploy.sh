#!/usr/bin/env bash
# deploy.sh — atualiza o QA Farm no server01: git pull → npm ci → build → reinicia web e runner.
# Casos em execução durante o deploy voltam para a fila automaticamente (recuperação do runner).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"
export PATH="$HOME/node/bin:$PATH"

git pull --ff-only
# npm ci exige lock idêntico; o npm do Mac omite deps opcionais WASM do Linux (@emnapi) → cai para npm install
npm ci --no-audit --no-fund || { npm install --no-audit --no-fund && git checkout -- package-lock.json; }
npm run build
chmod +x scripts/ops/*.sh scripts/farm/*.sh
scripts/ops/supervisor.sh restart
sleep 3
scripts/ops/supervisor.sh status
echo "Deploy concluído: $(git log --oneline -1)"
