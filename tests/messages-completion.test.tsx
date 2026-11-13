// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { SettingsPage } from '../src/pages/SettingsPage'

const state = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  conversations: [] as Array<Record<string, unknown>>,
  sentMessages: [] as Array<{ path: string; body: Record<string, unknown> }>,
}))

vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'alice', name: 'Alice' }, isLoading: false }),
}))

vi.mock('../src/lib/api', () => ({
  apiRequest: state.apiRequest,
  fetchMediaBlob: vi.fn(),
  resolveMediaUrl: (url: string | null | undefined) => url ?? '',
  uploadMedia: vi.fn(),
  uploadMessageAttachment: vi.fn(),
  uploadVideo: vi.fn(),
}))

vi.mock('../src/lib/eventStream', () => ({
  openAuthenticatedEventStream: vi.fn(() => ({ addEventListener: vi.fn(), close: vi.fn() })),
}))

import { MessagesPage } from '../src/pages/MessagesPage'

let root: Root | null = null
let host: HTMLDivElement

const originalMessage = {
  id: 'group-message',
  conversationId: 'group-chat',
  senderId: 'bob',
  text: 'Meet us at the park',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  status: 'SENT',
  contentType: 'TEXT',
}

function groupConversation() {
  return {
    id: 'group-chat',
    name: 'Weekend group',
    isGroup: true,
    isChannel: false,
    participants: [
      { userId: 'alice', role: 'OWNER', user: { id: 'alice', name: 'Alice', avatar: '' } },
      { userId: 'bob', user: { id: 'bob', name: 'Bob', avatar: '' } },
    ],
    lastMessagePreview: originalMessage.text,
    updatedAt: new Date().toISOString(),
    lastMessageAt: originalMessage.createdAt,
  }
}

function configureApi() {
  state.conversations = [groupConversation()]
  state.sentMessages = []
  state.apiRequest.mockImplementation(async (path: string, options?: RequestInit) => {
    if (path === '/api/conversations' && options?.method === 'POST') {
      state.conversations = [...state.conversations, {
        id: 'private-chat',
        name: null,
        participants: [
          { userId: 'alice', role: 'OWNER', user: { id: 'alice', name: 'Alice', avatar: '' } },
          { userId: 'bob', user: { id: 'bob', name: 'Bob', avatar: '' } },
        ],
        lastMessagePreview: null,
        updatedAt: new Date().toISOString(),
        lastMessageAt: null,
      }]
      return { conversation: { id: 'private-chat' } }
    }
    if (path === '/api/conversations') return { conversations: state.conversations }
    if (path === '/api/conversations/group-chat/messages?limit=50') return { messages: [originalMessage], hasMore: false }
    if (path.includes('/messages?limit=50')) return { messages: [], hasMore: false }
    if (path.endsWith('/read') || path.endsWith('/typing') || path.endsWith('/recording')) return {}
    if (path === '/api/presence/bob') return { presence: { online: true, lastSeenAt: null } }
    if (path === '/api/conversations/group-chat/messages' && options?.method === 'POST') {
      const body = JSON.parse(String(options.body)) as Record<string, unknown>
      state.sentMessages.push({ path, body })
      return { message: { ...originalMessage, id: 'sent-message', senderId: 'alice', text: '', ...body } }
    }
    if (path === '/api/messages/group-message/receipts') return { receipts: [{ recipientId: 'bob', name: 'Bob', deliveredAt: null, readAt: null }] }
    if (path === '/api/conversations/private-chat') return { conversation: { ...groupConversation(), id: 'group-chat', messages: [originalMessage] } }
    return {}
  })
}

async function renderPage() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<MemoryRouter initialEntries={['/messages']}><MessagesPage /></MemoryRouter>)
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function click(element: Element | null) {
  if (!element) throw new Error('Expected control was not rendered.')
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function fill(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setValue.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
  })
}

