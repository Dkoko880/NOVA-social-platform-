// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  uploadVideo: vi.fn(),
  roomHandlers: {} as Record<string, () => void>,
  roomConnect: vi.fn(),
  roomDisconnect: vi.fn(),
  setMicrophoneEnabled: vi.fn(),
  setCameraEnabled: vi.fn(),
  recordingProvider: 'browser' as 'browser' | 'livekit-egress',
  egressReplayReady: false,
  cameraTrack: { kind: 'video', mediaStreamTrack: {}, attach: vi.fn(), detach: vi.fn(), stop: vi.fn() },
  microphoneTrack: { kind: 'audio', mediaStreamTrack: {}, attach: vi.fn(), detach: vi.fn(), stop: vi.fn() },
}))

vi.mock('../src/lib/api', () => ({ apiRequest: mocks.apiRequest, uploadVideo: mocks.uploadVideo }))
vi.mock('../src/lib/eventStream', () => ({ openAuthenticatedEventStream: () => ({ addEventListener: vi.fn(), close: vi.fn() }) }))
vi.mock('../src/context/AuthContext', () => ({ useAuth: () => ({ user: { id: 'creator-1', name: 'Test Creator' } }) }))
vi.mock('../src/components/PostMedia', () => ({ PostMedia: ({ alt }: { alt: string }) => <video aria-label={alt} /> }))
vi.mock('livekit-client', () => ({
  Room: class {
    on = vi.fn((event: string, handler: () => void) => { mocks.roomHandlers[event] = handler })
    connect = mocks.roomConnect
    disconnect = mocks.roomDisconnect
    localParticipant = {
      setMicrophoneEnabled: mocks.setMicrophoneEnabled,
      setCameraEnabled: mocks.setCameraEnabled,
      getTrackPublication: (source: string) => source === 'camera'
        ? { track: mocks.cameraTrack }
        : source === 'microphone'
          ? { track: mocks.microphoneTrack }
          : undefined,
    }
  },
  RoomEvent: { Reconnecting: 'reconnecting', Reconnected: 'reconnected', Disconnected: 'disconnected' },
}))

import { LivePage } from '../src/pages/LivePage'
import { savePendingLiveRecording } from '../src/lib/liveRecordingStore'

const live = {
  id: 'live-1',
  hostId: 'creator-1',
  title: 'Community update',
  description: 'Live questions',
  visibility: 'followers',
  status: 'paused',
  recordingStatus: 'UNAVAILABLE',
  viewerCount: 0,
  moderators: [],
  blockedUserIds: [],
  mutedUserIds: [],
  viewers: [],
  guests: [],
  comments: [],
  provider: 'livekit',
  providerConfigured: true,
}
const readyReplay = {
  id: live.id,
  title: live.title,
  mediaUrl: '/api/media/files/replay.webm',
  durationSeconds: 30,
  status: 'READY',
  createdAt: new Date().toISOString(),
}
const publishedReplay = { ...readyReplay, status: 'PUBLISHED', publishedPostId: 'post-1' }

class TestMediaRecorder extends EventTarget {
  static isTypeSupported = vi.fn(() => true)
  static lastOptions: MediaRecorderOptions | undefined
  state: RecordingState = 'inactive'
  mimeType = 'video/webm;codecs=vp9,opus'
  ondataavailable: ((event: BlobEvent) => void) | null = null

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    super()
    TestMediaRecorder.lastOptions = options
    this.mimeType = options?.mimeType ?? this.mimeType
  }

  start() {
    this.state = 'recording'
    this.emitChunk('captured-')
  }

  stop() {
    this.emitChunk('final-chunk')
    this.state = 'inactive'
    this.dispatchEvent(new Event('stop'))
  }

  private emitChunk(value: string) {
    const event = new Event('dataavailable')
    Object.defineProperty(event, 'data', { value: new Blob([value], { type: this.mimeType }) })
    this.ondataavailable?.(event as BlobEvent)
  }
}

let root: Root
let host: HTMLDivElement

function deleteRecordingDatabase() {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('nova-live-recordings')
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('The live recording database is still open.'))
  })
}

