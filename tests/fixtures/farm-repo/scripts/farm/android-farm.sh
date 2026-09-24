#!/usr/bin/env bash
# Script falso da fazenda: deixa um processo filho vivo (como um emulador) e termina.
setsid nohup sleep 30 >/dev/null 2>&1 < /dev/null &
echo "ok $*"
