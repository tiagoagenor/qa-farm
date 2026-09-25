# QA Farm

Painel para rodar os testes Robot do **QA_Automacao_APP** em massa, em vários celulares Android (emuladores KVM) ao mesmo tempo.

- **Apps** — envie o APK a testar (validação automática: x86_64, versão mínima do Android, duplicados).
- **Celulares** — veja todos os aparelhos do ADB, ligue/desligue emuladores, veja a tela.
- **Testes** — os 1251 casos do projeto agrupados como no projeto (pasta → arquivo .robot → caso), com busca e filtro por tag; marque um caso, um arquivo ou uma pasta inteira.
- **Filas** — cada celular livre pega o próximo caso; resultado ✅/❌ por caso, mensagem de erro, print, `log.html`, console ao vivo e histórico.

Sem banco de dados: tudo fica em arquivos em `~/qa-farm-data`. O projeto Robot **não é alterado**.

## Como funciona

```
Navegador ─▶ Next.js (painel + API) ──comandos (JSON)──▶ Runner ─▶ Appium (1 p/ 5 celulares) ─▶ emuladores
                        ▲                                   │
                        └──────── ~/qa-farm-data ◀──────────┘  (filas, resultados, logs)
```

- **Runner** (`src/runner`): processo único que lê a fila, escolhe o celular, roda `robot` para **um caso por vez em cada celular**, aplica timeout, reexecuta erros de infraestrutura e grava os resultados.
- **Listener** (`scripts/robot/qafarm_listener.py`): passado ao `robot` com `--listener`; direciona o `Open Application` do projeto para o celular e as portas certas (`udid`, `systemPort`…) e usa o APK já instalado. Por isso não é preciso mudar o `resource.robot`.
- **Snapshot**: cada fila roda de uma cópia somente leitura do projeto (com correção automática de imports com maiúsculas trocadas, que quebram no Linux).
- **Trava por conta**: dois casos que usam a mesma conta de teste (`usuario_xxx`) nunca rodam ao mesmo tempo.

## Uso no server01

Painel: **http://192.168.100.32:3000** (senha no `/home/server01/www/qa-farm/.env`, variável `QAFARM_PASSWORD`).

```bash
/home/server01/www/qa-farm/scripts/ops/supervisor.sh status    # web e runner rodando?
/home/server01/www/qa-farm/scripts/ops/deploy.sh               # atualizar para a última versão do GitHub
tail -f ~/qa-farm-data/logs/runner.log        # o que o runner está fazendo
```

O `crontab` do usuário chama `supervisor.sh start` a cada minuto e no boot: se web ou runner caírem, voltam sozinhos. Emuladores desejados (botão **Ligar N**) também voltam após reboot.

Primeira instalação (já feita): `git clone git@github.com:tiagoagenor/qa-farm.git /home/server01/www/qa-farm && /home/server01/www/qa-farm/scripts/ops/install.sh`.

### Dados (`~/qa-farm-data`)

| Pasta | Conteúdo |
|---|---|
| `apps/<id>/` | `app.apk` + `meta.json` |
| `queues/<id>.json` | fila, casos, tentativas e resultados |
| `runs/<fila>/<caso>/a<N>/` | `log.html`, `report.html`, `output.xml`, `console.log`, prints, `session.json`, `result.json` |
| `catalog/catalog.json` | catálogo de casos gerado do projeto |
| `logs/` | `runner.log`, `web.log`, `farm.log`, `appium-g<grupo>.log` |

## Máquinas: saúde e fazenda com várias máquinas

**Página Máquinas** (`/maquinas`): memória, processador (por thread) e temperatura (processador e núcleos) de
cada máquina, ao vivo, com mini-gráficos de 30 min. Lido de `/proc` e `/sys/class/hwmon` — sem sudo. Com saúde
crítica (temperatura ≥ 85 °C, troca ativa com o swap, CPU saturada) a máquina **não recebe casos novos**; os que
estão rodando terminam. O ponto no menu fica amarelo/vermelho.

**Mais máquinas na fazenda:** este servidor é o **mestre** (painel, filas, resultados e, por padrão, a execução do Robot). Outra
máquina entra como **worker**: roda só um agente leve (emuladores, adb, Appium, métricas) e o mestre fala com ela
por um **túnel SSH** que ele mesmo abre (nenhuma porta nova exposta; o agente escuta em `127.0.0.1:7100`).

1. Na máquina nova (Ubuntu, com KVM), com sudo: `usermod -aG kvm <usuário>`, `loginctl enable-linger <usuário>` e
   as bibliotecas do emulador (`libx11-xcb1 libnss3 libpulse0 libgl1 libegl1 libgbm1 libxcomposite1 libxcursor1
   libxi6 libxtst6 libxkbfile1 libxcb-cursor0 libasound2t64`).
