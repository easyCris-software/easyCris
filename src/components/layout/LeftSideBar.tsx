import { cn } from '@/lib/utils'
import { StatisticalTestsNav } from './StatisticalTestsNav'

interface LeftSideBarProps {
  children?: React.ReactNode
  className?: string
}

export function LeftSideBar({ children, className }: LeftSideBarProps) {
  return (
    <div
      className={cn('flex h-full flex-col border-r bg-background', className)}
    >
      {children ?? <StatisticalTestsNav />}
    </div>
  )
}

export default LeftSideBar
