#!/usr/bin/env bash
# android-farm.sh — gerencia uma "fazenda" de celulares Android (emulador com KVM)
# para testes em massa via ADB.
#
# Uso rápido:
#   ./android-farm.sh setup                 # instala emulador + imagem Android (1a vez)
#   ./android-farm.sh start -n 10           # sobe 10 celulares (2 GB cada)
#   ./android-farm.sh status                # lista celulares e estado no adb
#   ./android-farm.sh stop                  # desliga todos
#   ./android-farm.sh restart -n 10         # reinicia
#   ./android-farm.sh delete                # apaga todos os AVDs
#
# Rode "./android-farm.sh help" para todas as opções.

set -uo pipefail

# ---------------------------------------------------------------- padrões ---
FARM_HOME="${FARM_HOME:-$HOME/android-farm}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/android-sdk}"
export ANDROID_HOME="$ANDROID_SDK_ROOT"
export ANDROID_AVD_HOME="${ANDROID_AVD_HOME:-$FARM_HOME/avd}"
# Java local (~/jdk) se não houver java no sistema
if ! command -v java >/dev/null && [ -x "$HOME/jdk/bin/java" ]; then
  export JAVA_HOME="$HOME/jdk"; export PATH="$JAVA_HOME/bin:$PATH"
fi

[ "$(id -u)" = 0 ] && { echo "Não rode com sudo — rode como usuário normal." >&2; exit 1; }

API="${API:-33}"                    # nível de API Android (33 = Android 13; 34 força RAM mínima de 2560 MB)
VARIANT="${VARIANT:-google_apis}"   # google_apis | default | google_apis_playstore
RAM_MB="${RAM_MB:-2048}"            # memória por celular
OVERHEAD_MB="${OVERHEAD_MB:-1200}"  # RAM extra que o processo do emulador usa no host
SWAP_MB="${SWAP_MB:-0}"             # swap em disco dentro de cada celular (/data/swapfile); 0 = sem swap (padrão)
CORES="${CORES:-2}"                 # vCPUs por celular
DATA_SIZE="${DATA_SIZE:-4G}"        # armazenamento interno
LCD_WIDTH="${LCD_WIDTH:-1080}"      # tela (padrão = Pixel 6: 1080x2400 @ 420 dpi)
LCD_HEIGHT="${LCD_HEIGHT:-2400}"    #   para voltar à tela antiga: LCD_WIDTH=720 LCD_HEIGHT=1280 LCD_DENSITY=320
LCD_DENSITY="${LCD_DENSITY:-420}"
PREFIX="${PREFIX:-farm}"            # nome dos AVDs: farm-01, farm-02 ...
BASE_PORT=5554                      # celular i usa console 5554+2(i-1), adb +1
EXPOSE_BASE="${EXPOSE_BASE:-7000}"  # porta externa (LAN) do celular i = 7000+i
BOOT_TIMEOUT="${BOOT_TIMEOUT:-420}"
STAGGER="${STAGGER:-2}"             # segundos entre o start de cada celular

COUNT=""
ONLY=""
COLD=0
WIPE=0
EXPOSE=0
GUI=0
TUNE=1

SDKM="$ANDROID_SDK_ROOT/cmdline-tools/latest/bin/sdkmanager"
AVDM="$ANDROID_SDK_ROOT/cmdline-tools/latest/bin/avdmanager"
EMU="$ANDROID_SDK_ROOT/emulator/emulator"
ADB="$ANDROID_SDK_ROOT/platform-tools/adb"
[ -x "$ADB" ] || ADB="$(command -v adb || true)"

LOG_DIR="$FARM_HOME/logs"
RUN_DIR="$FARM_HOME/run"
mkdir -p "$LOG_DIR" "$RUN_DIR" "$ANDROID_AVD_HOME"

c_ok=$'\e[32m'; c_err=$'\e[31m'; c_info=$'\e[36m'; c_off=$'\e[0m'
info() { echo "${c_info}==>${c_off} $*"; }
ok()   { echo "${c_ok}OK${c_off}  $*"; }
err()  { echo "${c_err}ERRO${c_off} $*" >&2; }
die()  { err "$*"; exit 1; }

