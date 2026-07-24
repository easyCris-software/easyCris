export function plotDataRequiresWebGL(data: unknown): boolean {
  if (!Array.isArray(data)) return false
  return data.some((trace) => {
    if (!trace || typeof trace !== 'object') return false
    return (trace as { type?: unknown }).type === 'scattergl'
  })
}

