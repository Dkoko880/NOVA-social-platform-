// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { sendTimedUpdateReply } from '../src/lib/storyReplies'

const state = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  sentMessages: [] as Array<{ path: string; body: Record<string, unknown> }>,
}))

vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'viewer', name: 'Viewer' }, isLoading: false }),
}))

vi.mock('../src/lib/api', () => ({
  apiRequest: state.apiRequest,
  resolveMediaUrl: (url: string | null | undefined) => url ?? '',
  uploadMedia: vi.fn(),
  uploadVideo: vi.fn(),
}))

vi.mock('../src/lib/eventStream', () => ({
  openAuthenticatedEventStream: () => ({ addEventListener: vi.fn(), close: vi.fn() }),
}))

import { HomePage } from '../src/pages/HomePage'
import { UpdatesPage } from '../src/pages/UpdatesPage'

let root: Root | null = null
let host: HTMLDivElement

const status = {
  id: 'status-1',
  authorId: 'author',
  text: 'Status context',
  mediaUrl: null,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  viewedByMe: false,
  viewCount: 0,
  author: { id: 'author', name: 'Author', handle: 'author', avatar: '' },
}
const story = {
  id: 'story-1',
  authorId: 'author',
  text: 'Story context',
  mediaUrl: null,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  viewedByMe: false,
  viewCount: 0,
  author: { id: 'author', name: 'Author', handle: 'author', avatar: '' },
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

async function renderStatusPage(entry = '/updates') {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<MemoryRouter initialEntries={[entry]}><UpdatesPage /></MemoryRouter>)
    await settle()
  })
}

async function renderStoryPage(entry = '/') {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<MemoryRouter initialEntries={[entry]}><HomePage /></MemoryRouter>)
    await settle()
  })
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await settle()
  })
}

async function fill(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
  })
}

beforeEach(() => {
  state.sentMessages = []
  state.apiRequest.mockReset().mockImplementation(async (path: string, options?: RequestInit) => {
    if (path === '/api/posts?limit=50') return { posts: [] }
    if (path === '/api/stories') return { stories: [story] }
    if (path === '/api/statuses') return { statuses: [status] }
    if (path === '/api/conversations') {
      if (options?.method === 'POST') return { conversation: { id: 'private-chat' } }
      return { conversations: [] }
    }
    if (path.endsWith('/view')) return { viewed: true, viewCount: 1 }
    if (path.endsWith('/messages') && options?.method === 'POST') {
      state.sentMessages.push({ path, body: JSON.parse(String(options.body)) as Record<string, unknown> })
      return { message: { id: `message-${state.sentMessages.length}` } }
    }
    return {}
  })
})

afterEach(async () => {
  if (root) await act(async () => { root?.unmount() })
  root = null
  host?.remove()
})

describe('Story and Status reply delivery', () => {
  it('sends text and reaction replies with the original Story or Status reference', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ conversation: { id: 'chat' } })
      .mockResolvedValueOnce({})
    await sendTimedUpdateReply({ kind: 'STORY', updateId: 'story-1', ownerId: 'author-1', text: 'Nice!' }, request)
    expect(request).toHaveBeenNthCalledWith(2, '/api/conversations/chat/messages', {
      method: 'POST',
      body: JSON.stringify({
        text: 'Nice!',
        metadata: { timedUpdateReply: { kind: 'STORY', id: 'story-1' } },
      }),
    })

    request.mockReset()
      .mockResolvedValueOnce({ conversation: { id: 'chat' } })
      .mockResolvedValueOnce({})
    await sendTimedUpdateReply({ kind: 'STATUS', updateId: 'status-1', ownerId: 'author-1', reaction: '❤️' }, request)
    expect(request).toHaveBeenNthCalledWith(2, '/api/conversations/chat/messages', {
      method: 'POST',
      body: JSON.stringify({
        text: 'Reacted ❤️ to your Status',
        metadata: { timedUpdateReply: { kind: 'STATUS', id: 'status-1', reaction: '❤️' } },
      }),
    })
  })

  it('lets a viewer reply to or react to an open Status', async () => {
    await renderStatusPage()
    const statusButton = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Author'))
    expect(statusButton).toBeTruthy()
    await click(statusButton!)

    const input = host.querySelector<HTMLInputElement>('input[aria-label="Reply to Author\'s status"]')
    expect(input).toBeTruthy()
    await fill(input!, 'Thanks for sharing')
    await click(host.querySelector('button[aria-label="Send status reply"]')!)
    await click(host.querySelector('button[aria-label="React ❤️ to status"]')!)

    expect(state.sentMessages).toEqual([
      {
        path: '/api/conversations/private-chat/messages',
        body: {
          text: 'Thanks for sharing',
          metadata: { timedUpdateReply: { kind: 'STATUS', id: 'status-1' } },
        },
      },
      {
        path: '/api/conversations/private-chat/messages',
        body: {
          text: 'Reacted ❤️ to your Status',
          metadata: { timedUpdateReply: { kind: 'STATUS', id: 'status-1', reaction: '❤️' } },
        },
      },
    ])
  })

  it('lets a viewer reply to or react to an open Story', async () => {
    await renderStoryPage()
    const storyButton = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Author'))
    expect(storyButton).toBeTruthy()
    await click(storyButton!)

    const input = host.querySelector<HTMLInputElement>('input[aria-label="Reply to Author\'s story"]')
    expect(input).toBeTruthy()
    await fill(input!, 'Great moment')
    await click(host.querySelector('button[aria-label="Send story reply"]')!)
    await click(host.querySelector('button[aria-label="React ❤️ to story"]')!)

    expect(state.sentMessages).toEqual([
      {
        path: '/api/conversations/private-chat/messages',
        body: {
          text: 'Great moment',
          metadata: { timedUpdateReply: { kind: 'STORY', id: 'story-1' } },
        },
      },
      {
        path: '/api/conversations/private-chat/messages',
        body: {
          text: 'Reacted ❤️ to your Story',
          metadata: { timedUpdateReply: { kind: 'STORY', id: 'story-1', reaction: '❤️' } },
        },
      },
    ])
  })

  it('opens a still-available Story or Status from a private-chat reference URL', async () => {
    await renderStoryPage('/?story=story-1')
    expect(host.querySelector('[aria-label="Author\'s story"]')).not.toBeNull()
    await act(async () => { root?.unmount() })
    root = null
    host.remove()

    await renderStatusPage('/updates?status=status-1')
    expect(host.querySelector('[aria-label="Author\'s status"]')).not.toBeNull()
  })
})