usage() {
  cat <<EOF
Uso: $0 <comando> [opções]

Comandos:
  setup                 Baixa emulador, platform-tools e imagem Android (API $API)
  start   -n N          Cria (se preciso) e inicia N celulares
  stop    [-n N]        Desliga os celulares (todos, ou só os N primeiros)
  restart -n N          stop + start
  status                Mostra celulares rodando e estado no adb
  delete  [-n N]        Desliga e apaga os AVDs
  adb-connect           Reconecta todos os celulares rodando no adb
  help                  Esta ajuda

Opções:
  -n, --count N         Quantidade de celulares
      --only I          Só o celular I (farm-0I) — start/stop/restart
  -m, --ram MB          Memória por celular (padrão: $RAM_MB)
  -s, --swap MB         Swap em disco por celular (padrão: $SWAP_MB = sem swap)
  -c, --cores N         vCPUs por celular (padrão: $CORES)
                        Tela: LCD_WIDTH x LCD_HEIGHT @ LCD_DENSITY dpi (padrão: ${LCD_WIDTH}x${LCD_HEIGHT} @ $LCD_DENSITY)
  -a, --api N           Nível da API Android (padrão: $API)
      --variant V       google_apis | default | google_apis_playstore (padrão: $VARIANT)
      --cold            Boot a frio (ignora snapshot quickboot)
      --wipe            Apaga dados do celular antes de iniciar
      --expose          Expõe o adb de cada celular na rede: <ip-servidor>:$((EXPOSE_BASE+1)), $((EXPOSE_BASE+2)) ...
      --gui             Abre janela (precisa de display; padrão é headless)
      --no-tune         Não aplica ajustes de teste (animações off, tela sempre ligada)

Variáveis de ambiente: FARM_HOME, ANDROID_SDK_ROOT, BOOT_TIMEOUT, STAGGER, PREFIX, LCD_WIDTH, LCD_HEIGHT, LCD_DENSITY
EOF
}

# ---------------------------------------------------------------- helpers ---
image_pkg() { echo "system-images;android-$API;$VARIANT;x86_64"; }
avd_name()  { printf "%s-%02d" "$PREFIX" "$1"; }
con_port()  { echo $((BASE_PORT + 2 * ($1 - 1))); }
adb_port()  { echo $(( $(con_port "$1") + 1 )); }
serial()    { echo "emulator-$(con_port "$1")"; }

