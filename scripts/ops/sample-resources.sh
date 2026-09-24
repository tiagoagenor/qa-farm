#!/usr/bin/env bash
# sample-resources.sh — amostra memória, OOM e carga a cada 5 s e grava CSV (evidência do teste de capacidade).
# Uso: scripts/ops/sample-resources.sh <segundos> <arquivo.csv>
set -uo pipefail
DUR="${1:-900}"; OUT="${2:-resources.csv}"
echo "ts,mem_available_mb,oom_kill,load1,qemu,robot" > "$OUT"
oom0=$(awk '/^oom_kill /{print $2}' /proc/vmstat)
end=$(( $(date +%s) + DUR ))
while [ "$(date +%s)" -lt "$end" ]; do
  mem=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
  oom=$(( $(awk '/^oom_kill /{print $2}' /proc/vmstat) - oom0 ))
  load=$(cut -d' ' -f1 /proc/loadavg)
  q=$(pgrep -c qemu-system || true); r=$(pgrep -fc 'robot.*qafarm_listener' || true)
  echo "$(date -u +%H:%M:%S),$mem,$oom,$load,$q,$r" >> "$OUT"
  sleep 5
done
awk -F, 'NR>1{ if(min==""||$2<min)min=$2; if($3>oom)oom=$3; n++; l[n]=$4 } END{ asort(l); p=l[int(n*0.95)]; printf "amostras=%d mem_min_mb=%d oom_kill=%d load1_p95=%s\n", n, min, oom, p }' "$OUT"
