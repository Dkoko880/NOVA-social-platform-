// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'

const state = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  blocked: false,
}))

vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'viewer', name: 'Viewer' }, isLoading: false }),
}))

vi.mock('../src/lib/api', () => ({
  apiRequest: state.apiRequest,
  resolveMediaUrl: (url: string | null | undefined) => url ?? '',
  uploadMedia: vi.fn(),
}))

import { ProfilePage } from '../src/pages/ProfilePage'

let root: Root | null = null
let host: HTMLDivElement

function LocationText() {
  const location = useLocation()
  return <p data-testid="location">{location.pathname}{location.search}</p>
}

function profileRecord() {
  return {
    id: 'target-user',
    name: 'Target',
    handle: 'target',
    profile: { displayName: 'Target', username: 'target', bio: null },
    followerCount: 2,
    followingCount: 3,
    relationship: { isFollowing: false, blockedByMe: state.blocked, blockedMe: false },
  }
}

async function renderProfile() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={['/profile/target-user']}>
        <Routes>
          <Route path="/profile/:id" element={<ProfilePage />} />
          <Route path="/messages" element={<LocationText />} />
        </Routes>
      </MemoryRouter>,
    )
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  state.blocked = false
  state.apiRequest.mockReset().mockImplementation(async (path: string, options?: RequestInit) => {
    if (path === '/api/users/target-user') return { user: profileRecord() }
    if (path === '/api/posts?limit=100') return { posts: [] }
    if (path === '/api/conversations' && options?.method === 'POST') return { conversation: { id: 'private-chat' } }
    return {}
  })
})

afterEach(async () => {
  if (root) await act(async () => { root?.unmount() })
  root = null
  host?.remove()
})

describe('profile message button', () => {
  it('resolves and opens the correct direct conversation', async () => {
    await renderProfile()
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Message')
    expect(button).toBeTruthy()
    await click(button!)

    expect(state.apiRequest).toHaveBeenCalledWith('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ participantId: 'target-user' }),
    })
    expect(host.querySelector('[data-testid="location"]')?.textContent).toBe('/messages?conversationId=private-chat')
  })

  it('disables messaging when either user has blocked the other', async () => {
    state.blocked = true
    await renderProfile()
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'Message')
    expect(button).toBeTruthy()
    expect((button as HTMLButtonElement).disabled).toBe(true)
    await click(button!)
    expect(state.apiRequest).not.toHaveBeenCalledWith('/api/conversations', expect.anything())
  })
})
