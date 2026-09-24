import type { ItemStatus, Queue, QueueStatus } from "@/core/types"

export interface QueueSummaryDto {
  id: string
  name: string
  createdAt: string
  finishedAt: string | null
  appId: string
  env: string
  status: QueueStatus
  options: { timeoutSec: number; retries: number }
  total: number
  counts: Record<ItemStatus, number>
  finished: number
  progress: number
  avgDurationSec: number | null
  startedAt?: string
  lastEndedAt?: string
  minTheoreticalSec: number
}

export interface QueueDetailDto {
  summary: QueueSummaryDto
  queue: Queue
}
