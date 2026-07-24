import type { AppOperationLock } from '@/store/app-store'

export function shouldShowBlockingAppBusyOverlay(
  lock: Pick<AppOperationLock, 'active' | 'owner'>
): boolean {
  return lock.active && (lock.owner === 'rnaseq' || lock.owner === 'paste' || lock.owner === 'grid')
}
