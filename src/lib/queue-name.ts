import type { AppMeta, CatalogEntry } from "@/core/types"

/** "7.26.0-5528" — versão do app + build number (como no nome do APK). */
export function appVersionLabel(app: Pick<AppMeta, "versionName" | "versionCode">): string {
  return `${app.versionName}-${app.versionCode}`
}

/** Pasta comum a todos os casos, relativa a scenarios/ (ex.: "investimentos/bolsaFacil"); null se não houver. */
export function commonFolder(entries: Pick<CatalogEntry, "folder">[]): string | null {
  if (entries.length === 0) return null
  const split = entries.map((e) => e.folder.split("/").slice(1)) // sem "scenarios"
  const first = split[0]
  let n = 0
  while (n < first.length && split.every((p) => p[n] === first[n])) n++
  return n > 0 ? first.slice(0, n).join("/") : null
}

function today(now: Date): string {
  const p = (x: number) => String(x).padStart(2, "0")
  return `${p(now.getDate())}/${p(now.getMonth() + 1)}/${now.getFullYear()}`
}

/**
 * Nome sugerido para a fila:
 * - casos de uma única pasta → "{versão-build} {pasta}"
 * - casos de várias pastas   → "{versão-build} Fila {dd/mm/aaaa}"
 * Sem app escolhido, só a parte depois da versão.
 */
export function defaultQueueName(
  app: Pick<AppMeta, "versionName" | "versionCode"> | null | undefined,
  entries: Pick<CatalogEntry, "folder">[],
  now: Date = new Date(),
): string {
  const folder = commonFolder(entries)
  const rest = folder ?? `Fila ${today(now)}`
  return app ? `${appVersionLabel(app)} ${rest}` : rest
}
