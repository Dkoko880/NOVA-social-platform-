export type PendingLiveRecording = {
  liveId: string
  ownerUserId: string
  blob: Blob
  durationSeconds: number
  mediaUrl?: string
  contentType?: string
  status?: 'FINALIZED' | 'UPLOADING' | 'UPLOADED' | 'PUBLISHED'
  updatedAt: number
}

type StoredLiveRecording = PendingLiveRecording & { key: string }

const databaseName = 'nova-live-recordings'
const objectStoreName = 'pending-recordings'

function openDatabase() {
  if (!globalThis.indexedDB) return Promise.reject(new Error('This browser does not support saving pending live recordings.'))

  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = globalThis.indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(objectStoreName, { keyPath: 'key' })
      store.createIndex('ownerUserId', 'ownerUserId')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Pending live recording storage could not be opened.'))
    request.onblocked = () => reject(new Error('Pending live recording storage is blocked by another open tab.'))
  })
}

async function transact<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
) {
  const database = await openDatabase()
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(objectStoreName, mode)
    const request = operation(transaction.objectStore(objectStoreName))
    let result: T
    request.onsuccess = () => { result = request.result }
    request.onerror = () => reject(request.error ?? new Error('Pending live recording storage failed.'))
    transaction.oncomplete = () => {
      database.close()
      resolve(result!)
    }
    transaction.onerror = () => {
      database.close()
      reject(transaction.error ?? new Error('Pending live recording storage failed.'))
    }
    transaction.onabort = () => {
      database.close()
      reject(transaction.error ?? new Error('Pending live recording storage was interrupted.'))
    }
  })
}

export async function savePendingLiveRecording(recording: PendingLiveRecording) {
  const value: StoredLiveRecording = {
    ...recording,
    key: `${recording.ownerUserId}:${recording.liveId}`,
    updatedAt: Date.now(),
  }
  await transact('readwrite', (store) => store.put(value))
}

export async function getPendingLiveRecordings(ownerUserId: string) {
  const recordings = await transact<StoredLiveRecording[]>('readonly', (store) =>
    store.index('ownerUserId').getAll(ownerUserId),
  )
  return recordings.sort((left, right) => right.updatedAt - left.updatedAt)
}

export async function deletePendingLiveRecording(ownerUserId: string, liveId: string) {
  await transact('readwrite', (store) => store.delete(`${ownerUserId}:${liveId}`))
}
