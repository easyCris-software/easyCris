import { spawnSync } from 'node:child_process'

// On Windows, spawning .cmd/.bat directly can fail; `shell: true` avoids that.
// Build in explicit E2E mode and isolate output to dist-e2e
// so release validation against dist/ cannot be contaminated.
const res = spawnSync('npm run build -- --mode e2e --outDir dist-e2e', {
  stdio: 'inherit',
  shell: true,
})
process.exit(res.status ?? 1)
