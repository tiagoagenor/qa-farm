import { parseDeviceKey, splitIndex } from "@/core/machines"
import type { Adb } from "@/server/adb"
import type { AppiumPool } from "@/server/appium"
import type { AgentClient } from "@/server/remote/agent-client"

import type { RemoteMachines } from "./remote"

// Roteadores: o runner chama adb/Appium como sempre; o celular de um worker ("server02:emulator-5554",
// índice ≥ 100) vai para o agente daquela máquina, e o do mestre continua no adb/Appium locais.

function clientOf(remote: RemoteMachines, id: string): AgentClient {
  const c = remote.client(id)
  if (!c) throw new Error(`máquina ${id} sem agente configurado`)
  return c
}

export function routedAdb(local: Adb, remote: RemoteMachines): Adb {
  const route = (key: string) => parseDeviceKey(key, remote.ids())
  return {
    devicesRaw: () => local.devicesRaw(),
    async bootCompleted(key) {
      const r = route(key)
      return r.machineId ? clientOf(remote, r.machineId).bootCompleted(r.serial) : local.bootCompleted(key)
    },
    async versionCode(key, pkg) {
      const r = route(key)
      return r.machineId ? clientOf(remote, r.machineId).versionCode(r.serial, pkg) : local.versionCode(key, pkg)
    },
    async install(key, apk, pkg, versionCode, opts) {
      const r = route(key)
      if (!r.machineId) return local.install(key, apk, pkg, versionCode, opts)
      const c = clientOf(remote, r.machineId)
      const md5 = await c.ensureApk(apk) // 1 envio por worker (cache por md5)
      return c.install(r.serial, md5, pkg, versionCode, !!opts?.allowUninstall)
    },
    async screencap(key) {
      const r = route(key)
      return r.machineId ? clientOf(remote, r.machineId).screen(r.serial) : local.screencap(key)
    },
    async focusedWindow(key) {
      const r = route(key)
      return r.machineId ? clientOf(remote, r.machineId).focusedWindow(r.serial) : local.focusedWindow(key)
    },
    async closeSystemDialogs(key) {
      const r = route(key)
      return r.machineId ? clientOf(remote, r.machineId).action(r.serial, { action: "closeSystemDialogs" }) : local.closeSystemDialogs(key)
    },
    async putGlobalSetting(key, name, value) {
      const r = route(key)
      if (!r.machineId) return local.putGlobalSetting(key, name, value)
      if (name !== "hide_error_dialogs") throw new Error(`configuração ${name} não permitida no worker`)
      return clientOf(remote, r.machineId).action(r.serial, { action: "putGlobalSetting", key: name, value })
    },
    async forceStop(key, pkg) {
      const r = route(key)
      return r.machineId ? clientOf(remote, r.machineId).action(r.serial, { action: "forceStop", package: pkg }) : local.forceStop(key, pkg)
    },
    async keyevent(key, k) {
      const r = route(key)
      return r.machineId ? clientOf(remote, r.machineId).action(r.serial, { action: "keyevent", key: k }) : local.keyevent(key, k)
    },
    async disableLockscreen(key) {
      const r = route(key)
      return r.machineId ? clientOf(remote, r.machineId).action(r.serial, { action: "disableLockscreen" }) : local.disableLockscreen(key)
    },
  }
}

export function routedAppium(local: AppiumPool, remote: RemoteMachines): AppiumPool {
  const at = (index: number) => {
    const { slot, local: li } = splitIndex(index)
    if (slot === 0) return null
    const m = remote.bySlot(slot)
    if (!m) throw new Error(`nenhuma máquina no slot ${slot}`)
    return { id: m.id, li }
  }
  return {
    url(index) {
      const r = at(index)
      return r ? remote.appiumUrl(r.id, r.li) : local.url(index)
    },
    async ensure(index) {
      const r = at(index)
      return r ? clientOf(remote, r.id).appiumEnsure(r.li) : local.ensure(index)
    },
    async isReady(index) {
      const r = at(index)
      return r ? clientOf(remote, r.id).appiumReady(r.li) : local.isReady(index)
    },
    async cleanupSessions(index, key) {
      const r = at(index)
      if (!r) return local.cleanupSessions(index, key)
      return clientOf(remote, r.id).appiumCleanup(r.li, parseDeviceKey(key, remote.ids()).serial)
    },
    async stopAll() {
      await local.stopAll()
    },
    killStray: () => local.killStray(),
    async openSessions(index) {
      const r = at(index)
      return r ? clientOf(remote, r.id).appiumSessions(r.li) : local.openSessions(index)
    },
  }
}
