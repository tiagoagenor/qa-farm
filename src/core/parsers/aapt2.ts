export interface ApkInfo {
  package: string
  versionName: string
  versionCode: number
  minSdk: number
  abis: string[]
  launchableActivity: string
}

/** Lê a saída de `aapt2 dump badging <apk>`. Retorna null se não parecer um APK. */
export function parseBadging(text: string): ApkInfo | null {
  const pkg = /^package: name='([^']+)' versionCode='(\d+)' versionName='([^']*)'/m.exec(text)
  if (!pkg) return null
  const minSdk = /^(?:minSdkVersion|sdkVersion):'(\d+)'/m.exec(text)
  const activity = /^launchable-activity: name='([^']+)'/m.exec(text)
  const native = /^native-code: (.*)$/m.exec(text)
  const abis = native ? [...native[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : []
  return {
    package: pkg[1],
    versionCode: Number(pkg[2]),
    versionName: pkg[3],
    minSdk: minSdk ? Number(minSdk[1]) : 1,
    abis,
    launchableActivity: activity?.[1] ?? "",
  }
}

export const EMULATOR_API = 33

/** Motivos para recusar o APK no emulador (lista vazia = aceito). */
export function apkProblems(info: ApkInfo): string[] {
  const problems: string[] = []
  // APK sem código nativo roda em qualquer arquitetura; com código nativo precisa de x86_64.
  if (info.abis.length > 0 && !info.abis.includes("x86_64")) {
    problems.push(`APK não tem código x86_64 (tem: ${info.abis.join(", ")}); não roda no emulador`)
  }
  if (info.minSdk > EMULATOR_API) {
    problems.push(`APK exige Android API ${info.minSdk}; os emuladores são API ${EMULATOR_API}`)
  }
  if (!info.launchableActivity) {
    problems.push("APK não tem activity inicial (launchable-activity)")
  }
  return problems
}
