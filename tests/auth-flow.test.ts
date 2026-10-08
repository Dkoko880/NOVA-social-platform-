import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authSessionReducer, initialAuthSessionState } from '../src/lib/authSession'
import { apiRequest, ApiError } from '../src/lib/api'
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
    vi.restoreAllMocks()
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

  it('ends initial loading after a /me network failure so public auth routes remain reachable', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    const { getCurrentUser } = await import('../src/lib/auth')
    await expect(getCurrentUser()).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: null })
    expect(fetchMock).toHaveBeenCalledTimes(3)

    expect(authSessionReducer(initialAuthSessionState, {
      type: 'verification-failed',
      message: 'Unable to reach the API.',
    })).toEqual({
      user: null,
      isLoading: false,
      authError: 'Unable to reach the API.',
    })
  })

  it('preserves a known authenticated user when /me has a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

    const { getCurrentUser } = await import('../src/lib/auth')
    await expect(getCurrentUser()).rejects.toMatchObject({ code: 'NETWORK_ERROR', status: null })
    expect(fetchMock).toHaveBeenCalledTimes(3)

    const authenticatedState = {
      user: { id: 'user_1', email: 'user@example.com', name: 'Nova User' },
      isLoading: true,
      authError: null,
    }
    expect(authSessionReducer(authenticatedState, {
      type: 'verification-failed',
      message: 'Unable to reach the API.',
    })).toEqual({
      user: authenticatedState.user,
      isLoading: false,
      authError: 'Unable to reach the API.',
    })
  })

  it('ends initial loading after a /me timeout', async () => {
    fetchMock.mockRejectedValue(new DOMException('The request timed out.', 'TimeoutError'))

    const { getCurrentUser } = await import('../src/lib/auth')
    await expect(getCurrentUser()).rejects.toMatchObject({ code: 'TIMEOUT', status: null })
    expect(fetchMock).toHaveBeenCalledTimes(3)

    expect(authSessionReducer(initialAuthSessionState, {
      type: 'verification-failed',
      message: 'The request timed out.',
    })).toEqual({
      user: null,
      isLoading: false,
      authError: 'The request timed out.',
    })
  })

  it.each([401, 403])('clears the session after /me confirms HTTP %i', async (status) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'Authentication required.' }, status))
    const { getCurrentUser } = await import('../src/lib/auth')
    const user = { id: 'user_1', email: 'user@example.com', name: 'Nova User' }
    const invalidSessionUser = await getCurrentUser()

    expect(invalidSessionUser).toBeNull()
    expect(authSessionReducer({
      user,
      isLoading: true,
      authError: null,
    }, {
      type: 'verification-succeeded',
      user: invalidSessionUser,
    })).toEqual({ user: null, isLoading: false, authError: null })
  })

  it('updates the authenticated user after successful /me verification', async () => {
    const user = { id: 'user_2', email: 'updated@example.com', name: 'Updated User' }
    fetchMock.mockResolvedValueOnce(jsonResponse({ user }))
    const { getCurrentUser } = await import('../src/lib/auth')
    const verifiedUser = await getCurrentUser()

    expect(authSessionReducer(initialAuthSessionState, {
      type: 'verification-succeeded',
      user: verifiedUser,
    })).toEqual({ user, isLoading: false, authError: null })
  })

  it('classifies HTTP errors for other API consumers without logging credentials', async () => {
    const token = createToken()
    storeAccessToken(token)
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'Forbidden.' }, 403))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await expect(apiRequest('/api/posts')).rejects.toMatchObject({
      code: 'AUTH_ERROR',
      status: 403,
    } satisfies Partial<ApiError>)
    expect(consoleError).not.toHaveBeenCalled()
    expect(consoleWarn).not.toHaveBeenCalled()
    expect(consoleLog).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls[0][1]?.credentials).toBe('include')
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')).toBe(`Bearer ${token}`)

    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'Validation failed.' }, 422))
    await expect(apiRequest('/api/posts')).rejects.toMatchObject({
      code: 'API_ERROR',
      status: 422,
    })
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
