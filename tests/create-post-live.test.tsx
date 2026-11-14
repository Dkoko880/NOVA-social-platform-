// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  roomConnect: vi.fn(),
  roomDisconnect: vi.fn(),
  setMicrophoneEnabled: vi.fn(),
  setCameraEnabled: vi.fn(),
  streamAddEventListener: vi.fn(),
  streamClose: vi.fn(),
}))

vi.mock('../src/lib/api', () => ({
  apiRequest: mocks.apiRequest,
  resolveMediaUrl: (url: string) => url,
  uploadMedia: vi.fn(),
  uploadMessageAttachment: vi.fn(),
  uploadVideo: vi.fn(),
}))
vi.mock('../src/lib/eventStream', () => ({
  openAuthenticatedEventStream: () => ({
    addEventListener: mocks.streamAddEventListener,
    close: mocks.streamClose,
  }),
}))
vi.mock('../src/components/PostMedia', () => ({
  PostMedia: ({ url, alt }: { url: string; alt: string }) => <video src={url} aria-label={alt} />,
}))
vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'creator-1', name: 'Test Creator', email: 'creator@example.test' } }),
}))
vi.mock('livekit-client', () => ({
  Room: class {
    on = vi.fn()
    connect = mocks.roomConnect
    disconnect = mocks.roomDisconnect
    startAudio = vi.fn()
    localParticipant = {
      setMicrophoneEnabled: mocks.setMicrophoneEnabled,
      setCameraEnabled: mocks.setCameraEnabled,
      getTrackPublication: vi.fn(() => undefined),
    }
  },
  RoomEvent: {
    TrackSubscribed: 'trackSubscribed',
    TrackUnsubscribed: 'trackUnsubscribed',
    AudioPlaybackStatusChanged: 'audioPlaybackStatusChanged',
    VideoPlaybackStatusChanged: 'videoPlaybackStatusChanged',
    Reconnecting: 'reconnecting',
    Reconnected: 'reconnected',
    Disconnected: 'disconnected',
  },
}))

import { CreatePage } from '../src/pages/CreatePage'
import { HomePage } from '../src/pages/HomePage'
import { LivePage } from '../src/pages/LivePage'
import { PostCard } from '../src/components/PostCard'

