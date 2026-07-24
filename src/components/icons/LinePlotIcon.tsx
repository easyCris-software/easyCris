/**
 * Line Plot Icon - From Sparkle Icons
 * Source: https://github.com/slaylines/sparkle-icons
 * License: MIT
 */

import type { SVGProps } from 'react'

export function LinePlotIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        d="M1 29L8 20.16L16 27.52L24 14.72L31.36 21.92"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M1 18L8 24.64L16 14.56L24 25.12L31.36 11.2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M1 24L8 12.48L16 22.4L24 5.76L31.36 17.44"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="0" width="0.75" height="32" fill="currentColor" />
      <rect x="0" y="31.25" width="32" height="0.75" fill="currentColor" />
    </svg>
  )
}
