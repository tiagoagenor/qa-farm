"use client"

import { Bot, FlaskConical } from "lucide-react"
import Link from "next/link"

import { PageHeader } from "@/components/panel/page-header"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { usePoll } from "@/hooks/use-poll"

interface CatalogCount {
  status: string
  total: number
}

/** Tela inicial de Testes: qual projeto de testes usar. */
export function ProjectChooser() {
  const { data: robot } = usePoll<CatalogCount>("/api/catalog", 30_000)
  const { data: giat } = usePoll<CatalogCount>("/api/catalog?project=giat", 30_000)
  const count = (d: CatalogCount | null | undefined) => (!d ? "…" : d.status === "error" ? "não encontrado no servidor" : `${d.total} caso(s)`)
  const options = [
    {
      href: "/testes?projeto=robot",
      icon: Bot,
      title: "Robot",
      sub: "QA_Automacao_APP",
      text: "Projeto Robot Framework atual. Ambientes hml, dev e pre.",
      count: count(robot),
      testid: "choose-robot",
    },
    {
      href: "/testes?projeto=giat",
      icon: FlaskConical,
      title: "GI-App-Test",
      sub: "QA_Automacao_TESTE",
      text: "Testes Appium em Node (WebdriverIO). Ambientes HML, PROD e MOCK.",
      count: count(giat),
      testid: "choose-giat",
    },
  ]
  return (
    <div>
      <PageHeader title="Testes" description="Qual projeto de testes você quer usar?" />
      <div className="grid gap-4 sm:grid-cols-2">
        {options.map((o) => (
          <Link key={o.href} href={o.href} data-testid={o.testid} className="group">
            <Card className="group-hover:border-primary h-full gap-2 py-5 transition-colors">
              <CardHeader className="px-5">
                <CardTitle className="flex items-center gap-2 text-lg">
                  <o.icon className="size-5" /> {o.title}
                  <span className="text-muted-foreground font-mono text-xs font-normal">{o.sub}</span>
                </CardTitle>
                <CardDescription>{o.text}</CardDescription>
                <p className="text-muted-foreground text-sm">{o.count}</p>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  )
}
