import fs from "node:fs"
import path from "node:path"

import { isAlive } from "@/server/exec"

/**
 * Garante um único runner por pasta de dados. No server01 o supervisor também usa `flock`;
 * este lock por PID cobre execuções manuais e o Mac (que não tem flock).
 */
export function acquireLock(file: string): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  try {
    const fd = fs.openSync(file, "wx")
    fs.writeSync(fd, String(process.pid))
    fs.closeSync(fd)
    return true
  } catch {
    const pid = Number(fs.readFileSync(file, "utf8").trim())
    if (pid && pid !== process.pid && isAlive(pid)) return false
    fs.writeFileSync(file, String(process.pid))
    return true
  }
}

export function releaseLock(file: string): void {
  try {
    if (Number(fs.readFileSync(file, "utf8").trim()) === process.pid) fs.rmSync(file)
  } catch {
    /* ok */
  }
}
