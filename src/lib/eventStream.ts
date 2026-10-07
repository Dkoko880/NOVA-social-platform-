import { API_BASE_URL } from './api'
import { clearStoredAccessToken, getStoredAccessToken } from './session'

type RealtimeListener = (event: MessageEvent<string>) => void

export function openAuthenticatedEventStream(path: string) {
  const controller = new AbortController()
  const listeners = new Map<string, Set<RealtimeListener>>()
  let closed = false
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined

  const dispatch = (eventName: string, data: string[]) => {
    if (data.length === 0) return
    const event = new MessageEvent<string>(eventName, { data: data.join('\n') })
    for (const listener of listeners.get(eventName) ?? []) listener(event)
  }

  const connect = async () => {
    let retryDelay = 1000

    while (!closed) {
      try {
        const headers = new Headers()
        const token = getStoredAccessToken()
        if (token) headers.set('Authorization', `Bearer ${token}`)

        const response = await fetch(`${API_BASE_URL}${path}`, {
          credentials: 'include',
          headers,
          signal: controller.signal,
        })

        if (response.status === 401) {
          clearStoredAccessToken()
        }
        if (!response.ok || !response.body) {
          throw new Error(`The real-time API returned status ${response.status}.`)
        }

        retryDelay = 1000
        activeReader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let eventName = 'message'
        let data: string[] = []

        while (!closed) {
          const { done, value } = await activeReader.read()
          buffer += decoder.decode(value, { stream: !done })
          const lines = buffer.split(/\r?\n/)
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (!line) {
              dispatch(eventName, data)
              eventName = 'message'
              data = []
            } else if (line.startsWith('event:')) {
              eventName = line.slice(6).trimStart()
            } else if (line.startsWith('data:')) {
              data.push(line.slice(5).replace(/^ /, ''))
            }
          }

          if (done) break
        }
        activeReader.releaseLock()
        activeReader = undefined
      } catch {
        if (closed || controller.signal.aborted) return
      }

      if (closed) return
      await new Promise<void>((resolve) => {
        let timeout: ReturnType<typeof setTimeout>
        const onAbort = () => {
          clearTimeout(timeout)
          resolve()
        }
        timeout = setTimeout(() => {
          controller.signal.removeEventListener('abort', onAbort)
          resolve()
        }, retryDelay)
        controller.signal.addEventListener('abort', onAbort, { once: true })
      })
      retryDelay = Math.min(retryDelay * 2, 30_000)
    }
  }

  void connect()

  return {
    addEventListener(eventName: string, listener: RealtimeListener) {
      const bucket = listeners.get(eventName) ?? new Set<RealtimeListener>()
      bucket.add(listener)
      listeners.set(eventName, bucket)
    },
    close() {
      closed = true
      controller.abort()
      void activeReader?.cancel()
    },
  }
}
