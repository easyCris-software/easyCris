/**
 * ActionsPanel Component
 *
 * Right side of welcome screen with action cards and controls.
 */

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { ActionCard } from './ActionCard'
import { FolderPlus, FolderDown, BookOpen } from 'lucide-react'

interface ActionsPanelProps {
  onCreateProject: () => void
  onImportData: () => void
  onBrowseExamples: () => void
  onContinue: () => void
  onSkip: () => void
  dontShowAgain: boolean
  onDontShowAgainChange: (checked: boolean) => void
}

export function ActionsPanel({
  onCreateProject,
  onImportData,
  onBrowseExamples,
  onContinue,
  onSkip,
  dontShowAgain,
  onDontShowAgainChange,
}: ActionsPanelProps) {
  return (
    <div className="flex h-full flex-col gap-6 p-10 bg-background">
      <div className="flex-1 space-y-6">
        {/* Heading */}
        <div className="space-y-2">
          <h2 className="text-3xl font-semibold tracking-tight">Let's Get Started</h2>
          <p className="text-muted-foreground">
            Choose how you'd like to begin your analysis journey with easyCris
          </p>
        </div>

        {/* Action Cards */}
        <div className="space-y-3">
          <ActionCard
            icon={<FolderPlus className="h-6 w-6" />}
            title="Create New Project"
            description="Start fresh with a new analysis project"
            onClick={onCreateProject}
          />
          <ActionCard
            icon={<FolderDown className="h-6 w-6" />}
            title="Import Data"
            description="Load your CSV, Excel, or other data files"
            onClick={onImportData}
          />
          <ActionCard
            icon={<BookOpen className="h-6 w-6" />}
            title="Browse Examples"
            description="Explore sample datasets and workflows"
            onClick={onBrowseExamples}
          />
        </div>
      </div>

      {/* Bottom Controls */}
      <div className="space-y-4 border-t border-border/60 pt-4">
        {/* Checkbox */}
        <div className="flex items-center space-x-2">
          <Checkbox
            id="dont-show"
            checked={dontShowAgain}
            onCheckedChange={(checked) => onDontShowAgainChange(checked === true)}
          />
          <Label
            htmlFor="dont-show"
            className="text-sm font-normal cursor-pointer"
          >
            Don't show this welcome screen again
          </Label>
        </div>

        {/* Buttons */}
        <div className="flex items-center justify-between">
          <Button variant="ghost" onClick={onSkip}>
            Skip
          </Button>
          <Button onClick={onContinue} style={{ backgroundColor: '#3949ab' }}>
            Continue
          </Button>
        </div>
      </div>
    </div>
  )
}