function CurrentPath() {
  return <output data-testid="current-path">{useLocation().pathname}</output>
}

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  mocks.apiRequest.mockReset()
  mocks.apiRequest.mockImplementation(async (path: string) => {
    if (path === '/api/posts?limit=50') return { posts: [] }
    if (path === '/api/stories') return { stories: [] }
    if (path === '/api/users/creator-1') return { user: { profile: { avatarUrl: '/avatar.webp' } } }
    if (path === '/api/live/live-123/viewers/join') return { live: { id: 'live-123', viewerCount: 8 } }
    if (path === '/api/live/live-123/token') return { token: 'test-token', url: 'wss://media.example.test' }
    if (path === '/api/live/live-123/viewers/heartbeat') return { live: { id: 'live-123', viewerCount: 8 } }
    if (path === '/api/live/live-123') return { live: { comments: [] } }
    if (path === '/api/live/live-123/comment') return { comment: { id: 'comment-1', userId: 'viewer-1', text: 'Hello', createdAt: new Date().toISOString() } }
    if (path === '/api/live/live-123/react') return { reaction: { id: 'reaction-1' } }
    if (path === '/api/live/live-123/viewers/leave') return { left: true }
    return {}
  })
  mocks.roomConnect.mockReset().mockResolvedValue(undefined)
  mocks.roomDisconnect.mockReset().mockResolvedValue(undefined)
  mocks.setMicrophoneEnabled.mockReset().mockResolvedValue(undefined)
  mocks.setCameraEnabled.mockReset().mockResolvedValue(undefined)
  mocks.streamAddEventListener.mockReset()
  mocks.streamClose.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('Create Post entry point', () => {
  it('opens the dedicated responsive Create Post screen from the Home composer', async () => {
    await act(async () => {
      root.render(<MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/create" element={<CreatePage />} />
        </Routes>
        <CurrentPath />
      </MemoryRouter>)
      await Promise.resolve()
    })

    const openComposer = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes("What's on your mind?"))
    expect(openComposer).toBeDefined()
    await act(async () => {
      openComposer?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(host.querySelector('[data-testid="current-path"]')?.textContent).toBe('/create')
    expect(host.querySelector('h2')?.textContent).toBe('Create post')
    expect(host.textContent).toContain('Test Creator')
    expect(host.textContent).toContain('Photos/Videos')
    expect(host.textContent).toContain('Go live')
    const optionLabels = [...host.querySelectorAll('section button')]
      .map((button) => button.textContent?.trim())
      .filter((label) => ['Photos/Videos', 'Music', 'Tag people', 'Add location', 'Feeling/activity', 'Create Event', 'Go live'].includes(label ?? ''))
    expect(optionLabels).toEqual(['Photos/Videos', 'Music', 'Tag people', 'Add location', 'Feeling/activity', 'Create Event', 'Go live'])
    expect(host.querySelector('select[aria-label="Post privacy"]')).not.toBeNull()
    expect(host.querySelector('form')?.className).toContain('h-[100dvh]')
  })

  it('sends the selected background to the posts API', async () => {
    await act(async () => {
      root.render(<MemoryRouter initialEntries={['/create']}><CreatePage /></MemoryRouter>)
      await Promise.resolve()
    })

    const backgroundButton = host.querySelector<HTMLButtonElement>('button[aria-label="Purple gradient background"]')
    await act(async () => {
      backgroundButton?.click()
    })
    const content = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Post content"]')
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      valueSetter.call(content, 'A colorful update')
      content?.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    expect(mocks.apiRequest).toHaveBeenCalledWith('/api/posts', {
      method: 'POST',
      body: JSON.stringify({
        content: 'A colorful update',
        visibility: 'PUBLIC',
        background: 'linear-gradient(135deg, #d320e6, #663be4)',
      }),
    })
  })

  it('shows colored text posts with their saved background but leaves media posts unchanged', async () => {
    const post = {
      id: 'colored-1',
      author: { id: 'creator-1', name: 'Test Creator', handle: 'creator', avatar: '' },
      time: 'now',
      content: 'Centered text',
      background: '#c600ef',
      likes: 0,
      comments: 0,
      shares: 0,
      saved: 0,
    }

    await act(async () => {
      root.render(<MemoryRouter><PostCard post={post} /></MemoryRouter>)
      await Promise.resolve()
    })
    const coloredContent = host.querySelector<HTMLElement>('.colored-post-content')
    expect(coloredContent?.textContent).toBe('Centered text')
    expect(coloredContent?.style.background).toBe('#c600ef')

    const editButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Edit')
    await act(async () => {
      editButton?.click()
    })
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="Violet background"]')?.getAttribute('aria-pressed')).toBe('true')
    mocks.apiRequest.mockResolvedValueOnce({ post: { content: 'Updated text', imageUrl: null, background: '#c600ef', visibility: 'PUBLIC' } })
    await act(async () => {
      host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    expect(mocks.apiRequest).toHaveBeenCalledWith('/api/posts/colored-1', {
      method: 'PATCH',
      body: JSON.stringify({ content: 'Centered text', imageUrl: '', background: '#c600ef', visibility: 'PUBLIC' }),
    })

    await act(async () => {
      root.render(<MemoryRouter><PostCard post={{ ...post, id: 'media-1', image: '/photo.jpg' }} /></MemoryRouter>)
      await Promise.resolve()
    })
    expect(host.querySelector('.colored-post-content')).toBeNull()
  })

  it('plays a linked Feed broadcast inline through the authorized LiveKit join flow', async () => {
    await act(async () => {
      root.render(<MemoryRouter><PostCard post={{
        id: 'post-live',
        author: { id: 'creator-1', name: 'Test Creator', handle: 'creator', avatar: '' },
        time: 'now',
        content: 'Town hall',
        likes: 0,
        comments: 0,
        shares: 0,
        saved: 0,
        live: { id: 'live-123', title: 'Town hall', status: 'live', viewerCount: 7 },
      }} /></MemoryRouter>)
      await Promise.resolve()
    })

    expect(host.textContent).toContain('LIVE')
    expect(host.textContent).toContain('7 watching')
    const watchButton = [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Watch live')
    expect(watchButton).toBeDefined()
    await act(async () => {
      watchButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(mocks.apiRequest.mock.calls.map(([path]) => path)).toEqual(expect.arrayContaining([
      '/api/live/live-123/viewers/join',
      '/api/live/live-123/token',
      '/api/live/live-123/viewers/heartbeat',
    ]))
    expect(mocks.roomConnect).toHaveBeenCalledWith('wss://media.example.test', 'test-token')
    expect(host.querySelector('[aria-label="Live broadcast player"]')).not.toBeNull()
    expect(host.textContent).toContain('Connecting to live video…')
    const updateListener = mocks.streamAddEventListener.mock.calls.find(([eventName]) => eventName === 'live:update')?.[1]
    expect(updateListener).toBeTypeOf('function')
    await act(async () => {
      updateListener?.(new MessageEvent('live:update', { data: JSON.stringify({ live: { id: 'live-123', viewerCount: 11, status: 'live' } }) }))
      await Promise.resolve()
    })
    expect(host.textContent).toContain('11 watching')

    const commentInput = host.querySelector<HTMLInputElement>('input[aria-label="Live comment"]')
    expect(commentInput).not.toBeNull()
    const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      inputSetter.call(commentInput, 'Hello')
      commentInput?.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    const sendComment = host.querySelector<HTMLButtonElement>('button[aria-label="Send live comment"]')
    await act(async () => {
      sendComment?.click()
      await Promise.resolve()
    })
    expect(mocks.apiRequest).toHaveBeenCalledWith('/api/live/live-123/comment', {
      method: 'POST',
      body: JSON.stringify({ text: 'Hello' }),
    })
    expect(host.querySelector('[aria-label="Live comments"]')?.textContent).toContain('Hello')

    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="Like live broadcast"]')?.click()
      await Promise.resolve()
    })
    expect(mocks.apiRequest).toHaveBeenCalledWith('/api/live/live-123/react', {
      method: 'POST',
      body: JSON.stringify({ type: 'LIKE' }),
    })
  })

  it('plays an available replay from the original ended live Feed post', async () => {
    await act(async () => {
      root.render(<MemoryRouter><PostCard post={{
        id: 'post-live-replay',
        author: { id: 'creator-1', name: 'Test Creator', handle: 'creator', avatar: '' },
        time: 'now',
        content: 'Community update',
        image: '/api/media/files/replay.webm',
        likes: 0,
        comments: 0,
        shares: 0,
        saved: 0,
        live: { id: 'live-123', title: 'Community update', status: 'ended', viewerCount: 0 },
      }} /></MemoryRouter>)
      await Promise.resolve()
    })

    expect(host.querySelector('video[aria-label="Post attachment"]')?.getAttribute('src')).toBe('/api/media/files/replay.webm')
    expect(host.textContent).toContain('Watch the saved replay below.')
  })

  it('keeps an approved guest subscribe-only until they explicitly join the stage', async () => {
    const live = {
      id: 'live-123',
      hostId: 'host-1',
      title: 'Guest session',
      visibility: 'public',
      status: 'live',
      viewerCount: 1,
      moderators: [],
      blockedUserIds: [],
      mutedUserIds: [],
      viewers: [],
      guests: [{ userId: 'creator-1', role: 'COHOST', status: 'LIVE', requestedAt: new Date().toISOString() }],
      comments: [],
      providerConfigured: true,
    }
    let stageLive = live
    mocks.apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/live') return { lives: [live] }
      if (path === '/api/live/replays') return { replays: [] }
      if (path === '/api/live/live-123/viewers/join') return { live: stageLive }
      if (path === '/api/live/live-123/token' || path === '/api/live/live-123/stage/token') return { token: 'test-token', url: 'wss://media.example.test' }
      if (path === '/api/live/live-123/guests/stage/join') {
        stageLive = { ...live, guests: [{ ...live.guests[0], admittedAt: new Date().toISOString() }] }
        return { live: stageLive }
      }
      if (path === '/api/live/live-123/viewers/heartbeat') return { live: stageLive }
      if (path === '/api/live/live-123/viewers/leave') return { left: true }
      return {}
    })

    await act(async () => {
      root.render(<MemoryRouter><LivePage /></MemoryRouter>)
      await Promise.resolve()
    })
    const joinButton = [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Join live')
    await act(async () => {
      joinButton?.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.setMicrophoneEnabled).not.toHaveBeenCalled()
    expect(mocks.setCameraEnabled).not.toHaveBeenCalled()
    const stageButton = [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Join the stage')
    expect(stageButton).toBeDefined()
    await act(async () => {
      stageButton?.click()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mocks.setMicrophoneEnabled).toHaveBeenCalledWith(true)
    expect(mocks.setCameraEnabled).toHaveBeenCalledWith(true)
    expect(mocks.apiRequest).toHaveBeenCalledWith('/api/live/live-123/guests/stage/join', { method: 'POST' })
    expect(mocks.apiRequest).toHaveBeenCalledWith('/api/live/live-123/stage/token', { method: 'POST' })
  })

  it('lets viewers request an approved co-host role', async () => {
    const live = {
      id: 'live-123',
      hostId: 'host-1',
      title: 'Co-host session',
      visibility: 'public',
      status: 'live',
      viewerCount: 0,
      moderators: [],
      blockedUserIds: [],
      mutedUserIds: [],
      viewers: [],
      guests: [],
      comments: [],
      providerConfigured: true,
    }
    mocks.apiRequest.mockImplementation(async (path: string) => {
      if (path === '/api/live') return { lives: [live] }
      if (path === '/api/live/replays') return { replays: [] }
      if (path === '/api/live/live-123/guests/request') return { live: { ...live, guests: [{ userId: 'creator-1', role: 'COHOST', status: 'REQUESTED', requestedAt: new Date().toISOString() }] } }
      return {}
    })

    await act(async () => {
      root.render(<MemoryRouter><LivePage /></MemoryRouter>)
      await Promise.resolve()
    })
    const roleSelect = host.querySelector<HTMLSelectElement>('select[aria-label="Stage role for Co-host session"]')
    expect(roleSelect).not.toBeNull()
    const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      selectSetter.call(roleSelect, 'COHOST')
      roleSelect?.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    const requestButton = [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Request guest spot')
    await act(async () => {
      requestButton?.click()
      await Promise.resolve()
    })

    expect(mocks.apiRequest).toHaveBeenCalledWith('/api/live/live-123/guests/request', {
      method: 'POST',
      body: JSON.stringify({ role: 'COHOST' }),
    })
  })
})