function clickButton(label: string) {
  const button = [...host.querySelectorAll('button')].find((candidate) =>
    candidate.getAttribute('aria-label') === label || candidate.textContent?.trim() === label,
  )
  if (!button) throw new Error(`Button not found: ${label}`)
  button.click()
}

async function renderLivePage() {
  await act(async () => {
    root.render(<MemoryRouter><LivePage /></MemoryRouter>)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function setupApi() {
  mocks.apiRequest.mockImplementation(async (path: string) => {
    if (path === '/api/live') return { lives: [live] }
    if (path === '/api/live/replays') return { replays: mocks.egressReplayReady ? [readyReplay] : [] }
    if (path === '/api/live/live-1/token') return { token: 'host-token', url: 'wss://media.example.test' }
    if (path === '/api/live/live-1/start') return { live: { ...live, status: 'live' } }
    if (path === '/api/live/live-1/recording/start') return {
      live: { ...live, status: 'live', recordingStatus: 'RECORDING' },
      recordingProvider: mocks.recordingProvider,
      ...(mocks.recordingProvider === 'browser'
        ? { egressUnavailableReason: 'LiveKit Egress is not configured. Missing: LIVEKIT_EGRESS_S3_BUCKET.' }
        : {}),
    }
    if (path === '/api/live/live-1/replay') return { replay: readyReplay, live: { ...live, recordingStatus: 'READY' } }
    if (path === '/api/live/live-1/replay/publish') return { replay: publishedReplay, post: { id: 'post-1' }, duplicate: false }
    if (path === '/api/live/live-1/end') {
      mocks.egressReplayReady = mocks.recordingProvider === 'livekit-egress'
      return { live: { ...live, status: 'ended', recordingStatus: 'PROCESSING' } }
    }
    throw new Error(`Unexpected API request: ${path}`)
  })
}

beforeEach(async () => {
  await deleteRecordingDatabase()
  mocks.apiRequest.mockReset()
  mocks.uploadVideo.mockReset().mockResolvedValue({ mediaUrl: readyReplay.mediaUrl, contentType: 'video/webm' })
  Object.keys(mocks.roomHandlers).forEach((event) => delete mocks.roomHandlers[event])
  mocks.roomConnect.mockReset().mockResolvedValue(undefined)
  mocks.roomDisconnect.mockReset().mockResolvedValue(undefined)
  mocks.setMicrophoneEnabled.mockReset().mockResolvedValue(undefined)
  mocks.setCameraEnabled.mockReset().mockResolvedValue(undefined)
  mocks.cameraTrack.stop.mockReset()
  mocks.microphoneTrack.stop.mockReset()
  mocks.recordingProvider = 'browser'
  mocks.egressReplayReady = false
  TestMediaRecorder.isTypeSupported.mockReset().mockImplementation((candidate) => candidate.includes('webm'))
  TestMediaRecorder.lastOptions = undefined
  vi.stubGlobal('MediaRecorder', TestMediaRecorder)
  vi.stubGlobal('MediaStream', class { constructor(readonly tracks: MediaStreamTrack[]) {} })
  vi.stubGlobal('confirm', vi.fn(() => true))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  setupApi()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  host.remove()
  vi.unstubAllGlobals()
  await new Promise((resolve) => setTimeout(resolve, 10))
  await deleteRecordingDatabase()
})

describe('automatic live recording and replay publishing', () => {
  it('keeps host controls in a horizontal top row on narrow landscape and portrait screens', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 568 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 320 })
    await renderLivePage()

    await act(async () => {
      clickButton('Start broadcasting')
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const stage = host.querySelector('[aria-label="Live video session"]')
    expect(stage?.getAttribute('data-orientation')).toBe('landscape')
    expect(host.querySelector('video.object-contain')).not.toBeNull()
    const controls = host.querySelector('[data-testid="live-controls-row"]')
    expect(controls?.className).toContain('flex-nowrap')
    expect(controls?.className).toContain('overflow-x-auto')
    expect(controls?.className).toContain('gap-1')
    for (const label of ['Mute microphone', 'Turn camera off', 'Switch camera', 'End broadcast', 'Enter fullscreen', 'Manage guests and viewers']) {
      const button = controls?.querySelector(`button[aria-label="${label}"]`)
      expect(button).not.toBeNull()
      expect(button?.className).toContain('min-w-11')
      expect(button?.className).toContain('shrink-0')
    }
    expect(controls?.parentElement?.className).toContain('flex-col')
    expect(host.querySelector('h1')?.textContent).toBe(live.title)

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
    await act(async () => { window.dispatchEvent(new Event('resize')) })
    expect(stage?.getAttribute('data-orientation')).toBe('portrait')
    expect(host.querySelector('[data-testid="live-controls-row"]')?.className).toContain('flex-nowrap')
    expect(host.querySelector('button[aria-label="End broadcast"]')?.closest('[data-testid="live-controls-row"]')).not.toBeNull()
  })

  it('records the broadcast, uploads the final chunk, and automatically publishes the linked Feed replay', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 })
    const uploadedContent: string[] = []
    const uploadedTypes: string[] = []
    mocks.uploadVideo.mockImplementation(async (file: File) => {
      uploadedContent.push(await file.text())
      uploadedTypes.push(file.type)
      return { mediaUrl: readyReplay.mediaUrl, contentType: 'video/webm' }
    })

    await renderLivePage()
    await act(async () => {
      clickButton('Start broadcasting')
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(host.querySelector('[aria-label="0 viewers"] svg')).not.toBeNull()
    expect(host.textContent).toContain('LIVEKIT_EGRESS_S3_BUCKET')
    expect(host.textContent).not.toContain('Live controls ·')
    expect(host.textContent).not.toContain('Browser MediaRecorder replay:')
    expect(host.querySelector('button[aria-label="Mute microphone"]')).not.toBeNull()
    expect(host.querySelector('button[aria-label="Turn camera off"]')).not.toBeNull()
    expect(host.querySelector('button[aria-label="Switch camera"]')).not.toBeNull()
    expect(mocks.apiRequest).toHaveBeenCalledWith('/api/live/live-1/recording/start', { method: 'POST' })
    expect(TestMediaRecorder.lastOptions).toMatchObject({ videoBitsPerSecond: 1_500_000, audioBitsPerSecond: 96_000 })
    await act(async () => { mocks.roomHandlers.reconnecting?.() })
    expect(host.textContent).toContain('LiveKit connection interrupted; attempting to reconnect')
    await act(async () => { mocks.roomHandlers.reconnected?.() })
    expect(host.textContent).not.toContain('LiveKit connection interrupted')
    expect(host.querySelector('video.object-contain')).not.toBeNull()
    const moderationButton = host.querySelector<HTMLButtonElement>('button[aria-label="Manage guests and viewers"]')
    expect(moderationButton?.getAttribute('aria-expanded')).toBe('false')
    await act(async () => { moderationButton?.click() })
    expect(moderationButton?.getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector('#live-guest-controls')).not.toBeNull()
    await act(async () => { clickButton('Enter fullscreen') })
    expect(host.querySelector('button[aria-label="Exit fullscreen"]')).not.toBeNull()
    await act(async () => { clickButton('Exit fullscreen') })

    await act(async () => {
      clickButton('End broadcast')
      await new Promise((resolve) => setTimeout(resolve, 30))
    })

    expect(mocks.uploadVideo, JSON.stringify(mocks.apiRequest.mock.calls.map(([path]) => path))).toHaveBeenCalledTimes(1)
    expect(uploadedContent).toEqual(['captured-final-chunk'])
    expect(uploadedTypes).toEqual(['video/webm'])
    expect(mocks.apiRequest).toHaveBeenCalledWith('/api/live/live-1/replay/publish', {
      method: 'POST',
      body: JSON.stringify({ content: readyReplay.title, visibility: 'FOLLOWERS' }),
    })
    expect(mocks.apiRequest.mock.calls.filter(([path]) => path === '/api/live/live-1/replay/publish')).toHaveLength(1)
    expect(host.textContent).toContain('Your live replay was posted')
    expect(host.querySelector('input[type="file"]')).toBeNull()
    expect(mocks.roomDisconnect).toHaveBeenCalledWith(true)
  })

  it('disconnects camera and microphone before showing a designed replay upload state', async () => {
    let resolveUpload: ((upload: { mediaUrl: string; contentType: string }) => void) | undefined
    mocks.uploadVideo.mockImplementation(() => new Promise((resolve) => { resolveUpload = resolve }))
    await renderLivePage()
    await act(async () => {
      clickButton('Start broadcasting')
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    await act(async () => {
      clickButton('End broadcast')
      await new Promise((resolve) => setTimeout(resolve, 40))
    })

    expect(mocks.uploadVideo).toHaveBeenCalledTimes(1)
    expect(mocks.roomDisconnect).toHaveBeenCalledWith(true)
    expect(mocks.cameraTrack.stop).toHaveBeenCalled()
    expect(mocks.microphoneTrack.stop).toHaveBeenCalled()
    expect(host.querySelector('[aria-label="Finishing live broadcast"]')).not.toBeNull()
    expect(host.textContent).not.toContain('transferred')
    expect(host.textContent).not.toContain('MB/s')
    expect(host.textContent).not.toContain('seconds remaining')

    await act(async () => {
      resolveUpload?.({ mediaUrl: readyReplay.mediaUrl, contentType: 'video/webm' })
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
    expect(host.textContent).toContain('Your live replay was posted')
  })

  it('uses server-side Egress without browser capture and publishes the completed server replay', async () => {
    mocks.recordingProvider = 'livekit-egress'
    await renderLivePage()

    await act(async () => {
      clickButton('Start broadcasting')
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(TestMediaRecorder.lastOptions).toBeUndefined()
    expect(mocks.uploadVideo).not.toHaveBeenCalled()

    await act(async () => {
      clickButton('End broadcast')
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    expect(mocks.apiRequest).toHaveBeenCalledWith('/api/live/live-1/recording/start', { method: 'POST' })
    expect(mocks.apiRequest).toHaveBeenCalledWith('/api/live/live-1/replay/publish', {
      method: 'POST',
      body: JSON.stringify({ content: readyReplay.title, visibility: 'FOLLOWERS' }),
    })
    expect(host.textContent).toContain('Your live replay was posted')
  })

  it('resumes publishing after reload when the original upload already completed', async () => {
    const original = new Blob(['original-capture'], { type: 'video/webm;codecs=vp8,opus' })
    await savePendingLiveRecording({
      liveId: live.id,
      ownerUserId: 'creator-1',
      blob: original,
      durationSeconds: 12,
      mediaUrl: readyReplay.mediaUrl,
      contentType: 'video/webm',
      status: 'UPLOADED',
      updatedAt: Date.now(),
    })

    await renderLivePage()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })

    expect(mocks.uploadVideo).not.toHaveBeenCalled()
    expect(mocks.apiRequest).toHaveBeenCalledWith('/api/live/live-1/replay/publish', expect.objectContaining({ method: 'POST' }))
    expect(host.querySelector('input[type="file"]')).toBeNull()
  })

  it('retains the captured Blob and exposes failed and unavailable outcomes accurately', async () => {
    let uploadAttempts = 0
    const uploadedContent: string[] = []
    mocks.uploadVideo.mockImplementation(async (file: File) => {
      uploadAttempts += 1
      uploadedContent.push(await file.text())
      if (uploadAttempts < 3) throw new Error('Upload unavailable.')
      return { mediaUrl: readyReplay.mediaUrl, contentType: 'video/webm' }
    })

    await renderLivePage()
    await act(async () => {
      clickButton('Start broadcasting')
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      clickButton('End broadcast')
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })

    expect(uploadAttempts).toBe(2)
    expect(host.textContent).toContain('Upload unavailable.')
    expect(host.textContent).toContain('Retry upload and publish')
    expect(host.querySelector('input[type="file"]')).toBeNull()

    await act(async () => {
      clickButton('Retry upload and publish')
      await new Promise((resolve) => setTimeout(resolve, 30))
    })
    expect(uploadAttempts).toBe(3)
    expect(uploadedContent).toEqual(['captured-final-chunk', 'captured-final-chunk', 'captured-final-chunk'])
    expect(host.textContent).toContain('Your live replay was posted')
    expect(host.querySelector('input[type="file"]')).toBeNull()
  })
})
