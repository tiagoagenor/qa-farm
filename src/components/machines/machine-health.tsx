"use client"

import { AlertTriangle, Cpu, MemoryStick, Thermometer } from "lucide-react"

import type { HistoryPoint, HostSample } from "@/core/metrics"
import { EmptyState, PageHeader } from "@/components/panel/page-header"
import { StatusBadge } from "@/components/panel/status-badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { usePoll } from "@/hooks/use-poll"
import type { Tone } from "@/lib/format"
import { refY, sparkPath } from "@/lib/sparkline"
import { cn } from "@/lib/utils"

import { BrowserStackCard } from "./browserstack-card"
import { MACHINE_STATE, MachineAdmin } from "./machine-admin"

interface MachineDto {
  id: string
  name: string
  role: "master" | "worker"
  sample: HostSample | null
  history: HistoryPoint[]
  health: { level: "ok" | "warn" | "crit"; alerts: Array<{ id: string; level: "warn" | "crit"; message: string }>; brake: boolean; blockStart: boolean }
  ageMs: number | null
  /** estado da conexão (só workers) */
  state?: string
}

const LEVEL: Record<MachineDto["health"]["level"], { label: string; tone: Tone }> = {
  ok: { label: "Saudável", tone: "ok" },
  warn: { label: "Atenção", tone: "warn" },
  crit: { label: "Crítico", tone: "fail" },
}

