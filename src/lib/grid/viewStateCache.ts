const viewStateCache = new Map<string, unknown>()

export const getViewStateCache = <T>(key: string): T | undefined => {
  return viewStateCache.get(key) as T | undefined
}

export const setViewStateCache = <T>(key: string, value: T): void => {
  viewStateCache.set(key, value)
}

export const clearViewStateCacheForKey = (viewKey: string): void => {
  const prefix = `${viewKey}::`
  for (const key of viewStateCache.keys()) {
    if (key.startsWith(prefix)) {
      viewStateCache.delete(key)
    }
  }
}
