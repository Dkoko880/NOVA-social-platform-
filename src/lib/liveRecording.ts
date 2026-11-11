export type LiveRecording = {
  recordingId: string
  liveId: string
  title: string
  mimeType: string
  status: 'recording' | 'pending'
  chunkCount: number
  updatedAt: number
  chunks: Blob[]
}

type StoredLiveRecording = Omit<LiveRecording, 'chunks'>
type StoredLiveRecordingChunk = { recordingId: string; index: number; blob: Blob }

const databaseName = 'nova-live-recordings-v1'
const recordingsStore = 'recordings'
const chunksStore = 'chunks'
let databasePromise: Promise<IDBDatabase> | null = null

function openDatabase() {
  if (!('indexedDB' in window)) return Promise.reject(new Error('This browser cannot store a recovery copy of the live recording.'))
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1)
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains(recordingsStore)) database.createObjectStore(recordingsStore, { keyPath: 'recordingId' })
        if (!database.objectStoreNames.contains(chunksStore)) database.createObjectStore(chunksStore, { keyPath: ['recordingId', 'index'] })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('Unable to open local recording storage.'))
      request.onblocked = () => reject(new Error('Close other NOVAKOKO tabs to open local recording storage.'))
    })
  }
  return databasePromise
}

function transactionComplete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('Local recording storage failed.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('Local recording storage was interrupted.'))
  })
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Local recording storage failed.'))
  })
}

export function createRecordingId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const value = Math.floor(Math.random() * 16)
    return (character === 'x' ? value : (value & 0x3) | 0x8).toString(16)
  })
}

export async function beginLiveRecording(recording: Omit<StoredLiveRecording, 'status' | 'chunkCount' | 'updatedAt'>) {
  const database = await openDatabase()
  const transaction = database.transaction(recordingsStore, 'readwrite')
  const completed = transactionComplete(transaction)
  transaction.objectStore(recordingsStore).put({ ...recording, status: 'recording', chunkCount: 0, updatedAt: Date.now() } satisfies StoredLiveRecording)
  await completed
}

export async function appendLiveRecordingChunk(recordingId: string, blob: Blob) {
  const database = await openDatabase()
  const transaction = database.transaction([recordingsStore, chunksStore], 'readwrite')
  const completed = transactionComplete(transaction)
  const recordings = transaction.objectStore(recordingsStore)
  const current = await requestResult(recordings.get(recordingId)) as StoredLiveRecording | undefined
  if (!current) {
    transaction.abort()
    await completed.catch(() => undefined)
    throw new Error('The local recording session is missing; its saved chunks were preserved.')
  }
  transaction.objectStore(chunksStore).put({ recordingId, index: current.chunkCount, blob } satisfies StoredLiveRecordingChunk)
  recordings.put({ ...current, chunkCount: current.chunkCount + 1, updatedAt: Date.now() })
  await completed
}

export async function markLiveRecordingPending(recordingId: string) {
  const database = await openDatabase()
  const transaction = database.transaction(recordingsStore, 'readwrite')
  const completed = transactionComplete(transaction)
  const store = transaction.objectStore(recordingsStore)
  const current = await requestResult(store.get(recordingId)) as StoredLiveRecording | undefined
  if (current) store.put({ ...current, status: 'pending', updatedAt: Date.now() })
  await completed
}

export async function getPendingLiveRecordings() {
  const database = await openDatabase()
  const transaction = database.transaction([recordingsStore, chunksStore], 'readonly')
  const completed = transactionComplete(transaction)
  const [recordings, chunks] = await Promise.all([
    requestResult(transaction.objectStore(recordingsStore).getAll()) as Promise<StoredLiveRecording[]>,
    requestResult(transaction.objectStore(chunksStore).getAll()) as Promise<StoredLiveRecordingChunk[]>,
  ])
  await completed
  const byRecording = new Map<string, Blob[]>()
  for (const chunk of chunks) {
    const saved = byRecording.get(chunk.recordingId) ?? []
    saved[chunk.index] = chunk.blob
    byRecording.set(chunk.recordingId, saved)
  }
  return recordings.filter((recording) => recording.chunkCount > 0).map((recording) => ({
    ...recording,
    status: 'pending' as const,
    chunks: byRecording.get(recording.recordingId)?.filter((chunk): chunk is Blob => Boolean(chunk)) ?? [],
  }))
}

export async function deleteLiveRecording(recordingId: string) {
  const database = await openDatabase()
  const transaction = database.transaction([recordingsStore, chunksStore], 'readwrite')
  const completed = transactionComplete(transaction)
  transaction.objectStore(recordingsStore).delete(recordingId)
  const range = IDBKeyRange.bound([recordingId, 0], [recordingId, Number.MAX_SAFE_INTEGER])
  const cursorRequest = transaction.objectStore(chunksStore).openCursor(range)
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result
    if (!cursor) return
    cursor.delete()
    cursor.continue()
  }
  await completed
}