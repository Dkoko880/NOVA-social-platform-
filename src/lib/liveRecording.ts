const finalizations = new WeakMap<MediaRecorder, Promise<Blob>>()

export function finalizeLiveRecording(recorder: MediaRecorder, chunks: Blob[]) {
  const existing = finalizations.get(recorder)
  if (existing) return existing

  const finalized = new Promise<Blob>((resolve, reject) => {
    const cleanup = () => {
      recorder.removeEventListener('stop', onStop)
      recorder.removeEventListener('error', onError)
    }
    const onStop = () => {
      cleanup()
      const blob = new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type || 'video/webm' })
      if (!blob.size) reject(new Error('The recording was empty; no replay was saved.'))
      else resolve(blob)
    }
    const onError = () => {
      cleanup()
      reject(new Error('The browser could not finalize the live recording.'))
    }

    recorder.addEventListener('stop', onStop, { once: true })
    recorder.addEventListener('error', onError, { once: true })
    if (recorder.state === 'inactive') {
      onStop()
      return
    }
    try {
      recorder.stop()
    } catch (error) {
      cleanup()
      reject(error instanceof Error ? error : new Error('The browser could not stop the live recording.'))
    }
  })
  finalizations.set(recorder, finalized)
  return finalized
}