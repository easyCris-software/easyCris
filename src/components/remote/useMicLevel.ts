import { useEffect, useState } from 'react'

const MIC_LEVEL_UPDATE_INTERVAL_MS = 80
const MIC_LEVEL_CHANGE_EPSILON = 0.02

export function useMicLevel(stream: MediaStream | null, active: boolean) {
  const [level, setLevel] = useState(0)

  useEffect(() => {
    if (!stream || !active) {
      setLevel(0)
      return
    }

    const AudioContextCtor = globalThis.AudioContext
    if (!AudioContextCtor) {
      setLevel(0)
      return
    }

    const audioContext = new AudioContextCtor()
    const analyser = audioContext.createAnalyser()
    analyser.fftSize = 256
    const source = audioContext.createMediaStreamSource(stream)
    const samples = new Uint8Array(analyser.fftSize)
    let frameId: number | null = null
    let lastUpdate = 0
    let lastLevel = 0
    source.connect(analyser)
    if (audioContext.state === 'suspended') {
      void audioContext.resume().catch(() => undefined)
    }

    const tick = (now: number) => {
      analyser.getByteTimeDomainData(samples)
      let sum = 0
      for (const sample of samples) {
        const centered = (sample - 128) / 128
        sum += centered * centered
      }
      const rms = Math.sqrt(sum / samples.length)
      const nextLevel = Math.min(1, rms * 3)
      if (
        now - lastUpdate >= MIC_LEVEL_UPDATE_INTERVAL_MS &&
        Math.abs(nextLevel - lastLevel) >= MIC_LEVEL_CHANGE_EPSILON
      ) {
        lastUpdate = now
        lastLevel = nextLevel
        setLevel(Number(nextLevel.toFixed(2)))
      }
      frameId = window.requestAnimationFrame(tick)
    }

    frameId = window.requestAnimationFrame(tick)
    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId)
      }
      source.disconnect()
      analyser.disconnect()
      void audioContext.close()
    }
  }, [active, stream])

  return level
}