2. Copie para ela, nas mesmas versões do mestre: `~/jdk`, `~/node` (com Appium), `~/.appium` e `~/android-sdk`.
3. Em **Máquinas → Adicionar máquina**: ID, IP (LAN ou WireGuard), usuário e porta SSH, máximo de emuladores.
   Autorize a chave pública do mestre mostrada na tela (`~/.ssh/authorized_keys` do usuário SSH).
4. **Testar conexão** → **Instalar / atualizar agente** (copia `dist/agent.mjs` + scripts, grava `~/qa-farm-agent/.env`
   e o crontab) → **Ligar emuladores…**. Os celulares dela aparecem em Celulares numa seção própria e entram nas filas.

Celular de worker: serial `server02:emulator-5554`, índice global `100 × slot + local` (farm-03 do slot 1 = 103).
Se o worker cair, os casos dele viram erro de infraestrutura e voltam para a fila (outra máquina); os emuladores
dele não são reiniciados pelo mestre. Depois de atualizar o mestre, use "Instalar / atualizar agente" para manter o
mesmo commit nos workers.

**Dividir a carga (robot no worker):** a coluna **Robot** da tabela liga "robot nesta máquina": os casos dos
celulares do worker passam a rodar o `robot` nele mesmo, e o mestre só coordena. O mestre envia o snapshot do
projeto uma vez por revisão, acompanha o console ao vivo e, no fim, traz os artefatos para `runs/` (e apaga a cópia
do worker). No card do BrowserStack, **Robot dos casos roda em** escolhe a máquina que roda o robot das vagas da
nuvem; com ela fora do ar, esses casos esperam. O "Instalar / atualizar agente" monta o venv
(`~/qa-farm-agent/robot-venv`) com os mesmos pacotes do venv do projeto no mestre, offline e sem sudo (precisa do
mesmo Python). Se o mestre sumir por 90 s, o worker encerra o robot órfão; se o worker cair no meio do caso, o caso
vira erro de infraestrutura e volta para a fila.

## Desenvolvimento (Mac, sem emuladores)

```bash
npm install
npm run dev:fake        # painel + runner em modo simulado → http://localhost:3100 (senha: dev)
```

O modo simulado (`QAFARM_FAKE=1`) usa celulares, `adb`, `aapt2` e `robot` falsos; o resultado de cada caso vem do nome (`*PASS*`, `*FAIL*`, `*INFRA*`, `*TIMEOUT*`, `*NOMATCH*`).

## Testes — padrão AAA

Todo teste tem três blocos, nesta ordem: `// Arrange` (preparar), `// Act` (agir, uma ação) e `// Assert` (verificar). `// Act & Assert` só para exceções. O `npm run lint` verifica isso em todos os testes (TS e Python).

```ts
it("não inicia 2 casos com a mesma conta ao mesmo tempo", () => {
  // Arrange
  const q = queue([item("A", ["usuario_pix"]), item("B", ["usuario_pix"]), item("C")])
  const running = [{ queueId: q.id, itemId: "A", serial: "emulator-5554", accounts: ["usuario_pix"] }]

  // Act
  const result = schedule([q], [device("emulator-5556")], running)

  // Assert
  expect(result.map((a) => a.itemId)).toEqual(["C"])
})
```

```bash
npm run lint        # ESLint + verificação AAA
npm run typecheck
npm test            # Vitest: núcleo, runner (simulado), API/upload
npm run test:py     # pytest: listener e catálogo com Robot Framework 6.1.1 (requirements-dev.txt)
npm run test:e2e    # Playwright contra o build de produção em modo simulado
```

## Ferramentas de operação

```bash
npm run pick-cases -- --n 30 --distinct-accounts --spread-folders   # escolhe casos (JSON de ids)
npm run check-overlap -- <queueId>                                  # conta/celular sobrepostos + pico de concorrência
scripts/ops/sample-resources.sh 900 recursos.csv                    # memória/OOM/carga durante uma fila
```

## Limitações conhecidas

- Só o modo `LOC:local` (o servidor da cantina não é acessível do server01): o APK vem do upload.
- Um app por vez nos celulares: filas com APKs diferentes rodam uma depois da outra.
- Limite prático de 15 emuladores de 2 GB (RAM do servidor; ver docs/ACEITE.md).
- Casos que usam a mesma conta de teste rodam em série (ex.: `usuario_ofertas_publicas` aparece em 87 casos).
