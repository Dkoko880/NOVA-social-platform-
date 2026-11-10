import { describe, expect, it, vi } from 'vitest'
import { finalizeLiveRecording } from '../src/lib/liveRecording'

class TestRecorder extends EventTarget {
  state: RecordingState = 'recording'
  mimeType = 'video/webm'
  stop = vi.fn(() => {
    this.dispatchEvent(new MessageEvent('dataavailable', { data: new Blob(['final'], { type: this.mimeType }) }))
    this.state = 'inactive'
    this.dispatchEvent(new Event('stop'))
  })
}

describe('live recording finalization', () => {
  it('waits for the final dataavailable chunk before assembling the recording', async () => {
    const recorder = new TestRecorder()
    const chunks = [new Blob(['first'], { type: recorder.mimeType })]
    recorder.addEventListener('dataavailable', (event) => {
      const data = (event as MessageEvent<Blob>).data
      if (data.size) chunks.push(data)
    })

    const recording = await finalizeLiveRecording(recorder as unknown as MediaRecorder, chunks)

    expect(await recording.text()).toBe('firstfinal')
    expect(recorder.stop).toHaveBeenCalledTimes(1)
  })

  it('shares one finalization promise when stop is requested repeatedly', async () => {
    const recorder = new TestRecorder()
    const chunks = [new Blob(['recording'], { type: recorder.mimeType })]
    const first = finalizeLiveRecording(recorder as unknown as MediaRecorder, chunks)
    const second = finalizeLiveRecording(recorder as unknown as MediaRecorder, chunks)

    expect(second).toBe(first)
    await first
    expect(recorder.stop).toHaveBeenCalledTimes(1)
  })

  it('reports an empty finalized recording as unavailable', async () => {
    const recorder = new TestRecorder()
    recorder.stop.mockImplementation(() => {
      recorder.state = 'inactive'
      recorder.dispatchEvent(new Event('stop'))
    })

    await expect(finalizeLiveRecording(recorder as unknown as MediaRecorder, [])).rejects.toThrow('recording was empty')
  })
})