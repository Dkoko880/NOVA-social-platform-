import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loginUser, logoutUser } from '../src/lib/auth'
import { openAuthenticatedEventStream } from '../src/lib/eventStream'
import { storeAccessToken } from '../src/lib/session'

const storedValues = new Map<string, string>()
const storage = {
  getItem: (key: string) => storedValues.get(key) ?? null,
  setItem: (key: string, value: string) => storedValues.set(key, value),
  removeItem: (key: string) => storedValues.delete(key),
  clear: () => storedValues.clear(),
  key: (index: number) => [...storedValues.keys()][index] ?? null,
  get length() {
    return storedValues.size
  },
}

function createToken() {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
  return `header.${payload}.signature`
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('browser authentication session', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>

  beforeEach(() => {
    storedValues.clear()
    fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('persists login for a fresh /me request after module reload, then clears it on logout and revocation', async () => {
    const token = createToken()
    const user = { id: 'user_1', email: 'user@example.com', name: 'Nova User' }
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ user, token }))
      .mockResolvedValueOnce(jsonResponse({ user }))
      .mockResolvedValueOnce(jsonResponse({ message: 'Logged out successfully.' }))
      .mockResolvedValueOnce(jsonResponse({ user, token }))
      .mockResolvedValueOnce(jsonResponse({ message: 'Authentication required.' }, 401))

    await loginUser({ identifier: 'user@example.com', password: 'never-log-this-password' })
    expect([...storedValues.values()]).toContain(token)
    expect(fetchMock.mock.calls[0][1]?.credentials).toBe('include')
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).has('Authorization')).toBe(false)

    vi.resetModules()
    const refreshedAuth = await import('../src/lib/auth')
    expect((await refreshedAuth.getCurrentUser())?.id).toBe(user.id)
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('Authorization')).toBe(`Bearer ${token}`)
    expect(fetchMock.mock.calls[1][1]?.credentials).toBe('include')

    await logoutUser()
    expect(new Headers(fetchMock.mock.calls[2][1]?.headers).get('Authorization')).toBe(`Bearer ${token}`)
    expect(storedValues.size).toBe(0)

    await refreshedAuth.loginUser({ identifier: 'user@example.com', password: 'never-log-this-password' })
    expect((await refreshedAuth.getCurrentUser())).toBeNull()
    expect(storedValues.size).toBe(0)
  })

  it('discards a locally stored token after its JWT expiry', async () => {
    const expiredPayload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 1 }))
    storage.setItem('novakoko.auth.access-token', `header.${expiredPayload}.signature`)

    vi.resetModules()
    const { getCurrentUser } = await import('../src/lib/auth')
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'Authentication required.' }, 401))

    expect(await getCurrentUser()).toBeNull()
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')).toBeNull()
    expect(storedValues.size).toBe(0)
  })

  it('sends the persisted bearer session on authenticated real-time streams', async () => {
    const token = createToken()
    storeAccessToken(token)
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode('event: ready\ndata: {"connected":true}\n\n'))
      },
    })))

    const stream = openAuthenticatedEventStream('/api/realtime')
    let readyEventData = ''
    stream.addEventListener('ready', (event) => { readyEventData = event.data })

    await vi.waitFor(() => expect(readyEventData).toBe('{"connected":true}'))
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')).toBe(`Bearer ${token}`)
    expect(fetchMock.mock.calls[0][1]?.credentials).toBe('include')
    stream.close()
  })
})
