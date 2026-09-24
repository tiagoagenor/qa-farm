#!/usr/bin/env bash
# android-farm-down.sh — desliga os celulares da fazenda.
#
#   ./android-farm-down.sh            # desliga todos
#   ./android-farm-down.sh -n 5       # desliga só farm-01..farm-05
#   ./android-farm-down.sh --delete   # desliga todos e apaga os AVDs (dados)
#   ./android-farm-down.sh --force    # mata qualquer emulador que sobrou (kill -9)

set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
FARM="$DIR/android-farm.sh"
[ -x "$FARM" ] || { echo "android-farm.sh não encontrado em $DIR" >&2; exit 1; }

ACTION=stop; FORCE=0; ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --delete) ACTION=delete; shift ;;
    --force)  FORCE=1; shift ;;
    -n|--count) ARGS+=(-n "$2"); shift 2 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "Opção desconhecida: $1" >&2; exit 1 ;;
  esac
done

"$FARM" "$ACTION" "${ARGS[@]}"

if (( FORCE )); then
  pkill -9 -u "$USER" -f 'qemu-system-x86_64.*-avd' 2>/dev/null
  pkill -9 -u "$USER" -f 'emulator.*-avd' 2>/dev/null
  pkill -u "$USER" -f 'socat TCP-LISTEN:7[0-9]{3}' 2>/dev/null
  rm -f "${FARM_HOME:-$HOME/android-farm}"/run/*.pid "${FARM_HOME:-$HOME/android-farm}"/run/*.serial
  echo "Processos restantes removidos."
fi

left=$(pgrep -u "$USER" -fc 'qemu-system-x86_64.*-avd' || true)
echo "Emuladores ainda rodando: ${left:-0}"
