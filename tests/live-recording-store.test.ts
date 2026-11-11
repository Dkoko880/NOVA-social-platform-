// @vitest-environment happy-dom

import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { deletePendingLiveRecording, getPendingLiveRecordings, savePendingLiveRecording } from '../src/lib/liveRecordingStore'

function deleteRecordingDatabase() {
  return new Promise<void>((resolve, reject) => {
    const request = globalThis.indexedDB.deleteDatabase('nova-live-recordings')
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('The live recording database is still open.'))
  })
}

afterEach(async () => {
  await deleteRecordingDatabase()
})

describe('pending live recording storage', () => {
  it('restores uploads after refresh, isolates accounts, and removes completed recordings', async () => {
    const pending = {
      liveId: 'live-1',
      ownerUserId: 'host-1',
      blob: new Blob(['recording'], { type: 'video/webm' }),
      durationSeconds: 30,
      updatedAt: 1,
    }

    await savePendingLiveRecording(pending)
    expect(await getPendingLiveRecordings('other-user')).toEqual([])

    await savePendingLiveRecording({ ...pending, mediaUrl: '/api/media/files/replay.webm', contentType: 'video/webm' })
    expect(await getPendingLiveRecordings('host-1')).toMatchObject([
      { liveId: 'live-1', mediaUrl: '/api/media/files/replay.webm', contentType: 'video/webm' },
    ])

    await deletePendingLiveRecording('host-1', 'live-1')
    expect(await getPendingLiveRecordings('host-1')).toEqual([])
  })
})
