/**
 * WelcomeScreen Component
 *
 * Full-window onboarding overlay shown on first launch.
 * Unified single-surface layout with centered content.
 */

import { useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { ActionCard } from './ActionCard'
import { FolderPlus, FolderDown, BookOpen } from 'lucide-react'
import packageJson from '../../../package.json'

const ignoreDialogOpenChange = () => undefined

interface WelcomeScreenProps {
  open: boolean
  onComplete: () => void
  onLinkDevice: () => void
  onCreateProject: () => void
  onImportData: () => void
  onBrowseExamples: () => void
  onContinueAsGuest: () => void
}

export function WelcomeScreen({
  open,
  onComplete,
  onLinkDevice,
  onCreateProject,
  onImportData,
  onBrowseExamples,
  onContinueAsGuest,
}: WelcomeScreenProps) {
  const [dontShowAgain, setDontShowAgain] = useState(false)

  const handleAction = (action: () => void) => {
    if (dontShowAgain) {
      localStorage.setItem('hasSeenWelcome', 'true')
    }
    action()
    onComplete()
  }

  const handleContinueAsGuest = () => {
    if (dontShowAgain) {
      localStorage.setItem('hasSeenWelcome', 'true')
    }
    onContinueAsGuest()
    onComplete()
  }

  const handleLinkDevice = () => {
    onLinkDevice()
  }

  return (
    <Dialog open={open} onOpenChange={ignoreDialogOpenChange}>
      <DialogContent
        className="max-w-[900px] w-[85vw] h-auto max-h-[calc(100dvh-2rem)] p-0 overflow-hidden border-0 bg-transparent shadow-none"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Welcome to easyCris</DialogTitle>
        <DialogDescription className="sr-only">
          Choose how you want to begin, including optional account linking or guest mode.
        </DialogDescription>
        {/* Container with Subtle Tint */}
        <div
          className="relative flex flex-col rounded-2xl overflow-hidden shadow-2xl max-h-[calc(100dvh-3rem)]"
          style={{
            background: 'linear-gradient(to bottom, #f8f9ff 0%, #ffffff 100%)',
          }}
        >
          {/* App Icon */}
          <img
            src="/easycris.png"
            srcSet="/easycris.png 1x, /easycris.png 2x"
            alt="easyCris"
            className="absolute left-6 top-6 h-10 w-10"
          />

          {/* Header Section - Brand and Suites */}
          <div className="flex flex-col items-center gap-4 px-12 pt-10 pb-8 border-b border-border/30">

            {/* Brand Name */}
            <h1 className="text-3xl font-semibold tracking-tight">easyCris</h1>

            {/* Version */}
            <p className="text-muted-foreground text-sm">Version {packageJson.version}</p>

            {/* Suite Pills - Subtle */}
            <div className="flex items-center gap-3">
              <span className="px-3 py-1 rounded-full bg-muted/60 text-muted-foreground text-xs font-medium">
                Statistical Analysis Suite
              </span>
              <span className="px-3 py-1 rounded-full bg-muted/60 text-muted-foreground text-xs font-medium">
                Bulk RNA-seq Analysis Suite
              </span>
            </div>
          </div>

          {/* Main Content - Heading and Action Cards */}
          <div className="flex-1 min-h-0 overflow-y-auto px-6 sm:px-12 py-8 sm:py-10">
            {/* Heading */}
            <div className="text-center space-y-3">
              <h2 className="text-3xl font-semibold tracking-tight">Let&apos;s Get Started</h2>
              <p className="text-muted-foreground text-base">
                Choose how you&apos;d like to begin your analysis journey with easyCris
              </p>
            </div>

            <div className="mt-6 flex flex-col items-center gap-3">
              <div className="flex w-full max-w-xl flex-col gap-3 sm:flex-row sm:justify-center">
                <Button size="lg" className="sm:min-w-[220px]" onClick={handleLinkDevice}>
                  Link this device
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  className="sm:min-w-[220px]"
                  onClick={handleContinueAsGuest}
                >
                  Continue as guest
                </Button>
              </div>
              <p className="text-center text-sm text-muted-foreground">
                You can link this device later from Preferences &gt; Account.
              </p>
            </div>

            {/* Action Cards - 2-column grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-8">
              <ActionCard
                icon={<FolderPlus className="h-6 w-6" />}
                title="Create New Project"
                description="Start fresh with a new analysis project"
                onClick={() => handleAction(onCreateProject)}
              />
              <ActionCard
                icon={<FolderDown className="h-6 w-6" />}
                title="Import Data"
                description="Load your CSV, Excel, or other data files"
                onClick={() => handleAction(onImportData)}
              />
              <ActionCard
                icon={<BookOpen className="h-6 w-6" />}
                title="Browse Examples"
                description="Explore sample datasets and workflows"
                onClick={() => handleAction(onBrowseExamples)}
                className="col-span-1 sm:col-span-2"
              />
            </div>
          </div>

          {/* Footer - Checkbox and Buttons */}
          <div className="space-y-4 px-12 pb-10 pt-6 border-t border-border/50">
            {/* Checkbox */}
            <div className="flex items-center justify-center space-x-2">
              <Checkbox
                id="dont-show"
                checked={dontShowAgain}
                onCheckedChange={(checked) => setDontShowAgain(checked === true)}
              />
              <Label
                htmlFor="dont-show"
                className="text-sm font-normal cursor-pointer"
              >
                Don&apos;t show this welcome screen again
              </Label>
            </div>

            <p className="text-center text-sm text-muted-foreground">
              You can link this device now or continue in guest mode and sign in later from
              Preferences &gt; Account.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
