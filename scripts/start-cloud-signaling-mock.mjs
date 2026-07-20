import { startCloudSignalingMockServer } from '../e2e/utils/cloud-signaling-mock.mjs'

const server = await startCloudSignalingMockServer()

console.log(`[remote-mock] Listening at ${server.baseUrl}`)
console.log('[remote-mock] Press Ctrl+C to stop')

let closing = false
async function close() {
  if (closing) {
    return
  }
  closing = true
  await server.close()
}

process.on('SIGINT', () => {
  close()
    .catch(error => {
      console.error(`[remote-mock] Failed to close: ${error.message}`)
      process.exitCode = 1
    })
    .finally(() => process.exit())
})

process.on('SIGTERM', () => {
  close()
    .catch(error => {
      console.error(`[remote-mock] Failed to close: ${error.message}`)
      process.exitCode = 1
    })
    .finally(() => process.exit())
})
