import type { Config } from "@/core/config"

import { type Aapt2, fakeAapt2, realAapt2 } from "./aapt2"
import { type Adb, fakeAdb, realAdb } from "./adb"
import { type AppiumPool, fakeAppium, realAppium } from "./appium"
import { type CatalogBuilder, fakeCatalog, realCatalog } from "./catalog"
import { type Farm, fakeFarm, realFarm } from "./farm"
import { type BrowserStackApi, fakeBrowserStack, realBrowserStack } from "./browserstack"
import { fakeHostMetrics, type HostMetrics, realHostMetrics } from "./host-metrics"
import { fakeProjectGit, type ProjectGit, projectRoot, realProjectGit } from "./project-git"
import { fakeRobot, realRobot, type RobotLauncher } from "./robot"
import { fakeSnapshots, realSnapshots, type SnapshotProvider } from "./snapshot"

export interface Adapters {
  adb: Adb
  farm: Farm
  appium: AppiumPool
  robot: RobotLauncher
  aapt2: Aapt2
  catalog: CatalogBuilder
  snapshots: SnapshotProvider
  metrics: HostMetrics
  browserstack: BrowserStackApi
  git: ProjectGit
}

export function createAdapters(cfg: Config): Adapters {
  if (cfg.fake) {
    return {
      adb: fakeAdb(cfg),
      farm: fakeFarm(cfg),
      appium: fakeAppium(cfg),
      robot: fakeRobot(cfg),
      aapt2: fakeAapt2(cfg),
      catalog: fakeCatalog(cfg),
      snapshots: fakeSnapshots(cfg),
      metrics: fakeHostMetrics(cfg),
      browserstack: fakeBrowserStack(cfg),
      git: fakeProjectGit(cfg, projectRoot(cfg)),
    }
  }
  return {
    adb: realAdb(cfg),
    farm: realFarm(cfg),
    appium: realAppium(cfg),
    robot: realRobot(cfg),
    aapt2: realAapt2(cfg),
    catalog: realCatalog(cfg),
    snapshots: realSnapshots(cfg),
    metrics: realHostMetrics(),
    browserstack: realBrowserStack(cfg),
    git: realProjectGit(cfg.robotProject),
  }
}
