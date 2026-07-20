import { WarningCircle } from '@phosphor-icons/react'

export function ScatterGLWebGLFallback() {
  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center gap-3 p-8 text-center"
      role="alert"
      data-testid="scattergl-webgl-fallback"
    >
      <div className="rounded-full border border-amber-200 bg-amber-50 p-3 text-amber-600 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
        <WarningCircle className="h-8 w-8" weight="bold" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
          ScatterGL requires WebGL
        </p>
        <p className="max-w-md text-xs leading-5 text-zinc-500 dark:text-zinc-400">
          WebGL is unavailable in this environment. Use Scatter Plot for smaller or sampled data,
          or enable GPU acceleration in WebView2 / Edge settings.
        </p>
      </div>
    </div>
  )
}

