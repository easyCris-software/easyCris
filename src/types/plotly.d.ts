declare module 'react-plotly.js' {
  import type * as React from 'react'
  import type Plotly from 'plotly.js'

export interface PlotComponentProps {
  data: Plotly.Data[]
  layout?: Partial<Plotly.Layout>
  config?: Partial<Plotly.Config>
  style?: React.CSSProperties
  className?: string
  useResizeHandler?: boolean
  onClick?: (event: Plotly.PlotMouseEvent) => void
  onHover?: (event: Plotly.PlotMouseEvent) => void
}

  const Plot: React.ComponentType<PlotComponentProps>
  export default Plot
}

declare module 'plotly.js' {
  const Plotly: any
  export type Data = any
  export type Layout = any
  export type Config = any
  export interface PlotMouseEvent {
    points: Array<Record<string, unknown>>
    event: MouseEvent
  }
  export default Plotly
}

declare module 'plotly.js/dist/plotly.min.js' {
  const Plotly: any
  export default Plotly
}
