import { lazy, Suspense } from 'react'
import { FileSpreadsheet, MonitorUp, Palette, ShieldUser } from 'lucide-react'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@/components/ui/sidebar'
import { type PreferencesPane, useUIStore } from '@/store/ui-store'
import { AppearancePane } from './panes/AppearancePane'
import { AccountPane } from './panes/AccountPane'
import { PowerPointPane } from './panes/PowerPointPane'

const RemoteSessionPane = lazy(() => import('./panes/RemoteSessionPane'))

const navigationItems = [
  {
    id: 'account' as const,
    name: 'Account',
    icon: ShieldUser,
  },
  {
    id: 'appearance' as const,
    name: 'Appearance',
    icon: Palette,
  },
  {
    id: 'powerpoint' as const,
    name: 'PowerPoint',
    icon: FileSpreadsheet,
  },
  {
    id: 'remote' as const,
    name: 'Remote',
    icon: MonitorUp,
  },
]

const getPaneTitle = (pane: PreferencesPane): string => {
  switch (pane) {
    case 'account':
      return 'Account'
    case 'appearance':
      return 'Appearance'
    case 'powerpoint':
      return 'PowerPoint'
    case 'remote':
      return 'Remote'
    default:
      return 'Account'
  }
}

export function PreferencesDialog() {
  const {
    preferencesOpen,
    setPreferencesOpen,
    activePreferencesPane,
    setActivePreferencesPane,
  } = useUIStore()
  const activePane: PreferencesPane = activePreferencesPane

  return (
    <Dialog open={preferencesOpen} onOpenChange={setPreferencesOpen}>
      <DialogContent className="overflow-hidden p-0 md:max-h-[600px] md:max-w-[900px] lg:max-w-[1000px] font-sans rounded-xl">
        <DialogTitle className="sr-only">Preferences</DialogTitle>
        <DialogDescription className="sr-only">
          Customize your application preferences here.
        </DialogDescription>

        <SidebarProvider className="items-start">
          <Sidebar collapsible="none" className="hidden md:flex">
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {navigationItems.map(item => (
                      <SidebarMenuItem key={item.id}>
                        <SidebarMenuButton
                          asChild
                          isActive={activePane === item.id}
                        >
                          <button
                            onClick={() => setActivePreferencesPane(item.id)}
                            className="w-full"
                            data-testid={`preferences-nav-${item.id}`}
                          >
                            <item.icon />
                            <span>{item.name}</span>
                          </button>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
          </Sidebar>

          <main className="flex flex-1 flex-col overflow-hidden">
            <header className="flex h-16 shrink-0 items-center gap-2">
              <div className="flex items-center gap-2 px-4">
                <Breadcrumb>
                  <BreadcrumbList>
                    <BreadcrumbItem className="hidden md:block">
                      <BreadcrumbLink href="#">Preferences</BreadcrumbLink>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator className="hidden md:block" />
                    <BreadcrumbItem>
                      <BreadcrumbPage>
                        {getPaneTitle(activePane)}
                      </BreadcrumbPage>
                    </BreadcrumbItem>
                  </BreadcrumbList>
                </Breadcrumb>
              </div>
            </header>

            <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4 pt-0 max-h-[calc(600px-4rem)]">
              {activePane === 'account' && <AccountPane />}
              {activePane === 'appearance' && <AppearancePane />}
              {activePane === 'powerpoint' && <PowerPointPane />}
              {activePane === 'remote' && (
                <Suspense fallback={null}>
                  <RemoteSessionPane />
                </Suspense>
              )}
            </div>
          </main>
        </SidebarProvider>
      </DialogContent>
    </Dialog>
  )
}

export default PreferencesDialog
