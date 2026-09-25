#!/usr/bin/env bash
# worker-deploy.sh — instala/atualiza o agente num worker, a partir do mestre, por SSH (chave dedicada).
#
# Variáveis (o runner passa pelo ambiente; o token nunca aparece na linha de comando):
#   W_HOST W_USER W_PORT W_KEY W_KNOWN_HOSTS W_MACHINE_ID W_MAX_DEVICES W_TOKEN W_COMMIT
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
: "${W_HOST:?}" "${W_USER:?}" "${W_PORT:=22}" "${W_KEY:?}" "${W_KNOWN_HOSTS:?}" "${W_MACHINE_ID:?}" "${W_TOKEN:?}"
W_MAX_DEVICES="${W_MAX_DEVICES:-6}"
W_COMMIT="${W_COMMIT:-$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo dev)}"
SSH=(ssh -i "$W_KEY" -p "$W_PORT" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$W_KNOWN_HOSTS")
DEST="$W_USER@$W_HOST"

[ -f "$REPO/dist/agent.mjs" ] || { echo "Falta dist/agent.mjs (rode o build)" >&2; exit 1; }
echo "==> preparando ~/qa-farm-agent em $DEST"
"${SSH[@]}" "$DEST" 'mkdir -p ~/qa-farm-agent/dist ~/qa-farm-agent/scripts/farm ~/qa-farm-agent/scripts/ops ~/qa-farm-agent/data'

echo "==> enviando agente e scripts"
RSYNC_SSH="ssh -i $W_KEY -p $W_PORT -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$W_KNOWN_HOSTS"
rsync -a -e "$RSYNC_SSH" "$REPO/dist/agent.mjs" "$DEST:qa-farm-agent/dist/"
rsync -a -e "$RSYNC_SSH" "$REPO/scripts/farm/" "$DEST:qa-farm-agent/scripts/farm/"
rsync -a -e "$RSYNC_SSH" "$REPO/scripts/ops/agent-supervisor.sh" "$DEST:qa-farm-agent/scripts/ops/"

echo "==> gravando configuração (.env, chmod 600)"
"${SSH[@]}" "$DEST" 'umask 077; cat > ~/qa-farm-agent/.env' <<ENV
QAFARM_AGENT_TOKEN=$W_TOKEN
QAFARM_AGENT_PORT=7100
QAFARM_AGENT_COMMIT=$W_COMMIT
QAFARM_MACHINE_ID=$W_MACHINE_ID
QAFARM_MAX_DEVICES=$W_MAX_DEVICES
QAFARM_DATA_DIR=\$HOME/qa-farm-agent/data
QAFARM_FARM_HOME=\$HOME/android-farm
ANDROID_SDK_ROOT=\$HOME/android-sdk
JAVA_HOME=\$HOME/jdk
QAFARM_APPIUM_BIN=\$HOME/node/bin/appium
QAFARM_APPIUM_BASE_PORT=4800
QAFARM_DEVICES_PER_APPIUM=5
QAFARM_INSTALL_CONCURRENCY=5
ENV

echo "==> crontab (a cada minuto + no boot) e reinício do agente"
"${SSH[@]}" "$DEST" 'chmod +x ~/qa-farm-agent/scripts/ops/*.sh ~/qa-farm-agent/scripts/farm/*.sh
  L="~/qa-farm-agent/scripts/ops/agent-supervisor.sh start >/dev/null 2>&1"
  ( crontab -l 2>/dev/null | grep -v "agent-supervisor.sh" ; echo "* * * * * $L"; echo "@reboot $L" ) | crontab -
  ~/qa-farm-agent/scripts/ops/agent-supervisor.sh restart
  sleep 2
  ~/qa-farm-agent/scripts/ops/agent-supervisor.sh status'
echo "OK: agente $W_COMMIT instalado em $W_MACHINE_ID ($DEST)"
