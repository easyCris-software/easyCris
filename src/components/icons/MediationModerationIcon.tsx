/**
 * Mediation & Moderation Category Icon
 */

import { CirclesThree } from '@phosphor-icons/react'

interface MediationModerationIconProps {
  className?: string
  size?: number
}

export function MediationModerationIcon({ className, size = 20 }: MediationModerationIconProps) {
  return <CirclesThree className={className} size={size} weight="regular" />
}
