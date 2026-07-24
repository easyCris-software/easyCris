import { Globe2, Wifi } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { remoteConnectionModeLabel } from '@/components/remote/remoteConnectionMode'
import type { RemoteSessionMode } from '@/services/remoteSessionService'

interface RemoteConnectionModeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (mode: RemoteSessionMode) => void
}

const testIdPrefix = 'remote-host-mode'

const connectionOptions = [
  {
    description: 'For someone on the same local network.',
    icon: Wifi,
    mode: 'lan',
    testId: 'same-wifi',
    title: remoteConnectionModeLabel('lan'),
  },
  {
    description: 'For someone connecting from another network.',
    icon: Globe2,
    mode: 'cloud',
    testId: 'different-network',
    title: remoteConnectionModeLabel('cloud'),
  },
] as const

export function RemoteConnectionModeDialog({
  open,
  onOpenChange,
  onSelect,
}: RemoteConnectionModeDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid={`${testIdPrefix}-dialog`}>
        <DialogHeader>
          <DialogTitle>Start remote session</DialogTitle>
          <DialogDescription>
            Choose how your trusted guest will connect.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          {connectionOptions.map(option => {
            const Icon = option.icon
            return (
              <Button
                key={option.mode}
                type="button"
                variant="outline"
                className="h-auto justify-start gap-3 px-4 py-3 text-left"
                onClick={() => onSelect(option.mode)}
                data-testid={`${testIdPrefix}-${option.testId}`}
              >
                <Icon className="h-4 w-4 flex-shrink-0" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">
                    {option.title}
                  </span>
                  <span className="block text-xs font-normal text-muted-foreground">
                    {option.description}
                  </span>
                </span>
              </Button>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default RemoteConnectionModeDialog
