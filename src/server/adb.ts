import type { Config } from "@/core/config"

import { run, runBuffer, sleep } from "./exec"
import { FAKE_PNG, fakeAdbDevicesText, readWorld, updateWorld } from "./fake-world"

export interface Adb {
  devicesRaw(): Promise<string>
  bootCompleted(serial: string): Promise<boolean>
  versionCode(serial: string, pkg: string): Promise<number | undefined>
  install(serial: string, apk: string, pkg: string, versionCode: number): Promise<{ ok: boolean; output: string }>
  screencap(serial: string): Promise<Buffer | null>
  /** Janela com foco (ex.: "Application Not Responding: com.android.systemui"). */
  focusedWindow(serial: string): Promise<string>
  /** Fecha diálogos do sistema (inclusive ANR/"parou de responder"). */
  closeSystemDialogs(serial: string): Promise<void>
  putGlobalSetting(serial: string, key: string, value: string): Promise<void>
}

export function realAdb(cfg: Config): Adb {
  const adb = cfg.adbBin
  return {
    async devicesRaw() {
      const r = await run(adb, ["devices", "-l"], { timeoutMs: 15_000 })
      return r.stdout
    },
    async bootCompleted(serial) {
      const r = await run(adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], { timeoutMs: 10_000 })
      return r.stdout.trim() === "1"
    },
    async versionCode(serial, pkg) {
      const r = await run(adb, ["-s", serial, "shell", "dumpsys", "package", pkg], { timeoutMs: 20_000 })
      const m = /versionCode=(\d+)/.exec(r.stdout)
      return m ? Number(m[1]) : undefined
    },
    async install(serial, apk) {
      const r = await run(adb, ["-s", serial, "install", "-r", "-g", apk], { timeoutMs: 10 * 60_000 })
      const output = (r.stdout + r.stderr).trim()
      return { ok: r.code === 0 && /Success/.test(output), output }
    },
    async screencap(serial) {
      return runBuffer(adb, ["-s", serial, "exec-out", "screencap", "-p"], 15_000)
    },
    async focusedWindow(serial) {
      const r = await run(adb, ["-s", serial, "shell", "dumpsys", "window"], { timeoutMs: 15_000 })
      return /mCurrentFocus=Window\{\S+ \S+ ([^}]*)\}/.exec(r.stdout)?.[1] ?? ""
    },
    async closeSystemDialogs(serial) {
      await run(adb, ["-s", serial, "shell", "am", "broadcast", "-a", "android.intent.action.CLOSE_SYSTEM_DIALOGS"], { timeoutMs: 15_000 })
    },
    async putGlobalSetting(serial, key, value) {
      await run(adb, ["-s", serial, "shell", "settings", "put", "global", key, value], { timeoutMs: 15_000 })
    },
  }
}

export function fakeAdb(cfg: Config): Adb {
  const dir = cfg.dataDir
  return {
    async devicesRaw() {
      return fakeAdbDevicesText(await readWorld(dir, cfg.fakeScenario))
    },
    async bootCompleted(serial) {
      const d = (await readWorld(dir)).devices.find((x) => x.serial === serial)
      return !!d && d.adbState === "device" && Date.now() >= d.bootAt
    },
    async versionCode(serial, pkg) {
      return (await readWorld(dir)).devices.find((x) => x.serial === serial)?.installed[pkg]
    },
    async install(serial, _apk, pkg, versionCode) {
      const w = await readWorld(dir)
      await sleep(w.installDelayMs)
      let ok = false
      await updateWorld(dir, (world) => {
        const d = world.devices.find((x) => x.serial === serial)
        if (d && d.adbState === "device") {
          d.installed[pkg] = versionCode
          ok = true
        }
      })
      return { ok, output: ok ? "Success" : "error: device not found" }
    },
    async screencap(serial) {
      const d = (await readWorld(dir)).devices.find((x) => x.serial === serial)
      return d ? FAKE_PNG : null
    },
    async focusedWindow(serial) {
      const d = (await readWorld(dir)).devices.find((x) => x.serial === serial)
      return d?.dialog ?? "com.exemplo.App.hml/com.exemplo.versao3.MainActivity"
    },
    async closeSystemDialogs(serial) {
      await updateWorld(dir, (w) => {
        const d = w.devices.find((x) => x.serial === serial)
        if (d && !d.dialog?.includes("PERSISTENTE")) d.dialog = undefined
      })
    },
    async putGlobalSetting(serial, key, value) {
      await updateWorld(dir, (w) => {
        const d = w.devices.find((x) => x.serial === serial)
        if (d) d.settings = { ...d.settings, [key]: value }
      })
    },
  }
}
