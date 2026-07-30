import { availableParallelism } from 'node:os'

interface VitestWorkerPolicyOptions {
  ci: boolean
  parallelism?: number
}

export const resolveVitestMaxWorkers = ({
  ci,
  parallelism = availableParallelism(),
}: VitestWorkerPolicyOptions) =>
  Math.max(1, Math.min(ci ? 2 : 4, parallelism - 1))
