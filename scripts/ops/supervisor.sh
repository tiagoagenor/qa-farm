#!/usr/bin/env bash
# supervisor.sh — mantém o painel (web) e o runner do QA Farm vivos. Sem sudo: roda pelo crontab do usuário.
#
#   scripts/ops/supervisor.sh start     # sobe o que estiver parado (é o que o cron chama a cada minuto)
#   scripts/ops/supervisor.sh stop      # para web e runner (os celulares continuam ligados)
#   scripts/ops/supervisor.sh restart
#   scripts/ops/supervisor.sh status
set -uo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO" || exit 1
[ -f .env ] || { echo "Falta $REPO/.env (rode scripts/ops/install.sh)" >&2; exit 1; }
set -a
# shellcheck disable=SC1091
. ./.env
set +a

export PATH="$HOME/node/bin:$HOME/android-sdk/platform-tools:$HOME/jdk/bin:/usr/local/bin:/usr/bin:/bin"
export ANDROID_HOME="${ANDROID_SDK_ROOT:-$HOME/android-sdk}" ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/android-sdk}"
export JAVA_HOME="${JAVA_HOME:-$HOME/jdk}" QAFARM_REPO_ROOT="$REPO" NODE_ENV=production

DATA="${QAFARM_DATA_DIR:-$HOME/qa-farm-data}"
LOGS="$DATA/logs"
RUN="$DATA/run"
PORT="${PORT:-3000}"
mkdir -p "$LOGS" "$RUN" "$DATA/state"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { echo "[$(ts)] $*" >> "$LOGS/supervisor.log"; }

alive() { # $1 = pidfile, $2 = trecho esperado no comando
  local pid; pid=$(cat "$1" 2>/dev/null) || return 1
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -Eq -- "$2"
}

rotate_logs() { # mantém cada log com no máximo ~50 MB (preserva os últimos 10 MB)
  local f
  for f in "$LOGS"/*.log; do
    [ -f "$f" ] || continue
    if [ "$(stat -c %s "$f" 2>/dev/null || echo 0)" -gt 52428800 ]; then
      tail -c 10485760 "$f" > "$f.tmp" && cat "$f.tmp" > "$f" && rm -f "$f.tmp"
    fi
  done
}

start_web() {
  alive "$RUN/web.pid" "next-server|next start" && return 0
  log "subindo web na porta $PORT"
  setsid nohup "$REPO/node_modules/.bin/next" start -H 0.0.0.0 -p "$PORT" >> "$LOGS/web.log" 2>&1 < /dev/null &
  echo $! > "$RUN/web.pid"
}

runner_heartbeat_age() { # segundos desde o último heartbeat (999999 se não houver)
  local hb; hb=$(grep -o '"heartbeatAt": *"[^"]*"' "$DATA/state/runner.json" 2>/dev/null | sed 's/.*"\([^"]*\)"$/\1/')
  [ -n "$hb" ] || { echo 999999; return; }
  echo $(( $(date -u +%s) - $(date -u -d "$hb" +%s 2>/dev/null || echo 0) ))
}

start_runner() {
  if alive "$RUN/runner.pid" "runner.mjs"; then
    # vivo mas travado (sem heartbeat há 2 min) → reinicia
    if [ "$(runner_heartbeat_age)" -gt 120 ]; then
      log "runner sem heartbeat há $(runner_heartbeat_age)s — reiniciando"
      kill "$(cat "$RUN/runner.pid")" 2>/dev/null; sleep 3; kill -9 "$(cat "$RUN/runner.pid")" 2>/dev/null
    else
      return 0
    fi
  fi
  log "subindo runner"
  setsid nohup flock -n "$DATA/state/runner.flock" node "$REPO/dist/runner.mjs" >> "$LOGS/runner.log" 2>&1 < /dev/null &
  echo $! > "$RUN/runner.pid"
}

stop_one() { # $1 = pidfile
  local pid; pid=$(cat "$1" 2>/dev/null) || return 0
  [ -n "$pid" ] || return 0
  kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
  rm -f "$1"
}

status() {
  alive "$RUN/web.pid" "next-server|next start" && echo "web:    rodando (pid $(cat "$RUN/web.pid"), porta $PORT)" || echo "web:    parado"
  alive "$RUN/runner.pid" "runner.mjs" && echo "runner: rodando (pid $(cat "$RUN/runner.pid"), heartbeat há $(runner_heartbeat_age)s)" || echo "runner: parado"
}

case "${1:-start}" in
  start) rotate_logs; start_web; start_runner ;;
  stop) stop_one "$RUN/runner.pid"; stop_one "$RUN/web.pid"; log "parado" ;;
  restart) stop_one "$RUN/runner.pid"; stop_one "$RUN/web.pid"; start_web; start_runner; log "reiniciado" ;;
  status) status ;;
  *) echo "Uso: $0 start|stop|restart|status" >&2; exit 1 ;;
esac
