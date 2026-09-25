#!/usr/bin/env bash
# agent-supervisor.sh — mantém o agente do worker vivo (pelo crontab do usuário, sem sudo).
#
#   ~/qa-farm-agent/scripts/ops/agent-supervisor.sh start|stop|restart|status
#
# Parar o agente NÃO derruba Appium nem emuladores (só o processo do agente): reiniciar/atualizar no meio de
# uma fila não interrompe casos.
set -uo pipefail

HOME_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$HOME_DIR" || exit 1
[ -f .env ] || { echo "Falta $HOME_DIR/.env (rode o worker-deploy.sh no mestre)" >&2; exit 1; }
set -a
# shellcheck disable=SC1091
. ./.env
set +a
export PATH="$HOME/node/bin:$HOME/android-sdk/platform-tools:$HOME/jdk/bin:/usr/local/bin:/usr/bin:/bin"
export ANDROID_HOME="${ANDROID_SDK_ROOT:-$HOME/android-sdk}" ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/android-sdk}"
export JAVA_HOME="${JAVA_HOME:-$HOME/jdk}" QAFARM_REPO_ROOT="$HOME_DIR"
[ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$(id -u)" ] && export XDG_RUNTIME_DIR="/run/user/$(id -u)"

DATA="${QAFARM_DATA_DIR:-$HOME_DIR/data}"
mkdir -p "$DATA/logs" "$DATA/run"
PIDF="$DATA/run/agent.pid"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] $*" >> "$DATA/logs/agent-supervisor.log"; }

alive() {
  local pid; pid=$(cat "$PIDF" 2>/dev/null) || return 1
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q "agent.mjs"
}

start() {
  alive && return 0
  log "subindo agente (porta ${QAFARM_AGENT_PORT:-7100})"
  setsid nohup flock -n "$DATA/run/agent.flock" node "$HOME_DIR/dist/agent.mjs" >> "$DATA/logs/agent.log" 2>&1 < /dev/null &
  echo $! > "$PIDF"
}

stop() {
  local pid; pid=$(cat "$PIDF" 2>/dev/null) || return 0
  [ -n "$pid" ] || return 0
  # flock → node: pega o pid do node ANTES (morto o flock, o node é adotado pelo init e escaparia do pkill -P);
  # não mexe no grupo — Appium e emuladores seguem
  local pids="$pid $(pgrep -P "$pid" 2>/dev/null | tr '\n' ' ')"
  kill -TERM $pids 2>/dev/null
  for _ in $(seq 1 20); do kill -0 $pids 2>/dev/null || break; sleep 0.5; done
  kill -KILL $pids 2>/dev/null
  rm -f "$PIDF"
  log "agente parado"
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) stop; sleep 1; start ;;
  status) if alive; then echo "agente: rodando (pid $(cat "$PIDF"), porta ${QAFARM_AGENT_PORT:-7100})"; else echo "agente: parado"; fi ;;
  *) echo "uso: $0 start|stop|restart|status" >&2; exit 1 ;;
esac