const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`
const STALE_MS = 15_000

/** Cor de uma célula pelo uso (%) ou temperatura (°C). */
function heat(v: number, kind: "pct" | "temp"): string {
  const [a, b, c] = kind === "pct" ? [50, 80, 95] : [60, 75, 85]
  if (v >= c) return "bg-red-500/80 text-white"
  if (v >= b) return "bg-amber-500/70 text-white"
  if (v >= a) return "bg-emerald-500/60"
  return "bg-emerald-500/20"
}

function Sparkline({
  values,
  min,
  max,
  refs = [],
  className,
  label,
}: {
  values: Array<number | null>
  min: number
  max: number
  refs?: Array<{ value: number; tone: "warn" | "fail" }>
  className?: string
  label: string
}) {
  const w = 240
  const h = 40
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={cn("h-10 w-full", className)} role="img" aria-label={label}>
      {refs.map((r) => (
        <line
          key={r.value}
          x1={0}
          x2={w}
          y1={refY(r.value, h, min, max)}
          y2={refY(r.value, h, min, max)}
          strokeDasharray="4 3"
          strokeWidth={1}
          className={r.tone === "fail" ? "stroke-red-500/70" : "stroke-amber-500/70"}
        />
      ))}
      <path d={sparkPath(values, w, h, min, max)} fill="none" strokeWidth={1.5} className="stroke-primary" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function Bar({ parts, total, label }: { parts: Array<{ value: number; className: string }>; total: number; label: string }) {
  return (
    <div className="bg-muted flex h-2.5 w-full overflow-hidden rounded-full" role="img" aria-label={label}>
      {parts.map((p, i) => (
        <div key={i} className={p.className} style={{ width: `${Math.max(0, Math.min(100, (p.value / Math.max(1, total)) * 100))}%` }} />
      ))}
    </div>
  )
}

function Section({ icon: Icon, title, children }: { icon: React.ElementType; title: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2">
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
        <Icon className="size-3.5" /> {title}
      </p>
      {children}
    </div>
  )
}

function MachineCard({ m, memLimitMb }: { m: MachineDto; memLimitMb: number }) {
  const s = m.sample
  const stale = m.ageMs === null || m.ageMs > STALE_MS
  const level = stale ? "warn" : m.health.level
  const hist = m.history
  return (
    <Card
      className={cn("gap-3 py-4", level === "crit" && "border-red-500/60", level === "warn" && "border-amber-500/60")}
      data-testid="machine-card"
      data-machine={m.id}
      data-level={level}
    >
      <CardHeader className="px-4">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base">{m.name}</CardTitle>
          {m.role === "master" && <StatusBadge label="mestre" tone="info" />}
          {m.role === "worker" && m.state && <StatusBadge {...(MACHINE_STATE[m.state] ?? MACHINE_STATE.pending)} />}
          <StatusBadge {...LEVEL[level]} />
          {m.health.brake && !stale && <StatusBadge label="freio ativo: novos casos aguardam" tone="fail" />}
          <span className="text-muted-foreground ml-auto text-xs" data-testid="machine-age">
            {m.ageMs === null ? "sem dados" : stale ? `sem dados há ${Math.round(m.ageMs / 1000)} s` : "ao vivo"}
          </span>
        </div>
        {(m.health.alerts.length > 0 || stale) && (
          <ul className="mt-1 grid gap-0.5 text-xs" data-testid="machine-alerts">
            {stale && (
              <li className="flex items-center gap-1 text-amber-700 dark:text-amber-400">
                <AlertTriangle className="size-3.5" />{" "}
                {m.role === "worker" ? "Sem resposta da máquina: os casos dela aguardam até ela voltar" : "O runner não atualiza a saúde desta máquina (ele está rodando?)"}
              </li>
            )}
            {!stale &&
              m.health.alerts.map((a) => (
                <li key={a.id} className={cn("flex items-center gap-1 font-medium", a.level === "crit" ? "text-red-700 dark:text-red-400" : "text-amber-700 dark:text-amber-400")}>
                  <AlertTriangle className="size-3.5" /> {a.message}
                </li>
              ))}
          </ul>
        )}
      </CardHeader>
      {!s ? (
        <CardContent className="text-muted-foreground px-4 text-sm">Aguardando a primeira leitura…</CardContent>
      ) : (
        <CardContent className="grid gap-5 px-4 text-sm">
          <Section icon={MemoryStick} title="Memória">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-lg font-semibold tabular-nums" data-testid="mem-available">
                {gb(s.memAvailableMb)} disponíveis
              </span>
              <span className="text-muted-foreground text-xs tabular-nums">
                {gb(s.memUsedMb)} usados de {gb(s.memTotalMb)}
              </span>
            </div>
            <Bar
              total={s.memTotalMb}
              label={`Memória usada ${gb(s.memUsedMb)} de ${gb(s.memTotalMb)}`}
              parts={[{ value: s.memUsedMb, className: s.memAvailableMb < memLimitMb ? "bg-red-500" : "bg-primary" }]}
            />
            <div className="text-muted-foreground flex items-center justify-between text-xs tabular-nums">
              <span>
                Swap {gb(s.swapUsedMb)} / {gb(s.swapTotalMb)}
                {s.swapInPerSec > 0 && ` · trocando ${s.swapInPerSec} pág/s`}
              </span>
              <span>cache {gb(s.buffersCacheMb)}</span>
            </div>
            <Sparkline
              label="Memória disponível nos últimos 30 minutos"
              values={hist.map((p) => p.memAvailableMb)}
              min={0}
              max={s.memTotalMb}
              refs={[{ value: memLimitMb, tone: "fail" }]}
            />
          </Section>

          <Section icon={Cpu} title="Processador">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-lg font-semibold tabular-nums" data-testid="cpu-pct">
                {Math.round(s.cpuPct)}%
              </span>
              <span className="text-muted-foreground text-xs tabular-nums">
                load {s.load1} · {s.load5} · {s.load15} / {s.threads} threads
              </span>
            </div>
            <div className="grid grid-cols-8 gap-0.5 sm:grid-cols-16" data-testid="cpu-grid">
              {s.perCpuPct.map((v, i) => (
                <div key={i} className={cn("h-3 rounded-sm", heat(v, "pct"))} title={`Thread ${i}: ${Math.round(v)}%`} />
              ))}
            </div>
            <Sparkline label="Uso da CPU nos últimos 30 minutos" values={hist.map((p) => p.cpuPct)} min={0} max={100} refs={[{ value: 90, tone: "warn" }]} />
          </Section>

          <Section icon={Thermometer} title="Temperatura do processador">
            {s.temp.packageC === null ? (
              <p className="text-muted-foreground text-xs" data-testid="temp-none">
                Sem sensor de temperatura nesta máquina.
              </p>
            ) : (
              <>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-lg font-semibold tabular-nums" data-testid="temp-package">
                    {s.temp.packageC} °C
                  </span>
                  <span className="text-muted-foreground text-xs tabular-nums">
                    núcleos {Math.min(...s.temp.cores.map((c) => c.c))}–{Math.max(...s.temp.cores.map((c) => c.c))} °C
                    {s.temp.critC !== null && ` · limite do chip ${s.temp.critC} °C`}
                  </span>
                </div>
                <div className="grid grid-cols-8 gap-0.5" data-testid="temp-cores">
                  {s.temp.cores.map((c) => (
                    <div key={c.label} className={cn("rounded-sm py-0.5 text-center text-[10px] tabular-nums", heat(c.c, "temp"))} title={`${c.label}: ${c.c} °C`}>
                      {Math.round(c.c)}°
                    </div>
                  ))}
                </div>
                <Sparkline
                  label="Temperatura nos últimos 30 minutos"
                  values={hist.map((p) => p.tempC)}
                  min={20}
                  max={100}
                  refs={[
                    { value: 80, tone: "warn" },
                    { value: 85, tone: "fail" },
                  ]}
                />
                {s.temp.gpu && (
                  <p className="text-muted-foreground text-xs">
                    GPU ({s.temp.gpu.name}): {s.temp.gpu.c} °C
                  </p>
                )}
              </>
            )}
          </Section>

          <p className="text-muted-foreground border-t pt-3 text-xs tabular-nums">
            {s.emulatorsRunning ?? 0} emulador(es) ligado(s) · {s.diskRootFreeGb} GB livres no disco · gráficos: últimos 30 min
          </p>
        </CardContent>
      )}
    </Card>
  )
}

export function MachineHealth() {
  const { data, loading } = usePoll<{ machines: MachineDto[] }>("/api/machines/metrics", 2000)
  return (
    <div>
      <PageHeader title="Máquinas" description="Memória, processador e temperatura de cada máquina, ao vivo. Com saúde crítica, a máquina não recebe casos novos." />
      {loading && !data ? (
        <Skeleton className="h-96" />
      ) : !data?.machines.length ? (
        <EmptyState title="Sem leituras ainda">O runner grava a saúde da máquina a cada 2 segundos. Verifique se ele está rodando.</EmptyState>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
          {data.machines.map((m) => (
            <MachineCard key={m.id} m={m} memLimitMb={1500} />
          ))}
        </div>
      )}
      <MachineAdmin />
      <BrowserStackCard />
    </div>
  )
}
