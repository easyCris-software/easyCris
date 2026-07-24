import { useCallback, useState } from 'react'
import {
  listRemoteAudioInputDevices,
  type RemoteAudioInputDevice,
} from '@/services/remoteAudioMedia'

export function useRemoteAudioInputDevices() {
  const [audioInputDevices, setAudioInputDevices] = useState<
    RemoteAudioInputDevice[]
  >([])
  const [selectedAudioInputDeviceId, setSelectedAudioInputDeviceId] =
    useState('')

  const refreshAudioInputDevices = useCallback(async () => {
    try {
      const devices = await listRemoteAudioInputDevices()
      setAudioInputDevices(previousDevices => {
        if (
          previousDevices.length === devices.length &&
          previousDevices.every(
            (device, index) =>
              device.deviceId === devices[index]?.deviceId &&
              device.label === devices[index]?.label
          )
        ) {
          return previousDevices
        }
        return devices
      })
    } catch {
      // Safe to retry silently: successful audio enable re-enumerates after permission is granted.
    }
  }, [])

  return {
    audioInputDevices,
    refreshAudioInputDevices,
    selectedAudioInputDeviceId,
    setSelectedAudioInputDeviceId,
  }
}
