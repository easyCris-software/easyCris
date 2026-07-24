export type ReadViewportFn = () => { width: number; height: number }
export type ApplyVarsFn = (width: number, height: number) => void
export type RafFn = (callback: FrameRequestCallback) => number
export type CancelRafFn = (id: number) => void

export function scheduleViewportVarsRefresh(
  readViewport: ReadViewportFn,
  applyVars: ApplyVarsFn,
  raf: RafFn = requestAnimationFrame,
  cancelRaf: CancelRafFn = cancelAnimationFrame
): () => void {
  let outerHandle: number | null = null
  let innerHandle: number | null = null

  outerHandle = raf(() => {
    outerHandle = null
    innerHandle = raf(() => {
      innerHandle = null
      const { width, height } = readViewport()
      applyVars(width, height)
    })
  })

  return () => {
    if (outerHandle !== null) cancelRaf(outerHandle)
    if (innerHandle !== null) cancelRaf(innerHandle)
  }
}
