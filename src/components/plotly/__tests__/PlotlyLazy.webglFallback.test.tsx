import { render, screen } from '@/test/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { PlotlyLazy } from '../PlotlyLazy'

vi.mock('@/utils/webgl', () => ({
  isWebGLSupported: vi.fn(() => false),
}))

describe('PlotlyLazy WebGL fallback', () => {
  it('renders an app-owned fallback for ScatterGL traces when WebGL is unavailable', () => {
    render(
      <PlotlyLazy
        data={[{ type: 'scattergl', x: [1, 2], y: [3, 4] }]}
        layout={{}}
        config={{}}
      />
    )

    expect(screen.getByTestId('scattergl-webgl-fallback')).toBeInTheDocument()
    expect(screen.getByText('ScatterGL requires WebGL')).toBeInTheDocument()
    expect(screen.queryByText(/WebGL is not supported by your browser/i)).toBeNull()
  })
})
