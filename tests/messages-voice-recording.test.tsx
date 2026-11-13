// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

const voiceTestState = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  uploadMessageAttachment: vi.fn(),
}))

vi.mock('../src/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'alice', name: 'Alice' }, isLoading: false }),
}))

vi.mock('../src/lib/api', () => ({
  apiRequest: voiceTestState.apiRequest,
  fetchMediaBlob: vi.fn(),
  resolveMediaUrl: (url: string | null | undefined) => url ?? '',
  uploadMedia: vi.fn(),
  uploadMessageAttachment: voiceTestState.uploadMessageAttachment,
  uploadVideo: vi.fn(),
}))

vi.mock('../src/lib/eventStream', () => ({
  openAuthenticatedEventStream: vi.fn(() => ({ addEventListener: vi.fn(), close: vi.fn() })),
}))

import { MessagesPage } from '../src/pages/MessagesPage'

let root: Root | null = null
let host: HTMLDivElement
let activeRecorder: MockMediaRecorder | null = null

class MockMediaRecorder {
  static isTypeSupported() { return true }
  mimeType = 'audio/webm'
  state: RecordingState = 'inactive'
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onstop: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor() { activeRecorder = this }
  start() { this.state = 'recording' }
  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['voice'], { type: 'audio/webm' }) } as BlobEvent)
    this.onstop?.(new Event('stop'))
  }
}

function configureApi() {
  voiceTestState.apiRequest.mockImplementation(async (path: string, options?: RequestInit) => {
    if (path === '/api/conversations') return { conversations: [{
      id: 'chat-1',
      name: null,
      participants: [
        { userId: 'alice', role: 'OWNER', user: { id: 'alice', name: 'Alice', avatar: '' } },
        { userId: 'bob', user: { id: 'bob', name: 'Bob', avatar: '' } },
      ],
      lastMessagePreview: null,
      updatedAt: new Date().toISOString(),
      lastMessageAt: null,
    }] }
    if (path.includes('/messages?limit=50')) return { messages: [], hasMore: false }
    if (path.endsWith('/read') || path.endsWith('/typing')) return {}
    if (path === '/api/conversations/chat-1/messages' && options?.method === 'POST') {
      const body = JSON.parse(String(options.body)) as { contentType: string }
      return { message: {
        id: 'voice-message',
        conversationId: 'chat-1',
        senderId: 'alice',
        text: '',
        contentType: body.contentType,
        mediaUrl: '/api/attachments/voice',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'SENT',
      } }
    }
    return {}
  })
  voiceTestState.uploadMessageAttachment.mockResolvedValue({ mediaUrl: '/api/attachments/voice' })
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

async function pointer(target: HTMLButtonElement, type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  await act(async () => {
    target.dispatchEvent(event)
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

async function startHolding() {
  const button = host.querySelector<HTMLButtonElement>('[aria-label="Hold to record voice message"]')
  if (!button) throw new Error('Expected voice record button.')
  button.setPointerCapture = vi.fn()
  await pointer(button, 'pointerdown', 120, 240)
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
  return button
}

describe('WhatsApp-style voice recording', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    activeRecorder = null
    Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: true, addListener: vi.fn(), removeListener: vi.fn() })) })
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }], getAudioTracks: () => [{ stop: vi.fn(), addEventListener: vi.fn() }] }) } })
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:voice') })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    vi.stubGlobal('MediaRecorder', MockMediaRecorder)
    configureApi()
  })

  afterEach(async () => {
    if (root) await act(async () => { root!.unmount() })
    root = null
    host?.remove()
    voiceTestState.apiRequest.mockReset()
    voiceTestState.uploadMessageAttachment.mockReset()
    vi.unstubAllGlobals()
  })

  it('records while held and sends automatically on release', async () => {
    await renderPage()
    const button = await startHolding()
    expect(activeRecorder?.state).toBe('recording')
    await pointer(button, 'pointerup', 120, 240)

    expect(voiceTestState.uploadMessageAttachment).toHaveBeenCalledOnce()
    expect(voiceTestState.apiRequest).toHaveBeenCalledWith('/api/conversations/chat-1/messages', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ contentType: 'VOICE', mediaUrl: '/api/attachments/voice' }),
    }))
  })

  it('locks on upward slide and offers explicit send and cancel controls', async () => {
    await renderPage()
    const button = await startHolding()
    await pointer(button, 'pointermove', 120, 160)

    expect(host.textContent).toContain('Recording locked')
    await pointer(button, 'pointerup', 120, 160)
    expect(activeRecorder?.state).toBe('recording')
    await click(host.querySelector('[role="status"] button:last-child'))
    expect(voiceTestState.uploadMessageAttachment).toHaveBeenCalledOnce()
  })

  it('discards a left-slide cancellation without uploading or sending', async () => {
    await renderPage()
    const button = await startHolding()
    await pointer(button, 'pointermove', 35, 240)

    expect(activeRecorder?.state).toBe('inactive')
    expect(voiceTestState.uploadMessageAttachment).not.toHaveBeenCalled()
    expect(voiceTestState.apiRequest).not.toHaveBeenCalledWith('/api/conversations/chat-1/messages', expect.objectContaining({ method: 'POST' }))
  })

  it('keeps a failed upload available for a manual retry', async () => {
    voiceTestState.uploadMessageAttachment
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ mediaUrl: '/api/attachments/voice' })
    await renderPage()
    const button = await startHolding()
    await pointer(button, 'pointerup', 120, 240)

    expect(host.textContent).toContain('Voice message could not be sent: offline')
    await click(host.querySelector('[aria-label="Send message"]'))
    expect(voiceTestState.uploadMessageAttachment).toHaveBeenCalledTimes(2)
    expect(voiceTestState.apiRequest).toHaveBeenCalledWith('/api/conversations/chat-1/messages', expect.objectContaining({ method: 'POST' }))
  })

  it('exposes disappearing-message settings in the conversation menu', async () => {
    await renderPage()
    await click(host.querySelector('[aria-label="More conversation options"]'))

    const duration = host.querySelector<HTMLSelectElement>('[aria-label="Disappearing message duration"]')
    expect(duration).not.toBeNull()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(duration, '86400')
      duration!.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    expect(voiceTestState.apiRequest).toHaveBeenCalledWith('/api/conversations/chat-1/preferences', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ disappearingAfterSeconds: 86400 }),
    }))
  })
})
