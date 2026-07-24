/**
 * BrandPanel Component
 *
 * Left side of welcome screen with branding and suite names.
 * Clean, minimal design per requirements.
 */

import packageJson from '../../../package.json'

export function BrandPanel() {
  return (
    <div
      className="flex h-full flex-col gap-8 p-10 text-white"
      style={{
        background: 'linear-gradient(165deg, #22307f 0%, #2f3fb3 55%, #4151d7 100%)',
      }}
    >
      <div className="space-y-3">
        {/* Logo/Title */}
        <h1 className="text-5xl font-semibold tracking-tight">easyCris</h1>

        {/* Version */}
        <p className="text-white/70 text-sm">Version {packageJson.version}</p>
      </div>

      <div className="space-y-3">
        <div className="text-xs uppercase tracking-[0.22em] text-white/60">
          Suites
        </div>
        <div className="space-y-2 text-white/90 text-base">
          <div className="rounded-xl border border-white/15 bg-white/5 px-4 py-2">
            Statistical Analysis Suite
          </div>
          <div className="rounded-xl border border-white/15 bg-white/5 px-4 py-2">
            Bulk RNA-seq Analysis Suite
          </div>
        </div>
      </div>
    </div>
  )
}
