import { describe, expect, it } from 'vitest'
import { formatRecordingDuration, getVoiceRecordingGesture } from '../src/lib/voiceRecordingGesture'

describe('voice recording gestures', () => {
  it('keeps a normal press held, locks on an upward slide, and cancels on a left slide', () => {
    const origin = { x: 120, y: 240 }
    expect(getVoiceRecordingGesture(origin, { x: 130, y: 235 })).toBe('none')
    expect(getVoiceRecordingGesture(origin, { x: 120, y: 167 })).toBe('lock')
    expect(getVoiceRecordingGesture(origin, { x: 39, y: 240 })).toBe('cancel')
  })

  it('formats elapsed recording time for the recording interface', () => {
    expect(formatRecordingDuration(0)).toBe('0:00')
    expect(formatRecordingDuration(125)).toBe('2:05')
  })
})
