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
"${SSH[@]}" "$DEST" 'mkdir -p ~/qa-farm-agent/dist ~/qa-farm-agent/scripts/farm ~/qa-farm-agent/scripts/ops ~/qa-farm-agent/scripts/robot ~/qa-farm-agent/data'

echo "==> enviando agente e scripts"
RSYNC_SSH="ssh -i $W_KEY -p $W_PORT -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$W_KNOWN_HOSTS"
rsync -a -e "$RSYNC_SSH" "$REPO/dist/agent.mjs" "$DEST:qa-farm-agent/dist/"
rsync -a -e "$RSYNC_SSH" "$REPO/scripts/farm/" "$DEST:qa-farm-agent/scripts/farm/"
rsync -a -e "$RSYNC_SSH" "$REPO/scripts/ops/agent-supervisor.sh" "$DEST:qa-farm-agent/scripts/ops/"
# listeners do robot (o robot dos casos pode rodar no worker) — o fake_robot vai junto para o modo simulado
rsync -a --delete --exclude tests --exclude __pycache__ -e "$RSYNC_SSH" "$REPO/scripts/robot/" "$DEST:qa-farm-agent/scripts/robot/"

echo "==> robot no worker (venv com os mesmos pacotes do mestre, instalado offline — sem sudo)"
ROBOT_PROJECT="${QAFARM_ROBOT_PROJECT:-$HOME/www/QA_Automacao_APP}"
if "${SSH[@]}" "$DEST" 'test -x ~/qa-farm-agent/robot-venv/bin/robot'; then
  echo "    já instalado"
elif [ -x "$ROBOT_PROJECT/.venv/bin/pip" ]; then
  WHEELS="$(mktemp -d)"
  "$ROBOT_PROJECT/.venv/bin/pip" freeze > "$WHEELS/freeze.txt"
  "$ROBOT_PROJECT/.venv/bin/pip" download -q -r "$WHEELS/freeze.txt" pip -d "$WHEELS"
  rsync -a --delete -e "$RSYNC_SSH" "$WHEELS/" "$DEST:qa-farm-agent/robot-wheels/"
  rm -rf "$WHEELS"
  "${SSH[@]}" "$DEST" 'set -e; cd ~/qa-farm-agent; rm -rf robot-venv; python3 -m venv --without-pip robot-venv
    robot-venv/bin/python "$(ls robot-wheels/pip-*.whl | head -1)/pip" install -q --no-index --find-links robot-wheels pip
    robot-venv/bin/pip install -q --no-index --find-links robot-wheels -r robot-wheels/freeze.txt
    robot-venv/bin/robot --version || true'
else
  echo "    atenção: venv do projeto não encontrado em $ROBOT_PROJECT/.venv — o robot dos casos segue no mestre"
fi

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
QAFARM_ROBOT_BIN=\$HOME/qa-farm-agent/robot-venv/bin/robot
ENV

echo "==> ajustando o Appium copiado do mestre (caminhos absolutos /home/<outro usuário>)"
"${SSH[@]}" "$DEST" 'f=~/.appium/node_modules/.cache/appium/extensions.yaml
  [ -f "$f" ] && sed -i -E "s#/home/[^/]+/\.appium/#$HOME/.appium/#g" "$f"
  for l in $(find ~/.appium -path "*/node_modules/appium" -type l 2>/dev/null); do ln -sfn "$HOME/node/lib/node_modules/appium" "$l"; done
  n=$(find ~/.appium ~/node -xtype l 2>/dev/null | wc -l); [ "$n" = 0 ] || echo "atenção: $n link(s) quebrado(s) em ~/.appium ou ~/node"'

echo "==> crontab (a cada minuto + no boot) e reinício do agente"
"${SSH[@]}" "$DEST" 'chmod +x ~/qa-farm-agent/scripts/ops/*.sh ~/qa-farm-agent/scripts/farm/*.sh
  L="~/qa-farm-agent/scripts/ops/agent-supervisor.sh start >/dev/null 2>&1"
  ( crontab -l 2>/dev/null | grep -v "agent-supervisor.sh" ; echo "* * * * * $L"; echo "@reboot $L" ) | crontab -
  ~/qa-farm-agent/scripts/ops/agent-supervisor.sh restart
  sleep 2
  ~/qa-farm-agent/scripts/ops/agent-supervisor.sh status'
echo "OK: agente $W_COMMIT instalado em $W_MACHINE_ID ($DEST)"
