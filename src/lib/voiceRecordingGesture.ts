export type PointerPosition = { x: number; y: number }
export type VoiceRecordingGesture = 'cancel' | 'lock' | 'none'

export function getVoiceRecordingGesture(origin: PointerPosition, current: PointerPosition): VoiceRecordingGesture {
  const horizontalDistance = current.x - origin.x
  const verticalDistance = current.y - origin.y
  if (horizontalDistance <= -80) return 'cancel'
  if (verticalDistance <= -72) return 'lock'
  return 'none'
}

export function formatRecordingDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`
}
