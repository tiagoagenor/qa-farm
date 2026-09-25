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

## T6 — Multi-máquina e saúde das máquinas (25/09/2026)

Mestre: server01 (12 emuladores). Worker: server02 (Xeon E5-2682 v4, 32 threads, 31 GB), cadastrado pela página
Máquinas, agente instalado pelo painel (túnel SSH aberto pelo mestre; agente só em 127.0.0.1:7100).

| Teste | Resultado |
|---|---|
| Saúde do mestre vs sistema | memória = `free -m` (8.461 × 8.477 MB); temperatura = `sensors` (38 °C; núcleos 30–34 °C) |
| Swap cheio de páginas antigas (sem troca ativa) | só aviso — o freio não segura casos (ajuste após falso alarme) |
| Cadastro + "Testar conexão" sem agente | "SSH ok · agente sem resposta" |
| "Instalar agente" | online pelo túnel, mesmo commit do mestre, métricas ao vivo |
| Ligar 1 e depois 5 emuladores no worker | 1: ~70 s de boot + APK pelo túnel; 5: prontos em ~3 min (instalação em paralelo) |
| Fila na pasta de login (11 casos, mesma conta liberada) | casos alternados entre as duas máquinas; artefatos completos no mestre (output.xml, log.html, console, massa, prints) |
| Caso de login válido forçado no worker | passou (211 s; no mestre 156–186 s) |
| Agente do worker morto com caso rodando | offline em ~14 s → erro de infra → caso volta à fila e passa no mestre; emuladores do worker não foram reiniciados |
| Cron religa o agente | worker volta online sozinho, 5 emuladores intactos |
| `agent-supervisor.sh stop` (após correção) | agente para de verdade; mestre vê offline; volta com o cron |
| Worker com 6 emuladores | 6,7 GB livres, 39 °C, saúde ok, 0 OOM → pool: 18 emuladores + físico |

Problemas encontrados e corrigidos na integração real:
1. `~/.appium` copiado do mestre tinha caminhos absolutos do outro usuário (registro do driver e link
   `node_modules/appium`): sessões no worker falhavam em 1 s. O `worker-deploy.sh` agora ajusta isso sozinho.
2. Agente "parado" seguia respondendo nas conexões keep-alive do mestre e o `stop` do supervisor deixava o node vivo.
3. (testes simulados) worker fora do ar travava o fim do caso no mestre (limpeza do Appium sem tratamento de erro).