is_running() {  # $1 = índice
  local pidf="$RUN_DIR/$(avd_name "$1").pid"
  [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null
}

running_indexes() {
  local f n
  for f in "$RUN_DIR"/"$PREFIX"-*.pid; do
    [ -e "$f" ] || continue
    n="${f##*/$PREFIX-}"; n="${n%.pid}"
    [[ "$n" =~ ^[0-9]+$ ]] || continue   # ignora farm-01.socat.pid etc.
    n=$((10#$n))
    is_running "$n" && echo "$n"
  done | sort -n
}

check_prereqs() {
  [ -r /dev/kvm ] && [ -w /dev/kvm ] || die "/dev/kvm sem permissão. Rode UMA VEZ: sudo ~/android-farm-prepare.sh — depois saia e entre no SSH de novo e rode este script SEM sudo."
  [ -x "$EMU" ] || die "Emulador não instalado. Rode: $0 setup"
  [ -n "$ADB" ] || die "adb não encontrado. Rode: $0 setup"
  [ -d "$ANDROID_SDK_ROOT/$(image_pkg | tr ';' '/')" ] || die "Imagem $(image_pkg) não instalada. Rode: $0 setup -a $API --variant $VARIANT"
}

check_capacity() {
  local want_mb=$(( COUNT * (RAM_MB + OVERHEAD_MB) ))   # overhead medido: ~1,1 GB por emulador
  local avail_mb; avail_mb=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
  local already; already=$(running_indexes | wc -l)
  if (( want_mb > avail_mb + already * (RAM_MB + OVERHEAD_MB) )); then
    err "Memória insuficiente: ~${want_mb} MB necessários, ${avail_mb} MB livres."
    err "Máximo recomendado agora: $(( (avail_mb + already*(RAM_MB+OVERHEAD_MB)) / (RAM_MB + OVERHEAD_MB) )) celulares."
    exit 1
  fi
  # disco: cada celular novo ocupa ~ swap + 2 GB (dados + snapshot quickboot)
  local i new=0 need_mb free_mb
  for ((i = 1; i <= COUNT; i++)); do [ -d "$ANDROID_AVD_HOME/$(avd_name "$i").avd" ] || new=$((new + 1)); done
  need_mb=$(( new * (SWAP_MB + 2048) + 2048 ))
  free_mb=$(df -Pm "$ANDROID_AVD_HOME" | awk 'NR==2{print $4}')
  if (( need_mb > free_mb )); then
    err "Disco insuficiente: ~${need_mb} MB para $new celular(es) novo(s), ${free_mb} MB livres."
    err "Libere espaço, use --swap menor, ou aumente o disco: sudo lvextend -r -l +100%FREE /dev/ubuntu-vg/ubuntu-lv"
    exit 1
  fi
}

# ------------------------------------------------------------------ setup ---
cmd_setup() {
  [ -x "$SDKM" ] || die "sdkmanager não encontrado em $SDKM"
  command -v java >/dev/null || die "Java não encontrado. Rode: sudo apt-get install -y openjdk-21-jre-headless"
  info "Aceitando licenças..."
  yes | "$SDKM" --licenses >/dev/null 2>&1 || true
  info "Instalando emulator, platform-tools e $(image_pkg) ..."
  "$SDKM" --install "emulator" "platform-tools" "build-tools;37.0.0" "$(image_pkg)" || die "Falha no sdkmanager"  # build-tools: aapt2 p/ o Appium
  ok "Setup concluído."
  grep -q 'android-sdk/platform-tools' "$HOME/.bashrc" 2>/dev/null || {
    echo 'export ANDROID_SDK_ROOT="$HOME/android-sdk"; export PATH="$ANDROID_SDK_ROOT/platform-tools:$ANDROID_SDK_ROOT/emulator:$PATH"' >> "$HOME/.bashrc"
    info "PATH do adb/emulator adicionado ao ~/.bashrc"
  }
}

# ----------------------------------------------------------------- create ---
create_avd() {  # $1 = índice
  local name; name=$(avd_name "$1")
  local cfg="$ANDROID_AVD_HOME/$name.avd/config.ini"
  if [ ! -f "$cfg" ]; then
    echo "no" | "$AVDM" create avd -n "$name" -k "$(image_pkg)" -d pixel_6 --force >/dev/null 2>&1 \
      || die "Falha ao criar AVD $name"
  fi
  # tela mudou → o snapshot de boot rápido não serve mais (boot a frio uma vez)
  local cur; cur=$(grep -E "^hw.lcd.(width|height|density) *=" "$cfg" | sed 's/ //g' | sort | tr '\n' ' ')
  if [ -n "$cur" ] && [ "$cur" != "hw.lcd.density=$LCD_DENSITY hw.lcd.height=$LCD_HEIGHT hw.lcd.width=$LCD_WIDTH " ]; then
    rm -rf "$ANDROID_AVD_HOME/$name.avd/snapshots/default_boot"
  fi
  # garante as configurações (inclusive se mudar -m/-c depois)
  local k v
  while IFS='=' read -r k v; do
    if grep -q "^$k *=" "$cfg"; then sed -i "s|^$k *=.*|$k=$v|" "$cfg"; else echo "$k=$v" >> "$cfg"; fi
  done <<EOF
hw.ramSize=$RAM_MB
hw.cpu.ncore=$CORES
disk.dataPartition.size=$DATA_SIZE
vm.heapSize=256
hw.gpu.enabled=yes
hw.gpu.mode=swiftshader_indirect
hw.audioInput=no
hw.audioOutput=no
hw.camera.back=none
hw.camera.front=none
hw.keyboard=yes
hw.lcd.width=$LCD_WIDTH
hw.lcd.height=$LCD_HEIGHT
hw.lcd.density=$LCD_DENSITY
fastboot.forceColdBoot=no
EOF
}

# ------------------------------------------------------------------ start ---
launch_one() {  # $1 = índice
  local i=$1 name port log
  name=$(avd_name "$i"); port=$(con_port "$i"); log="$LOG_DIR/$name.log"
  if is_running "$i"; then info "$name já está rodando ($(serial "$i"))"; return 0; fi

  local args=(-avd "$name" -port "$port" -memory "$RAM_MB" -cores "$CORES"
              -no-audio -no-boot-anim -gpu swiftshader_indirect -accel on
              -netdelay none -netspeed full)
  (( GUI )) || args+=(-no-window)
  (( COLD )) && args+=(-no-snapshot-load)
  (( WIPE )) && args+=(-wipe-data)

  # setsid: o emulador ganha sessão própria — sobrevive ao fim de quem o iniciou (terminal, runner, deploy)
  setsid nohup "$EMU" "${args[@]}" >"$log" 2>&1 < /dev/null &
  echo $! > "$RUN_DIR/$name.pid"
  info "$name iniciando -> $(serial "$i") (adb 127.0.0.1:$(adb_port "$i"), log $log)"
}

ensure_adb() {  # garante que o celular aparece no adb
  local i=$1 s; s=$(serial "$i")
  "$ADB" devices | grep -q "^$s" && return 0
  "$ADB" connect "127.0.0.1:$(adb_port "$i")" >/dev/null 2>&1
}

wait_boot() {  # $1 = índice
  local i=$1 s t=0 name; s=$(serial "$i"); name=$(avd_name "$i")
  local target="$s"
  while (( t < BOOT_TIMEOUT )); do
    is_running "$i" || { err "$name morreu no boot. Veja $LOG_DIR/$name.log"; return 1; }
    ensure_adb "$i"
    "$ADB" devices | grep -q "^$s[[:space:]]" || target="127.0.0.1:$(adb_port "$i")"
    if [ "$("$ADB" -s "$target" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then
      echo "$target" > "$RUN_DIR/$name.serial"
      return 0
    fi
    sleep 3; t=$((t + 3))
  done
  err "$name não terminou o boot em ${BOOT_TIMEOUT}s"; return 1
}

tune_device() {  # ajustes para testes automatizados
  local s=$1
  "$ADB" -s "$s" shell 'settings put global window_animation_scale 0;
    settings put global transition_animation_scale 0;
    settings put global animator_duration_scale 0;
    settings put global stay_on_while_plugged_in 7;
    settings put system screen_off_timeout 2147483647;
    settings put secure show_ime_with_hard_keyboard 0;
    settings put global package_verifier_enable 0;
    settings put global hide_error_dialogs 1;
    input keyevent 82' >/dev/null 2>&1
}

adb_as_root() {  # adb root + espera o adbd voltar (necessário para swapon)
  local s=$1 t=0
  [ "$("$ADB" -s "$s" shell id -u 2>/dev/null | tr -d '\r')" = 0 ] && return 0
  "$ADB" -s "$s" root >/dev/null 2>&1
  while (( t < 40 )); do
    sleep 2; t=$((t + 2))
    [[ "$s" == *:* ]] && "$ADB" connect "$s" >/dev/null 2>&1
    [ "$("$ADB" -s "$s" shell id -u 2>/dev/null | tr -d '\r')" = 0 ] && return 0
  done
  return 1
}

setup_swap() {  # cria/ativa /data/swapfile de SWAP_MB (persistente no disco do celular)
  local s=$1 name=$2 out
  adb_as_root "$s" || { err "$name: sem root no adb (imagem playstore?) — swap não configurado"; return 1; }
  out=$("$ADB" -s "$s" shell "
    F=/data/swapfile; MB=$SWAP_MB; B=\$((MB * 1048576))
    cur=\$(stat -c %s \$F 2>/dev/null || echo 0)
    if grep -q \"^\$F \" /proc/swaps; then
      [ \$cur = \$B ] && { echo OK; exit 0; }
      swapoff \$F
    fi
    if [ \$MB = 0 ]; then rm -f \$F; echo OFF; exit 0; fi
    if [ \$cur != \$B ]; then
      rm -f \$F
      fallocate -l \$B \$F 2>/dev/null || dd if=/dev/zero of=\$F bs=1048576 count=\$MB 2>/dev/null || { echo SEM_ESPACO; exit 1; }
      chmod 600 \$F; mkswap \$F >/dev/null || { echo MKSWAP_FALHOU; exit 1; }
    fi
    swapon \$F && echo OK || echo SWAPON_FALHOU" 2>&1 | tr -d '\r' | tail -1)
  case "$out" in
    OK|OFF) return 0 ;;
    *) err "$name: swap falhou ($out)"; return 1 ;;
  esac
}

expose_one() {  # socat LAN:7000+i -> 127.0.0.1:adb_port
  local i=$1 ext=$((EXPOSE_BASE + i)) name; name=$(avd_name "$i")
  command -v socat >/dev/null || { err "socat não instalado (sudo apt-get install -y socat)"; return 1; }
  local pidf="$RUN_DIR/$name.socat.pid"
  [ -f "$pidf" ] && kill -0 "$(cat "$pidf")" 2>/dev/null && return 0
  nohup socat "TCP-LISTEN:$ext,fork,reuseaddr" "TCP:127.0.0.1:$(adb_port "$i")" >/dev/null 2>&1 &
  echo $! > "$pidf"
}

target_indexes() {  # --only I → só I; senão 1..COUNT
  if [ -n "$ONLY" ]; then echo "$ONLY"; else seq 1 "$COUNT"; fi
}

cmd_start() {
  [ -n "$COUNT" ] || [ -n "$ONLY" ] || die "Informe a quantidade: $0 start -n N (ou --only I)"
  check_prereqs
  if [ -n "$ONLY" ]; then COUNT=1 check_capacity; else check_capacity; fi
  "$ADB" start-server >/dev/null 2>&1

  info "Criando/atualizando AVD(s) $(target_indexes | tr '\n' ' ')(RAM ${RAM_MB} MB, ${CORES} vCPU, API $API)..."
  local i
  for i in $(target_indexes); do create_avd "$i"; done

  for i in $(target_indexes); do
    local was_running=0; is_running "$i" && was_running=1
    launch_one "$i"
    (( was_running )) || sleep "$STAGGER"
  done

  info "Aguardando boot (timeout ${BOOT_TIMEOUT}s)..."
  local pids=() okc=0 fail=0
  for i in $(target_indexes); do
    ( name=$(avd_name "$i")
      wait_boot "$i" || exit 1
      s=$(cat "$RUN_DIR/$name.serial")
      (( TUNE )) && tune_device "$s"
      (( SWAP_MB > 0 )) && setup_swap "$s" "$name"
      ok "$name pronto" ) &
    pids+=($!)
  done
  for p in "${pids[@]}"; do if wait "$p"; then okc=$((okc+1)); else fail=$((fail+1)); fi; done

  if (( EXPOSE )); then
    for i in $(target_indexes); do is_running "$i" && expose_one "$i"; done
  fi

  echo
  ok "$okc celular(es) prontos, $fail falha(s)."
  cmd_status
}

# ------------------------------------------------------------------- stop ---
stop_one() {
  local i=$1 name pidf pid t=0; name=$(avd_name "$i"); pidf="$RUN_DIR/$name.pid"
  [ -f "$RUN_DIR/$name.socat.pid" ] && { kill "$(cat "$RUN_DIR/$name.socat.pid")" 2>/dev/null; rm -f "$RUN_DIR/$name.socat.pid"; }
  if is_running "$i"; then
    pid=$(cat "$pidf")
    "$ADB" -s "$(serial "$i")" emu kill >/dev/null 2>&1 || kill "$pid" 2>/dev/null
    while kill -0 "$pid" 2>/dev/null && (( t < 30 )); do sleep 1; t=$((t+1)); done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
    "$ADB" disconnect "127.0.0.1:$(adb_port "$i")" >/dev/null 2>&1
    ok "$name desligado"
  fi
  rm -f "$pidf" "$RUN_DIR/$name.serial"
}

cmd_stop() {
  local list
  if [ -n "$ONLY" ]; then list="$ONLY"
  elif [ -n "$COUNT" ]; then list=$(seq 1 "$COUNT"); else list=$(running_indexes); fi
  [ -n "$list" ] || { info "Nenhum celular rodando."; return 0; }
  local i pids=()
  for i in $list; do stop_one "$i" & pids+=($!); done
  wait "${pids[@]}" 2>/dev/null
}

cmd_delete() {
  cmd_stop
  local d name
  for d in "$ANDROID_AVD_HOME"/"$PREFIX"-*.avd; do
    [ -e "$d" ] || continue
    name=$(basename "$d" .avd)
    if [ -n "$COUNT" ] && (( 10#${name##*-} > COUNT )); then continue; fi
    "$AVDM" delete avd -n "$name" >/dev/null 2>&1 || rm -rf "$d" "$ANDROID_AVD_HOME/$name.ini"
    ok "$name apagado"
  done
}

# ----------------------------------------------------------------- status ---
cmd_status() {
  local ip; ip=$(hostname -I | awk '{print $1}')
  printf "%-10s %-16s %-17s %-9s %-9s %-15s %s\n" "NOME" "SERIAL" "ADB LOCAL" "BOOT" "RAM" "SWAP (em uso)" "REDE (--expose)"
  local i name s boot ram swap ext any=0
  for i in $(running_indexes); do
    any=1; name=$(avd_name "$i")
    s=$(cat "$RUN_DIR/$name.serial" 2>/dev/null || serial "$i")
    boot=$("$ADB" -s "$s" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
    [ "$boot" = "1" ] && boot="pronto" || boot="bootando"
    ram=$("$ADB" -s "$s" shell "awk '/MemTotal/{print int(\$2/1024)\"MB\"}' /proc/meminfo" 2>/dev/null | tr -d '\r')
    swap=$("$ADB" -s "$s" shell "awk '\$1==\"/data/swapfile\"{print int(\$3/1024)\"MB (\"int(\$4/1024)\")\"}' /proc/swaps" 2>/dev/null | tr -d '\r')
    ext="-"; [ -f "$RUN_DIR/$name.socat.pid" ] && kill -0 "$(cat "$RUN_DIR/$name.socat.pid")" 2>/dev/null && ext="$ip:$((EXPOSE_BASE + i))"
    printf "%-10s %-16s %-17s %-9s %-9s %-15s %s\n" "$name" "$s" "127.0.0.1:$(adb_port "$i")" "$boot" "${ram:--}" "${swap:--}" "$ext"
  done
  (( any )) || echo "(nenhum celular rodando)"
  echo; "$ADB" devices
}

cmd_adb_connect() {
  local i
  for i in $(running_indexes); do ensure_adb "$i"; done
  "$ADB" devices
}

# ------------------------------------------------------------------- main ---
# Sessão aberta antes do "usermod -aG kvm": reexecuta já com o grupo kvm
if ! { [ -r /dev/kvm ] && [ -w /dev/kvm ]; } && [ -z "${FARM_SG:-}" ] \
   && id -nG "$USER" | tr ' ' '\n' | grep -qx kvm && ! id -nG | tr ' ' '\n' | grep -qx kvm; then
  export FARM_SG=1
  exec sg kvm -c "$(printf '%q ' "$0" "$@")"
fi

CMD="${1:-help}"; shift || true
while [ $# -gt 0 ]; do
  case "$1" in
    -n|--count)   COUNT="$2"; shift 2 ;;
    --only)       ONLY="$2"; shift 2 ;;
    -m|--ram)     RAM_MB="$2"; shift 2 ;;
    -c|--cores)   CORES="$2"; shift 2 ;;
    -s|--swap)    SWAP_MB="$2"; shift 2 ;;
    -a|--api)     API="$2"; shift 2 ;;
    --variant)    VARIANT="$2"; shift 2 ;;
    --cold)       COLD=1; shift ;;
    --wipe)       WIPE=1; shift ;;
    --expose)     EXPOSE=1; shift ;;
    --gui)        GUI=1; shift ;;
    --no-tune)    TUNE=0; shift ;;
    -h|--help)    usage; exit 0 ;;
    *) die "Opção desconhecida: $1 (veja $0 help)" ;;
  esac
done
if [ -n "$COUNT" ] && ! [[ "$COUNT" =~ ^[0-9]+$ && "$COUNT" -ge 1 ]]; then die "-n precisa ser um número >= 1"; fi
if [ -n "$ONLY" ] && ! [[ "$ONLY" =~ ^[0-9]+$ && "$ONLY" -ge 1 && "$ONLY" -le 18 ]]; then die "--only precisa ser um número de 1 a 18"; fi
[[ "$SWAP_MB" =~ ^[0-9]+$ ]] || die "--swap precisa ser um número em MB (0 = sem swap)"

case "$CMD" in
  setup)       cmd_setup ;;
  start)       cmd_start ;;
  stop)        cmd_stop ;;
  restart)     cmd_stop; cmd_start ;;
  status)      cmd_status ;;
  delete)      cmd_delete ;;
  adb-connect) cmd_adb_connect ;;
  help|*)      usage ;;
esac
