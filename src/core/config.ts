import os from "node:os"
import path from "node:path"

export interface Config {
  repoRoot: string
  dataDir: string
  fake: boolean
  fakeScenario?: string
  fakeSpeed: number
  fakeIoDelayMs: number
  password: string
  secret: string
  robotProject: string
  robotBin: string
  pythonBin: string
  aapt2: string
  appiumBin: string
  adbBin: string
  farmHome: string
  sdkRoot: string
  javaHome: string
  appiumBasePort: number
  devicesPerAppium: number
  maxDevices: number
  /**
   * Freio de emergência: não começa caso novo com menos que isso de memória livre (MB).
   * A memória do emulador já está reservada por ele estar ligado; o caso em si (Robot + sessão Appium) custa pouco.
   */
  minFreeMemMb: number
  /** Memória que cada caso novo acrescenta enquanto roda (Robot + sessão Appium), descontada ao começar vários de uma vez. */
  caseMemMb: number
  installConcurrency: number
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) && v !== undefined && v !== "" ? n : fallback
}

/** Lê a configuração do ambiente (process.env). Sem efeitos colaterais. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = env.HOME ?? os.homedir()
  const repoRoot = env.QAFARM_REPO_ROOT ?? process.cwd()
  const sdkRoot = env.ANDROID_SDK_ROOT ?? path.join(home, "android-sdk")
  const robotProject = env.QAFARM_ROBOT_PROJECT ?? path.join(home, "www/QA_Automacao_APP")
  const dataDir = path.resolve(repoRoot, env.QAFARM_DATA_DIR ?? path.join(home, "qa-farm-data"))
  return {
    repoRoot,
    dataDir,
    fake: env.QAFARM_FAKE === "1",
    fakeScenario: env.QAFARM_FAKE_SCENARIO,
    fakeSpeed: num(env.QAFARM_FAKE_SPEED, 1),
    fakeIoDelayMs: num(env.QAFARM_FAKE_IO_DELAY_MS, 0),
    password: env.QAFARM_PASSWORD ?? "",
    secret: env.QAFARM_SECRET ?? "",
    robotProject,
    robotBin: env.QAFARM_ROBOT_BIN ?? path.join(robotProject, ".venv/bin/robot"),
    pythonBin: env.QAFARM_PYTHON_BIN ?? path.join(robotProject, ".venv/bin/python"),
    aapt2: env.QAFARM_AAPT2 ?? path.join(sdkRoot, "build-tools/37.0.0/aapt2"),
    appiumBin: env.QAFARM_APPIUM_BIN ?? path.join(home, "node/bin/appium"),
    adbBin: env.QAFARM_ADB_BIN ?? path.join(sdkRoot, "platform-tools/adb"),
    farmHome: env.QAFARM_FARM_HOME ?? path.join(home, "android-farm"),
    sdkRoot,
    javaHome: env.JAVA_HOME ?? path.join(home, "jdk"),
    appiumBasePort: num(env.QAFARM_APPIUM_BASE_PORT, 4800),
    devicesPerAppium: Math.max(1, num(env.QAFARM_DEVICES_PER_APPIUM, 5)),
    maxDevices: num(env.QAFARM_MAX_DEVICES, 18),
    minFreeMemMb: num(env.QAFARM_MIN_FREE_MEM_MB, 1500),
    caseMemMb: num(env.QAFARM_CASE_MEM_MB, 150),
    // troca de versão do APK: instala em até 5 celulares ao mesmo tempo (cada emulador usa os próprios núcleos)
    installConcurrency: num(env.QAFARM_INSTALL_CONCURRENCY, 5),
  }
}
