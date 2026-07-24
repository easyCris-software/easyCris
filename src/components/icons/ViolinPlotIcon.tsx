/**
 * Violin Plot Icon
 * Custom icon design
 */

import type { SVGProps } from 'react'

export function ViolinPlotIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {/* Left violin (smaller) */}
      <path
        d="M4 2 C4 2, 1.5 8, 1.5 16 C1.5 24, 4 30, 4 30 C4 30, 6.5 24, 6.5 16 C6.5 8, 4 2, 4 2 Z"
        fill="currentColor"
        fillOpacity="1"
      />

      {/* Middle violin (larger) */}
      <path
        d="M16 1 C16 1, 12 10, 12 16 C12 22, 16 31, 16 31 C16 31, 20 22, 20 16 C20 10, 16 1, 16 1 Z"
        fill="currentColor"
        fillOpacity="0.7"
      />

      {/* Right violin (medium) */}
      <path
        d="M27 4 C27 4, 24.5 10, 24.5 16 C24.5 22, 27 28, 27 28 C27 28, 29.5 22, 29.5 16 C29.5 10, 27 4, 27 4 Z"
        fill="currentColor"
        fillOpacity="0.4"
      />
    </svg>
  )
}
