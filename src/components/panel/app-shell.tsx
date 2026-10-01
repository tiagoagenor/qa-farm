"use client"

import { AlertTriangle, Boxes, GitBranch, ListChecks, LogOut, Moon, Package, Server, Smartphone, Sun } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useTheme } from "next-themes"
import { useEffect, useState } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { usePoll } from "@/hooks/use-poll"

export interface Overview {
  runner: {
    alive: boolean
    ageMs: number | null
    fake: boolean
    catalogStatus: string
    catalogError: string | null
    farmJob: { command: string; startedAt: string } | null
  }
  devices: { total: number; emulators: number; ready: number; busy: number; desired: number }
  activeQueues: number
  health?: "ok" | "warn" | "crit"
}

const NAV = [
  { href: "/filas", label: "Filas", icon: ListChecks, badge: (o: Overview) => o.activeQueues || null },
  { href: "/testes", label: "Testes", icon: Boxes, badge: () => null },
  {
    href: "/celulares",
    label: "Celulares",
    icon: Smartphone,
    badge: (o: Overview) => (o.devices.emulators ? `${o.devices.ready + o.devices.busy}/${o.devices.emulators}` : null),
  },
  { href: "/maquinas", label: "Máquinas", icon: Server, badge: () => null },
  { href: "/apps", label: "Apps", icon: Package, badge: () => null },
  { href: "/projeto", label: "Projeto", icon: GitBranch, badge: () => null },
]

/** Ponto de alerta no menu: vermelho = alguma máquina crítica; amarelo = atenção. */
function HealthDot({ level }: { level?: Overview["health"] }) {
  if (!level || level === "ok") return null
  return (
    <SidebarMenuBadge>
      <span
        className={`inline-block size-2.5 rounded-full ${level === "crit" ? "bg-red-500" : "bg-amber-500"}`}
        aria-label={level === "crit" ? "Máquina em estado crítico" : "Máquina em atenção"}
        data-testid="health-dot"
        data-level={level}
      />
    </SidebarMenuBadge>
  )
}

function RunnerBanner({ o }: { o: Overview | null }) {
  if (!o) return null
  if (!o.runner.alive) {
    return (
      <Alert variant="destructive" className="mb-4" data-testid="runner-banner">
        <AlertTriangle />
        <AlertTitle>Runner parado</AlertTitle>
        <AlertDescription>
          O processo que executa as filas não responde {o.runner.ageMs !== null ? `há ${Math.round(o.runner.ageMs / 1000)} s` : "(nunca iniciou)"}.
          Nenhum caso novo começa até ele voltar. O supervisor tenta reiniciá-lo a cada minuto.
        </AlertDescription>
      </Alert>
    )
  }
  return null
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { data: overview } = usePoll<Overview>("/api/overview", 5000)
  const { resolvedTheme, setTheme } = useTheme()
  // o tema só é conhecido no navegador: evita diferença entre HTML do servidor e do cliente
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const dark = mounted && resolvedTheme === "dark"

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" })
    window.location.href = "/login"
  }

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <div className="flex items-center gap-2 px-2 py-1.5">
            <div className="bg-primary text-primary-foreground grid size-8 shrink-0 place-items-center rounded-md text-sm font-bold">QA</div>
            <div className="min-w-0 group-data-[collapsible=icon]:hidden">
              <p className="truncate text-sm font-semibold">QA Farm</p>
              <p className="text-muted-foreground truncate text-xs">
                {overview?.runner.fake ? "modo simulado" : "server01"}
              </p>
            </div>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {NAV.map((n) => {
                  const badge = overview ? n.badge(overview) : null
                  return (
                    <SidebarMenuItem key={n.href}>
                      <SidebarMenuButton asChild isActive={pathname.startsWith(n.href)} tooltip={n.label}>
                        <Link href={n.href}>
                          <n.icon />
                          <span>{n.label}</span>
                        </Link>
                      </SidebarMenuButton>
                      {badge !== null && <SidebarMenuBadge>{badge}</SidebarMenuBadge>}
                      {n.href === "/maquinas" && <HealthDot level={overview?.health} />}
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Tema" onClick={() => setTheme(dark ? "light" : "dark")}>
                {dark ? <Sun /> : <Moon />}
                <span>Tema {dark ? "claro" : "escuro"}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip="Sair" onClick={logout}>
                <LogOut />
                <span>Sair</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-w-0">
        <header className="bg-background/95 sticky top-0 z-10 flex h-12 items-center gap-2 border-b px-4 backdrop-blur">
          <SidebarTrigger />
          <div className="text-muted-foreground ml-auto flex items-center gap-3 text-xs">
            {overview?.runner.farmJob && <span>Fazenda: {overview.runner.farmJob.command}…</span>}
            <span className="flex items-center gap-1.5">
              <span className={`size-2 rounded-full ${overview?.runner.alive ? "bg-emerald-500" : "bg-red-500"}`} />
              {overview?.runner.alive ? "Runner ativo" : "Runner parado"}
            </span>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1400px] min-w-0 p-4 md:p-6">
          <RunnerBanner o={overview} />
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
