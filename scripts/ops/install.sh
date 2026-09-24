#!/usr/bin/env bash
# install.sh — primeira instalação no server01 (idempotente, sem sudo).
#   - cria .env com senha e segredo aleatórios (se ainda não existir)
#   - instala dependências e faz o build
#   - registra o supervisor no crontab (a cada minuto e no boot)
#   - sobe web e runner
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"
export PATH="$HOME/node/bin:$PATH"

if [ ! -f .env ]; then
  PASS=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 16)
  SECRET=$(openssl rand -hex 32)
  sed -e "s|^QAFARM_PASSWORD=.*|QAFARM_PASSWORD=$PASS|" -e "s|^QAFARM_SECRET=.*|QAFARM_SECRET=$SECRET|" \
      -e "s|/home/server01|$HOME|g" .env.example > .env
  chmod 600 .env
  echo "Criado .env (senha do painel: $PASS)"
fi

# npm ci exige lock idêntico; o npm do Mac omite deps opcionais WASM do Linux (@emnapi) → cai para npm install
npm ci --no-audit --no-fund || { npm install --no-audit --no-fund && git checkout -- package-lock.json; }
npm run build
chmod +x scripts/ops/*.sh scripts/farm/*.sh

CRON_START="* * * * * $REPO/scripts/ops/supervisor.sh start >/dev/null 2>&1"
CRON_BOOT="@reboot sleep 30 && $REPO/scripts/ops/supervisor.sh start >/dev/null 2>&1"
{ crontab -l 2>/dev/null | grep -v "qa-farm/scripts/ops/supervisor.sh" || true; echo "$CRON_START"; echo "$CRON_BOOT"; } | crontab -
echo "crontab:"; crontab -l | grep supervisor

scripts/ops/supervisor.sh restart
sleep 3
scripts/ops/supervisor.sh status