async function renderSettings() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<MemoryRouter><SettingsPage /></MemoryRouter>)
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('NOVACHAT messaging completion UI', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: true, addListener: vi.fn(), removeListener: vi.fn() })) })
    configureApi()
  })

  afterEach(async () => {
    if (root) await act(async () => { root!.unmount() })
    root = null
    host?.remove()
    state.apiRequest.mockReset()
    vi.restoreAllMocks()
  })

  it('searches, previews, and sends a provider-selected GIF from the attachment picker', async () => {
    state.apiRequest.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/conversations') return { conversations: state.conversations }
      if (path === '/api/conversations/group-chat/messages?limit=50') return { messages: [], hasMore: false }
      if (path.endsWith('/read') || path.endsWith('/typing') || path.endsWith('/recording')) return {}
      if (path.startsWith('/api/media-picker/gif')) return { items: [{ id: 'party', title: 'Party GIF', mediaUrl: 'https://media.giphy.com/party.gif', previewUrl: 'https://media.giphy.com/party-still.png' }], attribution: 'Powered by GIPHY' }
      if (path === '/api/conversations/group-chat/messages' && options?.method === 'POST') {
        const body = JSON.parse(String(options.body)) as Record<string, unknown>
        state.sentMessages.push({ path, body })
        return { message: { ...originalMessage, id: 'sent-gif', senderId: 'alice', text: '', ...body } }
      }
      return {}
    })
    await renderPage()

    await click(host.querySelector('[aria-label="Attach"]'))
    await click([...host.querySelectorAll('button')].find((button) => button.textContent === 'GIF') ?? null)
    expect(host.querySelector('[aria-label="GIF picker"]')).not.toBeNull()
    await fill(host.querySelector<HTMLInputElement>('[aria-label="Search GIFs"]')!, 'party')
    await click([...host.querySelector('[aria-label="GIF picker"]')!.querySelectorAll('button')].find((button) => button.textContent === 'Search') ?? null)
    expect(state.apiRequest).toHaveBeenCalledWith('/api/media-picker/gif?q=party')
    await click(host.querySelector('[aria-label="Choose gif Party GIF"]'))
    expect(host.querySelector('[alt="Selected GIF preview"]')).not.toBeNull()
    await click(host.querySelector('[aria-label="Send message"]'))

    expect(state.sentMessages).toContainEqual({
      path: '/api/conversations/group-chat/messages',
      body: { contentType: 'GIF', mediaUrl: 'https://media.giphy.com/party.gif' },
    })
  })

  it('offers the mark-as-unread action from the conversation menu', async () => {
    await renderPage()
    await click(host.querySelector('button[aria-label="More conversation options"]'))
    await click([...host.querySelectorAll('button')].find((button) => button.textContent === 'Mark as unread') ?? null)
    expect(state.apiRequest).toHaveBeenCalledWith('/api/conversations/group-chat/unread', expect.objectContaining({ method: 'POST' }))
  })

  it('provides Reply Privately from another member’s group message', async () => {
    await renderPage()
    await click(host.querySelector('[aria-label="More conversation options"]'))
    const message = host.querySelector('[aria-label="Message information"]')
    expect(message).toBeNull()
    const replyButton = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Reply privately')
    expect(replyButton).not.toBeNull()
    await click(replyButton ?? null)
    expect(state.apiRequest).toHaveBeenCalledWith('/api/conversations', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ participantId: 'bob' }),
    }))
    expect(host.textContent).toContain('Private reply to Bob')
    await click([...host.querySelectorAll('button')].find((button) => button.textContent === 'Return to group') ?? null)
    expect(host.textContent).toContain('Weekend group')
  })

  it('searches and previews stickers before sending the selected media', async () => {
    state.apiRequest.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/conversations') return { conversations: state.conversations }
      if (path === '/api/conversations/group-chat/messages?limit=50') return { messages: [], hasMore: false }
      if (path.endsWith('/read') || path.endsWith('/typing') || path.endsWith('/recording')) return {}
      if (path === '/api/media-picker/sticker?q=') return { items: [{ id: 'wave', title: 'Wave sticker', mediaUrl: 'https://media.giphy.com/wave.webp', previewUrl: 'https://media.giphy.com/wave-preview.png' }], attribution: 'Powered by GIPHY' }
      if (path === '/api/media-picker/sticker?categories=true') return { categories: [{ name: 'Animals', query: 'animals' }] }
      if (path === '/api/conversations/group-chat/messages' && options?.method === 'POST') {
        const body = JSON.parse(String(options.body)) as Record<string, unknown>
        state.sentMessages.push({ path, body })
        return { message: { ...originalMessage, id: 'sent-sticker', senderId: 'alice', text: '', ...body } }
      }
      return {}
    })
    await renderPage()
    await click(host.querySelector('[aria-label="Attach"]'))
    await click([...host.querySelectorAll('button')].find((button) => button.textContent === 'Sticker') ?? null)
    await click(host.querySelector('[aria-label="Choose sticker Wave sticker"]'))
    expect(host.querySelector('[alt="Selected sticker preview"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="GIF picker"]')).toBeNull()
    await click(host.querySelector('[aria-label="Send message"]'))
    expect(state.sentMessages).toContainEqual({
      path: '/api/conversations/group-chat/messages',
      body: { contentType: 'STICKER', mediaUrl: 'https://media.giphy.com/wave.webp' },
    })
  })

  it('exposes persisted read-receipt and presence privacy controls in settings', async () => {
    let preferences = { readReceiptsEnabled: true, presenceVisibility: 'EVERYONE' }
    state.apiRequest.mockImplementation(async (path: string, options?: RequestInit) => {
      if (path === '/api/auth/sessions') return { sessions: [] }
      if (path === '/api/notifications/preferences') return { preferences: [] }
      if (path === '/api/messaging/preferences' && options?.method === 'PATCH') {
        preferences = { ...preferences, ...JSON.parse(String(options.body)) }
        return { preferences }
      }
      if (path === '/api/messaging/preferences') return { preferences }
      return {}
    })
    await renderSettings()
    await click(host.querySelector('[aria-label="Read receipts"]'))
    expect(state.apiRequest).toHaveBeenCalledWith('/api/messaging/preferences', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ readReceiptsEnabled: false }),
    }))
    const visibility = host.querySelector<HTMLSelectElement>('[aria-label="Who can see my presence"]')
    expect(visibility).not.toBeNull()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(visibility, 'MY_CONTACTS')
      visibility!.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    expect(state.apiRequest).toHaveBeenCalledWith('/api/messaging/preferences', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ presenceVisibility: 'MY_CONTACTS' }),
    }))
  })
})
