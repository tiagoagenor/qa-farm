# Aceitação no server01

Executada em 24/09/2026 com tudo real: 15 emuladores Android 13 (2 GB cada), Appium, Robot Framework e o painel.
O script está em `scripts/ops/acceptance.ts` e grava as evidências em `~/qa-farm-data/aceite/` no servidor
(o relatório detalhado fica fora do repositório, pois cita nomes internos dos casos e do app).

| Grupo | Itens | Resultado |
|---|---|---|
| T1 Acesso, apps e catálogo | login/401, upload do APK real (235 MB em 1,4 s), recusa de não-APK e duplicado, catálogo com todos os casos | ✅ 4/4 |
| T2 Celulares | 15 emuladores prontos com o APK em 195 s, físico listado como externo, print, reiniciar 1, desligar todos | ✅ 5/5 |
| T3 Fila em paralelo | canário ✅, falha com mensagem exata, timeout, pausar/continuar/cancelar, re-rodar falhas, 30 casos com pico 15 e `session.json` 30/30, 100 casos com pico 15 e nenhum celular com 2 casos, logs após reinício | ✅ 9/9 |
| T4 Resiliência | emulador morto no meio do caso (refaz em outro e o celular volta em 60 s), runner morto (volta em 63 s, sem órfãos), web morta (volta em 55 s), nada sobra ao fim | ✅ 4/4 |
| T5 Capacidade | T5.2 painel p95 21 ms com fila rodando ✅ · T5.1 0 OOM, memória livre mínima 5,4 / 4,9 GB (critério 5 GB) ⚠️ | 1/2 |
| T6 Qualidade | lint + AAA, typecheck, Vitest, pytest, Playwright, CI verde, projeto Robot intocado, sem banco, shadcn | ✅ 7/7 |

Seis problemas só apareceram rodando de verdade e foram corrigidos durante a aceitação (ver histórico de commits):
diálogo de ANR do Android, emuladores derrubados ao reiniciar o runner, memória dos Appiums, subida duplicada de
Appium, resultado perdido em corrida entre casos e lock da fazenda herdado pelos emuladores.
