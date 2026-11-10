import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Heart, Headphones, Maximize, Mic, MicOff, Minimize, PhoneOff, Radio, RefreshCw, Send, Share2, Users, Video, VideoOff, Volume2 } from 'lucide-react'
import type { RemoteTrack, Room, Track } from 'livekit-client'
import { Link, useSearchParams } from 'react-router-dom'
import { Button } from '../components/ui/Button'
import { PostMedia } from '../components/PostMedia'
import { useAuth } from '../context/AuthContext'
import { apiRequest, uploadVideo } from '../lib/api'
import { openAuthenticatedEventStream } from '../lib/eventStream'
import { finalizeLiveRecording } from '../lib/liveRecording'
import { deletePendingLiveRecording, getPendingLiveRecordings, savePendingLiveRecording, type PendingLiveRecording } from '../lib/liveRecordingStore'
import { cameraSwitchErrorMessage, switchToNextCamera } from '../lib/cameraSwitching'

type LiveComment = { id: string; userId: string; text: string; createdAt: string }
type LiveSession = {
  id: string
  hostId: string
  title: string
  description?: string | null
  visibility: string
  status: string
  recordingStatus: 'UNAVAILABLE' | 'RECORDING' | 'PROCESSING' | 'READY'
  viewerCount: number
  moderators: string[]
  blockedUserIds: string[]
  mutedUserIds: string[]
  viewers: Array<{ userId: string; isMuted: boolean; isBlocked: boolean; joinedAt: string }>
  guests: Array<{ userId: string; role: 'GUEST' | 'COHOST'; status: 'REQUESTED' | 'LIVE' | 'REMOVED'; requestedAt: string; admittedAt?: string }>
  provider?: string
  providerConfigured: boolean
  comments: LiveComment[]
  host?: { name: string; avatar?: string | null } | null
}
type LiveReplay = { id: string; title: string; mediaUrl: string; durationSeconds: number; status: string; createdAt: string; publishedPostId?: string | null }
type RecordingPhase = 'IDLE' | 'RECORDING' | 'FINALIZING' | 'UPLOADING' | 'PROCESSING' | 'PUBLISHED' | 'FAILED' | 'UNAVAILABLE'
const cameraTrackSource = 'camera' as Track.Source
const microphoneTrackSource = 'microphone' as Track.Source

function AttachedTrack({ track, muted = false, className }: { track: Track; muted?: boolean; className: string }) {
  const elementRef = useRef<HTMLMediaElement | null>(null)

  useEffect(() => {
    const element = elementRef.current
    if (!element) return
    track.attach(element)
    return () => { track.detach(element) }
  }, [track])

  if (track.kind === 'video') {
    return <video ref={(element) => { elementRef.current = element }} autoPlay muted={muted} playsInline className={className} />
  }
  return <audio ref={(element) => { elementRef.current = element }} autoPlay className={className} />
}

export function LivePage() {
  const { user } = useAuth()
  const userId = user?.id
  const [searchParams] = useSearchParams()
  const [lives, setLives] = useState<LiveSession[]>([])
  const [joinedLive, setJoinedLive] = useState<LiveSession | null>(null)
  const [previewLive, setPreviewLive] = useState<LiveSession | null>(null)
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null)
  const [comment, setComment] = useState('')
  const [newTitle, setNewTitle] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newVisibility, setNewVisibility] = useState<'public' | 'followers' | 'private'>('public')
  const [guestRole, setGuestRole] = useState<'GUEST' | 'COHOST'>('GUEST')
  const [hostRoom, setHostRoom] = useState<Room | null>(null)
  const [guestRoom, setGuestRoom] = useState<Room | null>(null)
  const [remoteTracks, setRemoteTracks] = useState<Array<{ key: string; track: RemoteTrack }>>([])
  const [hostMuted, setHostMuted] = useState(false)
  const [hostCameraOn, setHostCameraOn] = useState(true)
  const [cameraSwitchBusy, setCameraSwitchBusy] = useState(false)
  const [needsAudioPlayback, setNeedsAudioPlayback] = useState(false)
  const [needsVideoPlayback, setNeedsVideoPlayback] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [replays, setReplays] = useState<LiveReplay[]>([])
  const [replaysLoading, setReplaysLoading] = useState(true)
  const [replayLoadError, setReplayLoadError] = useState('')
  const [replayChoice, setReplayChoice] = useState<LiveReplay | null>(null)
  const [replayVisibility, setReplayVisibility] = useState<'PUBLIC' | 'FOLLOWERS' | 'PRIVATE'>('PUBLIC')
  const [recordingError, setRecordingError] = useState('')
  const [recordingRetryLiveId, setRecordingRetryLiveId] = useState('')
  const [recordingRetryBusy, setRecordingRetryBusy] = useState(false)
  const [recordingUploadProgress, setRecordingUploadProgress] = useState<number | null>(null)
  const [recordingPhase, setRecordingPhase] = useState<RecordingPhase>('IDLE')
  const [fullscreenFallback, setFullscreenFallback] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [shareNotice, setShareNotice] = useState('')
  const [replayBusy, setReplayBusy] = useState(false)
  const [replayActionError, setReplayActionError] = useState('')
  const roomRef = useRef<Room | null>(null)
  const liveContainerRef = useRef<HTMLElement | null>(null)
  const hostRoomRef = useRef<Room | null>(null)
  const previewVideoRef = useRef<HTMLVideoElement | null>(null)
  const joinedLiveRef = useRef<LiveSession | null>(null)
  const livesRef = useRef<LiveSession[]>([])
  const intentionalDisconnectRef = useRef(new WeakSet<Room>())
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recordingChunksRef = useRef<Blob[]>([])
  const recordingStartedAtRef = useRef(0)
  const pendingRecordingRef = useRef<PendingLiveRecording | null>(null)
  const recordingPipelineRef = useRef(new Map<string, Promise<LiveReplay>>())
  const autoRecoveryAttemptRef = useRef(new Set<string>())
  const endInFlightRef = useRef(false)
  const attemptedNotificationLiveRef = useRef('')
  const replayActionInFlightRef = useRef(false)

  useEffect(() => {
    if (!userId) {
      pendingRecordingRef.current = null
      return
    }

    let cancelled = false
    void getPendingLiveRecordings(userId).then((pending) => {
      if (cancelled || pendingRecordingRef.current) return
      if (pending.length === 0) {
        setRecordingRetryLiveId('')
        return
      }
      const recording = pending[0]
      pendingRecordingRef.current = recording
      setRecordingRetryLiveId(recording.liveId)
      setRecordingPhase(recording.status === 'UPLOADED' ? 'PROCESSING' : 'FAILED')
      setRecordingError('A finalized live recording is waiting to be saved. Retry to finish publishing it.')
    }).catch((loadError: unknown) => {
      if (!cancelled) setRecordingError(loadError instanceof Error ? loadError.message : 'A pending live recording could not be restored.')
    })

    return () => { cancelled = true }
  }, [userId])

  useEffect(() => {
    const video = previewVideoRef.current
    if (!video) return
    video.srcObject = previewStream
    if (previewStream) {
      void video.play().catch((playError: unknown) => setError(playError instanceof Error ? playError.message : 'Camera preview playback could not start.'))
    }
    return () => { video.srcObject = null }
  }, [previewStream])

  useEffect(() => () => {
    previewStream?.getTracks().forEach((track) => track.stop())
  }, [previewStream])

  const setLiveState = useCallback((live: LiveSession) => {
    const current = livesRef.current.find((entry) => entry.id === live.id)
    const updated = live.host ? live : { ...live, ...(current?.host ? { host: current.host } : {}) }
    livesRef.current = current
      ? livesRef.current.map((entry) => entry.id === live.id ? updated : entry)
      : [updated, ...livesRef.current]
    setLives(livesRef.current)
    if (joinedLiveRef.current?.id === live.id) {
      joinedLiveRef.current = updated
      setJoinedLive(updated)
    }
  }, [])

  const retryLoadReplays = async () => {
    setReplaysLoading(true)
    await loadReplays()
  }

  const fetchLives = useCallback((signal?: AbortSignal) => apiRequest<{ lives: LiveSession[] }>('/api/live', { signal }), [])

  const applyLives = useCallback((lives: LiveSession[]) => {
    livesRef.current = lives
    setLives(lives)
    if (joinedLiveRef.current) {
      const refreshed = lives.find((live) => live.id === joinedLiveRef.current?.id) ?? null
      joinedLiveRef.current = refreshed
      setJoinedLive(refreshed)
    }
  }, [])

  const loadLives = useCallback(async () => {
    try {
      const response = await fetchLives()
      applyLives(response.lives)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load live sessions.')
    } finally {
      setLoading(false)
    }
  }, [applyLives, fetchLives])

  const loadReplays = useCallback(async (signal?: AbortSignal) => {
    setReplayLoadError('')
    try {
      const { replays: savedReplays } = await apiRequest<{ replays: LiveReplay[] }>('/api/live/replays', { signal })
      if (!signal?.aborted) setReplays(savedReplays)
    } catch (loadError) {
      if (!signal?.aborted) setReplayLoadError(loadError instanceof Error ? loadError.message : 'Unable to load saved live replays.')
    } finally {
      if (!signal?.aborted) setReplaysLoading(false)
    }
  }, [])

  const savePendingRecording = useCallback(async (liveId: string) => {
    const pending = pendingRecordingRef.current
    if (!pending || pending.liveId !== liveId) throw new Error('The local replay data is no longer available. No recording was uploaded.')
    if (!userId || pending.ownerUserId !== userId) throw new Error('Sign in to the account that hosted this broadcast before retrying its recording.')
    if (!pending.mediaUrl || !pending.contentType) {
      const contentType = pending.blob.type.split(';', 1)[0].trim().toLowerCase() || 'video/webm'
      const extension = contentType.includes('mp4') ? 'mp4' : contentType.includes('ogg') ? 'ogg' : 'webm'
      const recordingFile = new File([pending.blob], `live-${liveId}.${extension}`, { type: contentType })
      pending.status = 'UPLOADING'
      setRecordingPhase('UPLOADING')
      await savePendingLiveRecording(pending)
      setRecordingUploadProgress(0)
      let uploaded: Awaited<ReturnType<typeof uploadVideo>>
      try {
        uploaded = await uploadVideo(recordingFile, setRecordingUploadProgress, liveId)
      } finally {
        setRecordingUploadProgress(null)
      }
      pending.mediaUrl = uploaded.mediaUrl
      pending.contentType = uploaded.contentType
      pending.status = 'UPLOADED'
      await savePendingLiveRecording(pending)
    }
    const response = await apiRequest<{ replay: LiveReplay; live: LiveSession; duplicate?: boolean }>(`/api/live/${encodeURIComponent(liveId)}/replay`, {
      method: 'POST',
      body: JSON.stringify({ mediaUrl: pending.mediaUrl, contentType: pending.contentType, durationSeconds: pending.durationSeconds }),
    })
    setRecordingPhase('PROCESSING')
    const live = livesRef.current.find((entry) => entry.id === liveId)
    const visibility = live?.visibility === 'private' ? 'PRIVATE' : live?.visibility === 'followers' ? 'FOLLOWERS' : 'PUBLIC'
    const published = await apiRequest<{ replay: LiveReplay }>(`/api/live/${encodeURIComponent(liveId)}/replay/publish`, {
      method: 'POST',
      body: JSON.stringify({ content: response.replay.title, visibility }),
    })
    pending.status = 'PUBLISHED'
    await deletePendingLiveRecording(pending.ownerUserId, pending.liveId)
    const remaining = await getPendingLiveRecordings(pending.ownerUserId)
    pendingRecordingRef.current = remaining[0] ?? null
    setRecordingRetryLiveId(remaining[0]?.liveId ?? '')
    setRecordingError(remaining.length ? 'Another finalized live recording is waiting to be saved.' : '')
    setRecordingPhase('PUBLISHED')
    setReplays((current) => [published.replay, ...current.filter((entry) => entry.id !== published.replay.id)])
    setReplayChoice(published.replay)
    return published.replay
  }, [userId])

  const finalizeAndPublishRecording = useCallback(async (liveId: string) => {
    const active = recordingPipelineRef.current.get(liveId)
    if (active) return active
    const operation = (async () => {
      let pending = pendingRecordingRef.current
      if (!pending || pending.liveId !== liveId) {
        const recorder = recorderRef.current
        if (!recorder) throw new Error('No finalized live recording is available on this device.')
        setRecordingPhase('FINALIZING')
        const blob = await finalizeLiveRecording(recorder, recordingChunksRef.current)
        if (blob.size > 100 * 1024 * 1024) throw new Error('This replay exceeds the 100 MB video upload limit and was not saved.')
        if (!userId) throw new Error('Sign in again before saving this live recording.')
        pending = {
          liveId,
          ownerUserId: userId,
          blob,
          durationSeconds: Math.max(1, Math.floor((Date.now() - recordingStartedAtRef.current) / 1000)),
          updatedAt: Date.now(),
          status: 'FINALIZED',
        }
        pendingRecordingRef.current = pending
        await savePendingLiveRecording(pending)
        recordingChunksRef.current = []
      }
      recorderRef.current = null
      return await savePendingRecording(liveId)
    })()
    recordingPipelineRef.current.set(liveId, operation)
    try {
      return await operation
    } catch (recordingFailure) {
      setRecordingPhase(pendingRecordingRef.current?.liveId === liveId ? 'FAILED' : 'UNAVAILABLE')
      throw recordingFailure
    } finally {
      recordingPipelineRef.current.delete(liveId)
    }
  }, [savePendingRecording, userId])

  const clearRoom = useCallback(async (room: Room) => {
    intentionalDisconnectRef.current.add(room)
    if (hostRoomRef.current === room && recorderRef.current) {
      const live = livesRef.current.find((entry) => entry.hostId === userId && entry.status === 'live')
      if (live) {
        try {
          await finalizeAndPublishRecording(live.id)
        } catch (recordingFailure) {
          setRecordingError(recordingFailure instanceof Error ? recordingFailure.message : 'The live replay could not be saved.')
        }
      }
    }
    if (roomRef.current === room) roomRef.current = null
    if (hostRoomRef.current === room) hostRoomRef.current = null
    setGuestRoom((current) => current === room ? null : current)
    setHostRoom((current) => current === room ? null : current)
    setRemoteTracks([])
    setNeedsAudioPlayback(false)
    setNeedsVideoPlayback(false)
    await room.disconnect(true)
  }, [finalizeAndPublishRecording, userId])

  const refreshLives = () => {
    setLoading(true)
    setError('')
    void loadLives()
  }

  useEffect(() => {
    const controller = new AbortController()
    void fetchLives(controller.signal)
      .then(({ lives: currentLives }) => { if (!controller.signal.aborted) applyLives(currentLives) })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : 'Unable to load live sessions.')
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [applyLives, fetchLives])

  useEffect(() => {
    const controller = new AbortController()
    void loadReplays(controller.signal)
    return () => controller.abort()
  }, [loadReplays])

  useEffect(() => {
    const source = openAuthenticatedEventStream('/api/realtime')
    const onLiveUpdate = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as { live?: LiveSession }
        if (!payload.live) return
        setLiveState(payload.live)
        if (payload.live.status === 'ended') {
          const room = roomRef.current
          if (room && (payload.live.hostId === user?.id || joinedLiveRef.current?.id === payload.live.id)) {
            void clearRoom(room)
            joinedLiveRef.current = null
            setJoinedLive(null)
          }
        }
      } catch {
        setError('A live session update could not be read. Refresh to retry.')
      }
    }
    source.addEventListener('live:update', onLiveUpdate)
    return () => source.close()
  }, [clearRoom, setLiveState, user?.id])

  useEffect(() => () => {
    const room = roomRef.current
    if (room) {
      intentionalDisconnectRef.current.add(room)
      const hostLive = hostRoomRef.current === room
        ? livesRef.current.find((live) => live.hostId === user?.id && live.status === 'live')
        : null
      const viewerLive = !hostLive && joinedLiveRef.current?.id
        ? joinedLiveRef.current
        : null
      const recordingPromise = hostLive && recorderRef.current
        ? finalizeAndPublishRecording(hostLive.id).catch((recordingFailure) => {
          console.error('Unable to finalize the live recording while leaving the live page.', recordingFailure)
          return null
        })
        : Promise.resolve(null)
      roomRef.current = null
      hostRoomRef.current = null
      setGuestRoom(null)
      void room.disconnect(true)
      const cleanupPath = hostLive
        ? `/api/live/${encodeURIComponent(hostLive.id)}/end`
        : viewerLive
          ? `/api/live/${encodeURIComponent(viewerLive.id)}/viewers/leave`
          : null
      if (cleanupPath) {
        void recordingPromise.then(() => apiRequest(cleanupPath, {
          method: 'POST',
          ...(hostLive ? {
            body: JSON.stringify({ recordingUnavailable: pendingRecordingRef.current?.liveId !== hostLive.id }),
          } : {}),
        }))
          .catch((cleanupError: unknown) => console.error('Unable to close live media while leaving the live page.', cleanupError))
      }
    }
  }, [finalizeAndPublishRecording, user?.id])

  const createLive = async (event: FormEvent) => {
    event.preventDefault()
    if (!newTitle.trim()) return
    setBusy(true)
    setError('')
    try {
      const response = await apiRequest<{ live: LiveSession }>('/api/live/create', {
        method: 'POST',
        body: JSON.stringify({ title: newTitle.trim(), description: newDescription.trim(), visibility: newVisibility }),
      })
      setLiveState(response.live)
      setNewTitle('')
      setNewDescription('')
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Unable to create a live session.')
    } finally {
      setBusy(false)
    }
  }

  const previewBroadcast = async (live: LiveSession) => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('This browser does not support camera and microphone preview.')
      return
    }
    setError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      })
      setPreviewLive(live)
      setPreviewStream(stream)
    } catch (previewError) {
      setError(previewError instanceof Error && ['NotAllowedError', 'SecurityError'].includes(previewError.name)
        ? 'Camera or microphone permission was denied. Allow both permissions, then try previewing again.'
        : previewError instanceof Error ? previewError.message : 'Unable to start camera preview.')
    }
  }

  const cancelPreview = () => {
    previewStream?.getTracks().forEach((track) => track.stop())
    setPreviewStream(null)
    setPreviewLive(null)
  }

  const startBroadcast = async (live: LiveSession) => {
    setBusy(true)
    setError('')
    cancelPreview()
    let room: Room | null = null
    try {
      const { token, url } = await apiRequest<{ token: string; url: string }>(`/api/live/${encodeURIComponent(live.id)}/token`, { method: 'POST' })
      const { Room, RoomEvent } = await import('livekit-client')
      room = new Room({ adaptiveStream: true, dynacast: true })
      roomRef.current = room
      hostRoomRef.current = room
      room.on(RoomEvent.Reconnecting, () => setError('LiveKit connection interrupted; attempting to reconnect…'))
      room.on(RoomEvent.Reconnected, () => setError(''))
      room.on(RoomEvent.Disconnected, () => {
        if (roomRef.current !== room) return
        const wasHost = hostRoomRef.current === room
        roomRef.current = null
        hostRoomRef.current = null
        setHostRoom(null)
        if (!intentionalDisconnectRef.current.has(room!)) {
          setError('The LiveKit broadcast disconnected.')
          if (livesRef.current.find((entry) => entry.id === live.id)?.status === 'live') {
            const recordingPromise = wasHost && recorderRef.current
              ? finalizeAndPublishRecording(live.id).catch((recordingFailure) => {
                setRecordingError(recordingFailure instanceof Error ? recordingFailure.message : 'The live replay could not be finalized.')
                return null
              })
              : Promise.resolve(null)
            void recordingPromise.then(() => apiRequest<{ live: LiveSession }>(`/api/live/${encodeURIComponent(live.id)}/end`, {
              method: 'POST',
              body: JSON.stringify({ recordingUnavailable: wasHost && pendingRecordingRef.current?.liveId !== live.id }),
            }))
              .then(({ live: ended }) => setLiveState(ended))
              .catch((disconnectError) => setError(disconnectError instanceof Error ? disconnectError.message : 'Unable to close the disconnected broadcast.'))
          }
        }
      })
      await room.connect(url, token)
      await room.localParticipant.setMicrophoneEnabled(true)
      await room.localParticipant.setCameraEnabled(true, { resolution: { width: 1280, height: 720 } })
      if (!room.localParticipant.getTrackPublication(cameraTrackSource)?.track || !room.localParticipant.getTrackPublication(microphoneTrackSource)?.track) {
        throw new Error('LiveKit did not publish the camera and microphone. The broadcast has not started.')
      }
      const response = await apiRequest<{ live: LiveSession; notificationWarning?: boolean }>(`/api/live/${encodeURIComponent(live.id)}/start`, { method: 'POST' })
      setLiveState(response.live)
      if (response.notificationWarning) setError('Your broadcast is live, but some follower notifications could not be saved. Affected followers can still discover the public broadcast from Live.')
      setHostRoom(room)
      setHostMuted(false)
      setHostCameraOn(true)
      setRecordingError('')
      try {
        const videoTrack = room.localParticipant.getTrackPublication(cameraTrackSource)?.track
        const audioTrack = room.localParticipant.getTrackPublication(microphoneTrackSource)?.track
        if (!videoTrack || !audioTrack || typeof MediaRecorder === 'undefined') throw new Error('This browser cannot record the live camera and microphone stream.')
        const stream = new MediaStream([videoTrack.mediaStreamTrack, audioTrack.mediaStreamTrack])
        const mimeType = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
          .find((candidate) => MediaRecorder.isTypeSupported(candidate))
        if (!mimeType) throw new Error('This browser does not support a compatible live replay recording format.')
        const recorder = new MediaRecorder(stream, { mimeType })
        recordingChunksRef.current = []
        recordingStartedAtRef.current = Date.now()
        recorder.ondataavailable = (event) => { if (event.data.size > 0) recordingChunksRef.current.push(event.data) }
        recorderRef.current = recorder
        recorder.start(1000)
        await apiRequest(`/api/live/${encodeURIComponent(live.id)}/recording/start`, { method: 'POST' })
        setRecordingPhase('RECORDING')
      } catch (recordError) {
        if (recorderRef.current) {
          try {
            await finalizeLiveRecording(recorderRef.current, recordingChunksRef.current)
          } catch {
            recordingChunksRef.current = []
          }
        }
        recorderRef.current = null
        setRecordingPhase('UNAVAILABLE')
        setRecordingError(recordError instanceof Error ? `Live video is on, but replay recording is unavailable: ${recordError.message}` : 'Live video is on, but replay recording is unavailable.')
      }
    } catch (startError) {
      let cleanupError = ''
      if (room) {
        try {
          await clearRoom(room)
        } catch (failure) {
          cleanupError = failure instanceof Error ? failure.message : 'Media cleanup failed.'
        }
      }
      const message = startError instanceof Error && ['NotAllowedError', 'SecurityError'].includes(startError.name)
        ? 'Camera or microphone permission was denied. Allow both permissions in your browser or device settings, then try again.'
        : startError instanceof Error && startError.name === 'NotFoundError'
          ? 'No camera or microphone was found on this device.'
          : startError instanceof Error ? startError.message : 'Unable to start the live broadcast.'
      setError([message, cleanupError].filter(Boolean).join(' '))
    } finally {
      setBusy(false)
    }
  }

  const endBroadcast = async (live: LiveSession) => {
    if (endInFlightRef.current) return
    endInFlightRef.current = true
    setBusy(true)
    setError('')
    setRecordingError('')
    let savedReplay: LiveReplay | null = null
    try {
      if (recorderRef.current || pendingRecordingRef.current?.liveId === live.id) {
        savedReplay = await finalizeAndPublishRecording(live.id)
      } else {
        setRecordingPhase('UNAVAILABLE')
        setRecordingError(recordingError || 'No replay recording was available from this device.')
      }
    } catch (recordError) {
      setRecordingError(recordError instanceof Error ? recordError.message : 'The live replay could not be finalized or stored.')
      if (pendingRecordingRef.current?.liveId === live.id) setRecordingRetryLiveId(live.id)
    } finally {
      recorderRef.current = null
    }
    try {
      const recordingUnavailable = live.recordingStatus === 'RECORDING'
        && !savedReplay
        && pendingRecordingRef.current?.liveId !== live.id
      const response = await apiRequest<{ live: LiveSession; persistenceWarning?: boolean }>(`/api/live/${encodeURIComponent(live.id)}/end`, {
        method: 'POST',
        body: JSON.stringify({ recordingUnavailable }),
      })
      setLiveState(response.live)
      if (response.persistenceWarning) {
        setRecordingError((current) => [current, 'The broadcast ended, but its session history could not be saved. Configure the server DATABASE_URL, apply Prisma migrations, and ensure PostgreSQL is reachable.'].filter(Boolean).join(' '))
      }
      if (hostRoomRef.current) await clearRoom(hostRoomRef.current)
      if (savedReplay) setReplayChoice(savedReplay)
    } catch (endError) {
      setError(endError instanceof Error ? endError.message : 'Unable to end this live session.')
    } finally {
      if (hostRoomRef.current) {
        try {
          await clearRoom(hostRoomRef.current)
        } catch (cleanupError) {
          setError(cleanupError instanceof Error ? cleanupError.message : 'Unable to release broadcast media.')
        }
      }
      setBusy(false)
      endInFlightRef.current = false
    }
  }

  const retrySaveRecording = useCallback(async () => {
    if (recordingRetryBusy || !recordingRetryLiveId) return
    setRecordingRetryBusy(true)
    try {
      await savePendingRecording(recordingRetryLiveId)
    } catch (retryError) {
      setRecordingPhase('FAILED')
      setRecordingError(retryError instanceof Error ? retryError.message : 'Unable to save the replay. Check your connection and retry.')
    } finally {
      setRecordingRetryBusy(false)
    }
  }, [recordingRetryBusy, recordingRetryLiveId, savePendingRecording])

  useEffect(() => {
    if (!userId || !recordingRetryLiveId || autoRecoveryAttemptRef.current.has(recordingRetryLiveId)) return
    autoRecoveryAttemptRef.current.add(recordingRetryLiveId)
    void retrySaveRecording()
  }, [recordingRetryLiveId, retrySaveRecording, userId])

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement))
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && fullscreenFallback) {
        setFullscreenFallback(false)
        setIsFullscreen(false)
      }
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [fullscreenFallback])

  const toggleFullscreen = async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen()
      return
    }
    const container = liveContainerRef.current
    if (container?.requestFullscreen) {
      try {
        await container.requestFullscreen()
      } catch (fullscreenError) {
        setError(fullscreenError instanceof Error ? fullscreenError.message : 'Fullscreen mode could not be opened.')
      }
    } else {
        const nextFullscreen = !fullscreenFallback
        setFullscreenFallback(nextFullscreen)
        setIsFullscreen(nextFullscreen)
    }
  }

  const toggleHostMute = async () => {
    const room = hostRoomRef.current ?? guestRoom
    if (!room) return
    const nextMuted = !hostMuted
    try {
      await room.localParticipant.setMicrophoneEnabled(!nextMuted)
      setHostMuted(nextMuted)
    } catch (mediaError) {
      setError(mediaError instanceof Error ? mediaError.message : 'Unable to update microphone state.')
    }
  }

  const toggleHostCamera = async () => {
    const room = hostRoomRef.current ?? guestRoom
    if (!room) return
    const nextCameraOn = !hostCameraOn
    try {
      await room.localParticipant.setCameraEnabled(nextCameraOn)
      setHostCameraOn(nextCameraOn)
    } catch (mediaError) {
      setError(mediaError instanceof Error ? mediaError.message : 'Unable to update camera state.')
    }
  }

  const switchHostCamera = async () => {
    const room = hostRoomRef.current
    if (!room || !hostCameraOn || cameraSwitchBusy) return
    setCameraSwitchBusy(true)
    setError('')
    try {
      const cameraTrack = room.localParticipant.getTrackPublication(cameraTrackSource)?.track
      if (!cameraTrack) throw new Error('Your camera is not active. Turn it on before switching cameras.')
      if (!navigator.mediaDevices?.enumerateDevices) throw new Error('This browser does not support camera device selection.')
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'videoinput')
      const settings = cameraTrack.mediaStreamTrack.getSettings()
      await switchToNextCamera(devices, room.getActiveDevice('videoinput') ?? settings.deviceId, settings.facingMode, (deviceId) =>
        room.switchActiveDevice('videoinput', deviceId, true))
    } catch (switchError) {
      setError(cameraSwitchErrorMessage(switchError))
    } finally {
      setCameraSwitchBusy(false)
    }
  }

  const joinLive = async (live: LiveSession, publishAsGuest = false) => {
    setBusy(true)
    setError('')
    let room: Room | null = null
    let viewerJoined = false
    try {
      const response = await apiRequest<{ live: LiveSession }>(`/api/live/${encodeURIComponent(live.id)}/viewers/join`, { method: 'POST' })
      viewerJoined = true
      joinedLiveRef.current = response.live
      setJoinedLive(response.live)
      setLiveState(response.live)
      const tokenPath = publishAsGuest ? 'stage/token' : 'token'
      const { token, url } = await apiRequest<{ token: string; url: string }>(`/api/live/${encodeURIComponent(live.id)}/${tokenPath}`, { method: 'POST' })
      const { Room, RoomEvent } = await import('livekit-client')
      room = new Room({ adaptiveStream: true, dynacast: true })
      roomRef.current = room
      room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
        const key = `${participant.identity}:${track.sid ?? track.mediaStreamTrack.id}`
        setRemoteTracks((current) => current.some((entry) => entry.key === key) ? current : [...current, { key, track }])
      })
      room.on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
        const key = `${participant.identity}:${track.sid ?? track.mediaStreamTrack.id}`
        track.detach()
        setRemoteTracks((current) => current.filter((entry) => entry.key !== key))
      })
      room.on(RoomEvent.AudioPlaybackStatusChanged, (playing) => setNeedsAudioPlayback(!playing))
      room.on(RoomEvent.VideoPlaybackStatusChanged, (playing) => setNeedsVideoPlayback(!playing))
      room.on(RoomEvent.Reconnecting, () => setError('LiveKit connection interrupted; attempting to reconnect…'))
      room.on(RoomEvent.Reconnected, () => setError(''))
      room.on(RoomEvent.Disconnected, () => {
        if (roomRef.current !== room) return
        roomRef.current = null
        setGuestRoom(null)
        setRemoteTracks([])
        if (!intentionalDisconnectRef.current.has(room!)) {
          setNeedsAudioPlayback(false)
          setNeedsVideoPlayback(false)
          joinedLiveRef.current = null
          setJoinedLive(null)
          setError('The live session disconnected.')
          void apiRequest(`/api/live/${encodeURIComponent(live.id)}/viewers/leave`, { method: 'POST' })
            .catch((leaveError) => setError(leaveError instanceof Error ? leaveError.message : 'Unable to update live viewer status.'))
        }
      })
      await room.connect(url, token)
      const admittedGuest = response.live.guests?.some((guest) => guest.userId === user?.id && guest.status === 'LIVE' && Boolean(guest.admittedAt))
      if (publishAsGuest && !admittedGuest) {
        throw new Error('Guest stage access is no longer available. Ask the host to approve your request again.')
      }
      const heartbeat = await apiRequest<{ live: LiveSession }>(`/api/live/${encodeURIComponent(live.id)}/viewers/heartbeat`, { method: 'POST' })
      setLiveState(heartbeat.live)
      if (admittedGuest && publishAsGuest) {
        await room.localParticipant.setMicrophoneEnabled(true)
        await room.localParticipant.setCameraEnabled(true)
        setGuestRoom(room)
        setHostMuted(false)
        setHostCameraOn(true)
      }
    } catch (joinError) {
      let cleanupError = ''
      if (room) {
        try {
          await clearRoom(room)
        } catch (failure) {
          cleanupError = failure instanceof Error ? failure.message : 'Media cleanup failed.'
        }
      }
      if (viewerJoined) {
        try {
          await apiRequest(`/api/live/${encodeURIComponent(live.id)}/viewers/leave`, { method: 'POST' })
        } catch (failure) {
          cleanupError = [cleanupError, failure instanceof Error ? failure.message : 'Viewer membership cleanup failed.'].filter(Boolean).join(' ')
        }
        joinedLiveRef.current = null
        setJoinedLive(null)
      }
      setError([joinError instanceof Error ? joinError.message : 'Unable to join this live session.', cleanupError].filter(Boolean).join(' '))
    } finally {
      setBusy(false)
    }
  }

  const leaveLive = async () => {
    const currentLive = joinedLiveRef.current
    if (!currentLive) return
    setBusy(true)
    setError('')
    try {
      if (roomRef.current) await clearRoom(roomRef.current)
      await apiRequest(`/api/live/${encodeURIComponent(currentLive.id)}/viewers/leave`, { method: 'POST' })
      joinedLiveRef.current = null
      setJoinedLive(null)
      await loadLives()
    } catch (leaveError) {
      setError(leaveError instanceof Error ? leaveError.message : 'Unable to leave this session.')
    } finally {
      setBusy(false)
    }
  }

  const enablePlayback = async () => {
    const room = roomRef.current
    if (!room) return
    try {
      await room.startAudio()
      setNeedsAudioPlayback(false)
      await room.startVideo()
      setNeedsVideoPlayback(false)
    } catch (playbackError) {
      setError(playbackError instanceof Error ? playbackError.message : 'Unable to start media playback.')
    }
  }

  const postComment = async (event: FormEvent) => {
    event.preventDefault()
    if (!joinedLive || !comment.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      const response = await apiRequest<{ comment: LiveComment }>(`/api/live/${encodeURIComponent(joinedLive.id)}/comment`, { method: 'POST', body: JSON.stringify({ text: comment.trim() }) })
      setJoinedLive((current) => current
        ? { ...current, comments: current.comments.some((entry) => entry.id === response.comment.id) ? current.comments : [...current.comments, response.comment] }
        : current)
      setComment('')
    } catch (commentError) {
      setError(commentError instanceof Error ? commentError.message : 'Unable to post your comment.')
    } finally {
      setBusy(false)
    }
  }

  const requestGuestSpot = async (live: LiveSession, role: 'GUEST' | 'COHOST') => {
    setError('')
    try {
      const response = await apiRequest<{ live: LiveSession }>(`/api/live/${encodeURIComponent(live.id)}/guests/request`, {
        method: 'POST',
        body: JSON.stringify({ role }),
      })
      setLiveState(response.live)
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to request a guest spot.')
    }
  }

  const updateGuest = async (live: LiveSession, userId: string, action: 'approve' | 'remove') => {
    setError('')
    try {
      const response = await apiRequest<{ live: LiveSession }>(`/api/live/${encodeURIComponent(live.id)}/guests/${encodeURIComponent(userId)}/${action}`, { method: 'POST' })
      setLiveState(response.live)
    } catch (guestError) {
      setError(guestError instanceof Error ? guestError.message : 'Unable to update guest access.')
    }
  }

  const updateViewerControl = async (live: LiveSession, userId: string, action: 'mute' | 'remove' | 'block', isMuted?: boolean) => {
    setError('')
    try {
      const path = action === 'block'
        ? `/api/live/${encodeURIComponent(live.id)}/block/${encodeURIComponent(userId)}`
        : `/api/live/${encodeURIComponent(live.id)}/viewer/${encodeURIComponent(userId)}/${action}`
      const response = await apiRequest<{ live: LiveSession }>(path, {
        method: 'POST',
        ...(action === 'mute' ? { body: JSON.stringify({ isMuted: Boolean(isMuted) }) } : {}),
      })
      setLiveState(response.live)
    } catch (controlError) {
      setError(controlError instanceof Error ? controlError.message : 'Unable to update viewer access.')
    }
  }

  const removeLiveComment = async (live: LiveSession, commentId: string) => {
    setError('')
    try {
      const response = await apiRequest<{ live: LiveSession }>(`/api/live/${encodeURIComponent(live.id)}/comments/${encodeURIComponent(commentId)}/remove`, { method: 'POST' })
      if (response.live) setLiveState(response.live)
    } catch (moderationError) {
      setError(moderationError instanceof Error ? moderationError.message : 'Unable to remove the live comment.')
    }
  }

  const joinGuestStage = async (live: LiveSession) => {
    if (!activeLive || !approvedGuest) return
    try {
      const response = await apiRequest<{ live: LiveSession }>(`/api/live/${encodeURIComponent(live.id)}/guests/stage/join`, { method: 'POST' })
      setLiveState(response.live)
      await leaveLive()
      await joinLive(response.live, true)
    } catch (stageError) {
      setError(stageError instanceof Error ? stageError.message : 'Unable to join the guest stage.')
    }
  }

  const react = async (live: LiveSession) => {
    try {
      await apiRequest(`/api/live/${encodeURIComponent(live.id)}/react`, { method: 'POST', body: JSON.stringify({ type: 'LIKE' }) })
    } catch (reactionError) {
      setError(reactionError instanceof Error ? reactionError.message : 'Unable to react to this session.')
    }
  }

  const publishReplay = async (replay: LiveReplay) => {
    if (replayActionInFlightRef.current) return
    replayActionInFlightRef.current = true
    setReplayBusy(true)
    setReplayActionError('')
    setError('')
    try {
      const response = await apiRequest<{ replay: LiveReplay; post: { id: string }; duplicate: boolean }>(`/api/live/${encodeURIComponent(replay.id)}/replay/publish`, {
        method: 'POST',
        body: JSON.stringify({ content: replay.title, visibility: replayVisibility }),
      })
      setReplays((current) => current.map((entry) => entry.id === replay.id ? response.replay : entry))
      setReplayChoice(null)
    } catch (publishError) {
      setReplayActionError(publishError instanceof Error ? publishError.message : 'Unable to publish this replay. Check your connection and retry.')
    } finally {
      replayActionInFlightRef.current = false
      setReplayBusy(false)
    }
  }

  const deleteReplay = async (replay: LiveReplay) => {
    if (!window.confirm('Delete this unpublished live replay? This cannot be undone.')) return
    if (replayActionInFlightRef.current) return
    replayActionInFlightRef.current = true
    setReplayBusy(true)
    setReplayActionError('')
    setError('')
    try {
      await apiRequest(`/api/live/${encodeURIComponent(replay.id)}/replay`, { method: 'DELETE' })
      setReplays((current) => current.filter((entry) => entry.id !== replay.id))
      setReplayChoice(null)
    } catch (deleteError) {
      const message = deleteError instanceof Error ? deleteError.message : 'Unable to delete this replay. Check your connection and retry.'
      if (replayChoice?.id === replay.id) setReplayActionError(message)
      else setError(message)
    } finally {
      replayActionInFlightRef.current = false
      setReplayBusy(false)
    }
  }

  const shareLive = async (live: LiveSession) => {
    const url = `${window.location.origin}/live?live=${encodeURIComponent(live.id)}`
    try {
      if (navigator.share) await navigator.share({ title: live.title, text: `Watch ${live.title} on novachat`, url })
      else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(url)
      else if (window.prompt('Copy this live broadcast link:', url) === null) return
      setShareNotice('Live broadcast link is ready to share.')
      window.setTimeout(() => setShareNotice(''), 3000)
    } catch (shareError) {
      if (shareError instanceof DOMException && shareError.name === 'AbortError') return
      setError(shareError instanceof Error ? shareError.message : 'Unable to share this live broadcast.')
    }
  }

  useEffect(() => {
    const targetId = searchParams.get('live')
    if (!targetId || loading || busy || joinedLive?.id === targetId || attemptedNotificationLiveRef.current === targetId) return
    const live = lives.find((entry) => entry.id === targetId)
    if (!live) {
      attemptedNotificationLiveRef.current = targetId
      setError('This live broadcast is no longer available or you do not have permission to join.')
      return
    }
    if (live.status !== 'live') {
      attemptedNotificationLiveRef.current = targetId
      setError('This live broadcast has ended.')
      return
    }
    attemptedNotificationLiveRef.current = targetId
    void joinLive(live)
  }, [busy, joinLive, joinedLive?.id, lives, loading, searchParams])

  const hostLive = lives.find((live) => live.hostId === user?.id && live.status === 'live')
  const localVideoTrack = hostRoom?.localParticipant.getTrackPublication(cameraTrackSource)?.track
    ?? guestRoom?.localParticipant.getTrackPublication(cameraTrackSource)?.track
  const remoteVideoTracks = remoteTracks.filter(({ track }) => track.kind === 'video')
  const remoteAudioTracks = remoteTracks.filter(({ track }) => track.kind === 'audio')
  const activeLive = joinedLive ?? (hostLive && hostRoom ? hostLive : previewLive)
  const isHost = Boolean(activeLive && activeLive.hostId === user?.id)
  const canModerate = Boolean(activeLive && (isHost || activeLive.moderators.includes(user?.id ?? '')))
  const currentViewer = activeLive?.viewers.find((viewer) => viewer.userId === user?.id)
  const interactionRestricted = Boolean(activeLive && user && (
    activeLive.blockedUserIds.includes(user.id)
    || activeLive.mutedUserIds.includes(user.id)
    || currentViewer?.isBlocked
    || currentViewer?.isMuted
  ))
  const approvedGuest = Boolean(activeLive?.guests.some((guest) => guest.userId === user?.id && guest.status === 'LIVE'))

  useEffect(() => {
    if (!joinedLive?.id) return
    const liveId = joinedLive.id
    let active = true
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const heartbeat = await apiRequest<{ live: LiveSession }>(`/api/live/${encodeURIComponent(liveId)}/viewers/heartbeat`, { method: 'POST' })
          if (active) setLiveState(heartbeat.live)
        } catch (pollError) {
          if (active) setError(pollError instanceof Error ? pollError.message : 'Live audience status could not be refreshed.')
        }
      })()
    }, 15_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [joinedLive?.id, setLiveState])

  return (
    <>
    {activeLive ? <section ref={liveContainerRef} className="fixed inset-0 z-[60] h-[100dvh] w-screen overflow-hidden bg-slate-950 text-white" aria-label="Live video session">
      <div className="absolute inset-0 bg-slate-950">
        {previewLive?.id === activeLive.id && previewStream ? <video ref={previewVideoRef} muted autoPlay playsInline className="h-full w-full object-contain" /> : (isHost || approvedGuest) && localVideoTrack ? <AttachedTrack track={localVideoTrack} muted className="h-full w-full object-contain" /> : remoteVideoTracks.map(({ key, track }) => <AttachedTrack key={key} track={track} className="h-full w-full object-contain" />)}
        {!isHost && !approvedGuest && remoteVideoTracks.length === 0 ? <div className="absolute inset-0 flex items-center justify-center px-8 text-center text-sm text-white/80" role="status">Connecting to the live video…</div> : null}
        {isHost && !hostCameraOn ? <div className="absolute inset-0 flex items-center justify-center text-white/70"><VideoOff className="h-12 w-12" aria-hidden="true" /><span className="sr-only">Camera is off</span></div> : null}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/70 via-transparent to-black/80" />
      </div>

      <header className="absolute inset-x-0 top-0 flex max-h-[36dvh] flex-wrap items-start justify-between gap-3 overflow-y-auto overscroll-contain px-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide"><span className={`rounded-full px-2 py-1 ${activeLive.status === 'live' ? 'bg-rose-600' : 'bg-amber-500'}`}>{activeLive.status === 'live' ? 'LIVE' : 'PREVIEW'}</span><span className="inline-flex items-center gap-1"><Users className="h-4 w-4" aria-hidden="true" />{activeLive.viewerCount}</span></p>
            <h1 className="mt-1 max-w-[55vw] truncate text-base font-semibold sm:max-w-md">{activeLive.title}</h1>
            <p className="truncate text-xs text-white/75">{isHost ? user?.name : activeLive.host?.name ?? 'novachat host'}</p>
          </div>
        </div>
        <div className="flex max-w-full flex-wrap justify-end gap-2">
          {isHost && activeLive.status === 'live' ? <>
            <button type="button" aria-label={hostMuted ? 'Unmute microphone' : 'Mute microphone'} title={hostMuted ? 'Unmute microphone' : 'Mute microphone'} onClick={() => void toggleHostMute()} className="flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-full bg-black/55 px-3 text-sm text-white ring-1 ring-white/20 hover:bg-black/75">{hostMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}<span className="hidden sm:inline">{hostMuted ? 'Unmute' : 'Mute'}</span></button>
            <button type="button" aria-label={hostCameraOn ? 'Turn camera off' : 'Turn camera on'} title={hostCameraOn ? 'Turn camera off' : 'Turn camera on'} onClick={() => void toggleHostCamera()} className="flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-full bg-black/55 px-3 text-sm text-white ring-1 ring-white/20 hover:bg-black/75">{hostCameraOn ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}<span className="hidden sm:inline">{hostCameraOn ? 'Camera on' : 'Camera off'}</span></button>
            {hostCameraOn ? <button type="button" aria-label="Switch camera" title="Switch camera" onClick={() => void switchHostCamera()} disabled={cameraSwitchBusy} className="flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-full bg-black/55 px-3 text-sm text-white ring-1 ring-white/20 hover:bg-black/75 disabled:opacity-60"><RefreshCw className={`h-5 w-5 ${cameraSwitchBusy ? 'animate-spin' : ''}`} /><span className="hidden sm:inline">Flip</span></button> : null}
            <button type="button" aria-label="End broadcast" title="End broadcast" onClick={() => { if (window.confirm('End your live broadcast?')) void endBroadcast(activeLive) }} disabled={busy} className="flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-full bg-rose-600 px-3 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-60"><PhoneOff className="h-5 w-5" /><span className="hidden sm:inline">End</span></button>
          </> : isHost ? <>
            <button type="button" onClick={() => void startBroadcast(activeLive)} disabled={busy} className="min-h-11 rounded-full bg-rose-600 px-4 text-sm font-semibold text-white disabled:opacity-60">Start broadcast</button>
            <button type="button" onClick={cancelPreview} className="min-h-11 rounded-full bg-black/55 px-4 text-sm font-semibold text-white ring-1 ring-white/20">Cancel preview</button>
          </> : <>
            <button type="button" aria-label="Share live broadcast" title="Share live broadcast" onClick={() => void shareLive(activeLive)} className="flex min-h-11 min-w-11 items-center justify-center rounded-full bg-black/55 p-3 ring-1 ring-white/20 hover:bg-black/75"><Share2 className="h-5 w-5" /></button>
            {approvedGuest && guestRoom ? <>
              <button type="button" aria-label={hostMuted ? 'Unmute microphone' : 'Mute microphone'} onClick={() => void toggleHostMute()} className="flex min-h-11 min-w-11 items-center justify-center rounded-full bg-black/55 p-3 ring-1 ring-white/20">{hostMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}</button>
              <button type="button" aria-label={hostCameraOn ? 'Turn camera off' : 'Turn camera on'} onClick={() => void toggleHostCamera()} className="flex min-h-11 min-w-11 items-center justify-center rounded-full bg-black/55 p-3 ring-1 ring-white/20">{hostCameraOn ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}</button>
            </> : null}
            <button type="button" aria-label="Leave live broadcast" title="Leave live broadcast" onClick={() => void leaveLive()} disabled={busy} className="flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-full bg-black/55 px-3 text-sm text-white ring-1 ring-white/20 hover:bg-black/75"><PhoneOff className="h-5 w-5" /><span className="hidden sm:inline">Leave</span></button>
          </>}
          <button type="button" aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} onClick={() => void toggleFullscreen()} className="flex min-h-11 min-w-11 items-center justify-center rounded-full bg-black/55 p-3 text-white ring-1 ring-white/20 hover:bg-black/75">
            {isFullscreen ? <Minimize className="h-5 w-5" aria-hidden="true" /> : <Maximize className="h-5 w-5" aria-hidden="true" />}
          </button>
        </div>
      </header>

      {error ? <p className="absolute left-3 right-3 top-[max(5rem,calc(env(safe-area-inset-top)+4.5rem))] mx-auto max-w-xl rounded-xl bg-black/75 p-3 text-center text-sm text-white" role="alert">{error}</p> : null}
      {!isHost && approvedGuest && !guestRoom ? <button type="button" onClick={() => void joinGuestStage(activeLive)} disabled={busy} className="absolute left-3 top-[max(5rem,calc(env(safe-area-inset-top)+4.5rem))] min-h-11 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">Join the stage</button> : null}
      {canModerate ? <details aria-label="Live moderation controls" className="absolute right-3 top-[max(5rem,calc(env(safe-area-inset-top)+4.5rem))] max-h-[45dvh] w-72 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl bg-black/80 text-xs text-white ring-1 ring-white/20">
        <summary className="min-h-11 cursor-pointer list-none px-3 py-3 font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-white">Live controls · {activeLive.guests.filter((guest) => guest.status === 'REQUESTED').length} requests · {activeLive.viewerCount} viewers</summary>
        <div className="max-h-[calc(45dvh-3rem)] space-y-3 overflow-y-auto overscroll-contain px-3 pb-3">
        <div><h2 className="font-semibold">Guest requests</h2>
          {activeLive.guests.filter((guest) => guest.status !== 'REMOVED').map((guest) => <div key={guest.userId} className="mt-2 flex items-center justify-between gap-2">
            <span className="truncate">{guest.userId} · {guest.role.toLowerCase()} · {guest.status.toLowerCase()}</span>
            {guest.status === 'REQUESTED' ? <button type="button" onClick={() => void updateGuest(activeLive, guest.userId, 'approve')} className="rounded bg-emerald-700 px-2 py-1 font-semibold">Approve</button> : null}
            {guest.admittedAt ? <button type="button" aria-label={`${activeLive.mutedUserIds.includes(guest.userId) ? 'Unmute' : 'Mute'} stage guest ${guest.userId}`} onClick={() => void updateViewerControl(activeLive, guest.userId, 'mute', !activeLive.mutedUserIds.includes(guest.userId))} className="rounded bg-slate-700 px-2 py-1">{activeLive.mutedUserIds.includes(guest.userId) ? 'Unmute' : 'Mute'}</button> : null}
            <button type="button" onClick={() => void updateGuest(activeLive, guest.userId, 'remove')} className="rounded bg-rose-700 px-2 py-1 font-semibold">Remove</button>
          </div>)}
          {!activeLive.guests.some((guest) => guest.status === 'REQUESTED') ? <p className="mt-1 text-white/65">No pending requests.</p> : null}
        </div>
        <div><h2 className="font-semibold">Viewers</h2>
          {activeLive.viewers.map((viewer) => <div key={viewer.userId} className="mt-2 flex flex-wrap items-center justify-between gap-1">
            <span className="max-w-32 truncate">{viewer.userId}</span>
            <button type="button" onClick={() => void updateViewerControl(activeLive, viewer.userId, 'mute', !viewer.isMuted)} className="rounded bg-slate-700 px-2 py-1">{viewer.isMuted ? 'Unmute' : 'Mute'}</button>
            <button type="button" onClick={() => void updateViewerControl(activeLive, viewer.userId, 'remove')} className="rounded bg-rose-700 px-2 py-1">Remove</button>
            <button type="button" onClick={() => void updateViewerControl(activeLive, viewer.userId, 'block')} className="rounded bg-rose-900 px-2 py-1">Block</button>
          </div>)}
        </div>
        </div>
      </details> : null}
      {!isHost && (needsAudioPlayback || needsVideoPlayback) ? <button type="button" onClick={() => void enablePlayback()} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white px-5 py-3 font-semibold text-slate-900 shadow-lg"><Volume2 className="mr-2 inline h-5 w-5" aria-hidden="true" />Tap to enable sound</button> : null}
      {isHost && recordingPhase !== 'IDLE' ? <p className="absolute bottom-36 left-3 right-3 mx-auto max-w-lg rounded-xl bg-black/75 p-2 text-center text-xs text-white" role="status">Replay: {recordingPhase.toLowerCase()}</p> : null}
      {recordingError && isHost ? <p className="absolute bottom-24 left-3 right-3 mx-auto max-w-lg rounded-xl bg-amber-950/90 p-3 text-center text-xs text-amber-50" role="status">{recordingError}</p> : null}
      {shareNotice ? <p className="absolute bottom-36 left-3 right-3 text-center text-sm text-white" role="status">{shareNotice}</p> : null}

      {!isHost ? <div className="absolute inset-x-0 bottom-0 flex max-h-[40dvh] flex-col bg-gradient-to-t from-black/85 to-transparent px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-12 sm:px-6">
        <ul className="mb-3 max-h-32 space-y-1 overflow-y-auto text-sm" aria-label="Live comments">{joinedLive?.comments.slice(-30).map((entry) => <li key={entry.id} className="flex w-fit max-w-full items-center gap-2 rounded-xl bg-black/45 px-3 py-2 text-white">{entry.text}{canModerate ? <button type="button" aria-label={`Remove comment ${entry.id}`} onClick={() => void removeLiveComment(activeLive, entry.id)} className="rounded bg-rose-700 px-2 py-1 text-xs">Remove</button> : null}</li>)}</ul>
        <div className="flex items-center gap-2">
          <form onSubmit={(event) => void postComment(event)} className="flex min-w-0 flex-1 gap-2">
            <input value={comment} onChange={(event) => setComment(event.target.value)} maxLength={500} aria-label="Live comment" placeholder={interactionRestricted ? 'Commenting is restricted' : 'Add a comment…'} disabled={interactionRestricted} className="min-h-11 min-w-0 flex-1 rounded-full border border-white/25 bg-black/50 px-4 text-sm text-white placeholder:text-white/65 outline-none focus:border-white disabled:opacity-60" />
            <button type="submit" aria-label="Send comment" disabled={busy || interactionRestricted || !comment.trim()} className="min-h-11 min-w-11 rounded-full bg-white text-slate-900 disabled:opacity-50"><Send className="mx-auto h-4 w-4" aria-hidden="true" /></button>
          </form>
          <button type="button" aria-label="Like live broadcast" onClick={() => void react(activeLive)} disabled={interactionRestricted} className="min-h-11 min-w-11 rounded-full bg-rose-600 text-white disabled:opacity-50"><Heart className="mx-auto h-5 w-5" aria-hidden="true" /></button>
        </div>
        {interactionRestricted ? <p className="mt-2 text-xs text-white/75" role="status">You cannot comment or react in this broadcast.</p> : null}
      </div> : null}
      {remoteAudioTracks.map(({ key, track }) => <AttachedTrack key={key} track={track} className="sr-only" />)}
    </section> : <div className="space-y-5 p-4 sm:p-6">
      <header>
        <p className="inline-flex items-center gap-2 text-xs font-semibold uppercase text-indigo-700"><Radio className="h-4 w-4" aria-hidden="true" /> Live</p>
        <h2 className="mt-2 text-2xl font-semibold text-slate-900">Live sessions</h2>
      </header>

      <div className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900" role="status">Live broadcasts use LiveKit for encrypted, low-latency audio and video. Your administrator must configure the LiveKit media server.</div>
      {error ? <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700" role="alert">{error}</p> : null}
      {recordingError ? <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="status"><p>{recordingError}</p>{recordingRetryLiveId ? <Button variant="secondary" size="sm" className="mt-2" onClick={() => void retrySaveRecording()} disabled={recordingRetryBusy}>{recordingRetryBusy ? recordingUploadProgress === null ? 'Saving replay…' : `Uploading replay ${recordingUploadProgress}%…` : 'Retry upload and publish'}</Button> : null}</div> : null}

      <form onSubmit={(event) => void createLive(event)} className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4">
        <h3 className="font-semibold text-slate-900">Create a live session</h3>
        <input aria-label="Live session title" required maxLength={120} value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="What are you going live about?" className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
        <textarea aria-label="Live session description" maxLength={1000} value={newDescription} onChange={(event) => setNewDescription(event.target.value)} placeholder="Add a description (optional)" className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
        <label className="flex items-center justify-between gap-3 text-sm text-slate-700">Live audience
          <select aria-label="Live audience" value={newVisibility} onChange={(event) => setNewVisibility(event.target.value as typeof newVisibility)} className="rounded-lg border border-slate-200 bg-white px-3 py-2">
            <option value="public">Public</option><option value="followers">Followers</option><option value="private">Private</option>
          </select>
        </label>
        <div className="flex justify-end"><Button type="submit" variant="primary" size="sm" disabled={busy || !newTitle.trim()}>Create session</Button></div>
      </form>

      {loading ? <p className="rounded-xl bg-white p-4 text-sm text-slate-500">Loading sessions…</p> : null}
      {!loading && lives.length === 0 && !error ? <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">No live sessions are available.</p> : null}
      <ul className="divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-white">
        {lives.map((live) => (
          <li key={live.id} className="flex flex-wrap items-center gap-3 p-4">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-700"><Headphones className="h-5 w-5" aria-hidden="true" /></span>
            <div className="min-w-0 flex-1"><h3 className="truncate font-semibold text-slate-900">{live.title}</h3><p className="mt-1 text-sm text-slate-500">{live.description || `Hosted by ${live.host?.name ?? (live.hostId === user?.id ? 'you' : 'a novachat member')}`} · {live.viewerCount} viewers · {live.status}</p></div>
            {live.hostId === user?.id && live.status === 'paused' && previewLive?.id !== live.id ? <Button variant="secondary" size="sm" onClick={() => void previewBroadcast(live)} disabled={busy}>Preview camera</Button> : null}
            {live.hostId === user?.id && live.status === 'paused' ? <Button variant="primary" size="sm" onClick={() => void startBroadcast(live)} disabled={busy}>Start broadcasting</Button> : null}
            {live.hostId === user?.id && live.status === 'live' && !hostRoom ? <Button variant="secondary" size="sm" onClick={() => void endBroadcast(live)} disabled={busy}>Finish ending</Button> : null}
            {live.hostId !== user?.id && live.status === 'live' && joinedLive?.id !== live.id ? <Button variant="primary" size="sm" onClick={() => void joinLive(live)} disabled={busy}>Join live</Button> : null}
            {live.hostId !== user?.id && live.status === 'live' && joinedLive?.id !== live.id && !live.guests.some((guest) => guest.userId === user?.id && guest.status !== 'REMOVED') ? <>
              <select aria-label={`Stage role for ${live.title}`} value={guestRole} onChange={(event) => setGuestRole(event.target.value as typeof guestRole)} className="min-h-10 rounded-lg border border-slate-200 bg-white px-2 text-xs">
                <option value="GUEST">Guest</option>
                <option value="COHOST">Co-host</option>
              </select>
              <Button variant="secondary" size="sm" onClick={() => void requestGuestSpot(live, guestRole)} disabled={busy}>Request guest spot</Button>
            </> : null}
          </li>
        ))}
      </ul>

      {replays.length ? <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <h2 className="font-semibold text-slate-900">Saved live replays</h2>
        <ul className="mt-3 space-y-3">{replays.map((replay) => <li key={replay.id} className="flex flex-wrap items-center gap-3 rounded-xl bg-slate-50 p-3">
          <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-slate-900">{replay.title}</p><p className="text-xs text-slate-500">{new Date(replay.createdAt).toLocaleString()} · {replay.status === 'PUBLISHED' ? 'Published' : replay.status === 'DELETING' ? 'Delete pending' : `${replay.durationSeconds}s`}</p></div>
          {replay.status === 'READY' ? <><Button variant="primary" size="sm" onClick={() => { setReplayChoice(replay); setReplayActionError('') }}>SAVE AND POST</Button><Button variant="secondary" size="sm" onClick={() => void deleteReplay(replay)}>DELETE</Button></> : null}
          {replay.status === 'DELETING' ? <Button variant="secondary" size="sm" onClick={() => void deleteReplay(replay)}>RETRY DELETE</Button> : null}
          {replay.status === 'PUBLISHED' ? <Button variant="secondary" size="sm" onClick={() => { setReplayChoice(replay); setReplayActionError('') }}>PREVIEW</Button> : null}
        </li>)}</ul>
      </section> : null}
      {replaysLoading ? <p className="text-sm text-slate-500" role="status">Loading saved replays…</p> : null}
      {replayLoadError ? <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700" role="alert"><p>{replayLoadError}</p><Button variant="secondary" size="sm" className="mt-2" onClick={() => void retryLoadReplays()} disabled={replaysLoading}>{replaysLoading ? 'Retrying…' : 'Retry'}</Button></div> : null}
      <div className="flex justify-end"><Button variant="secondary" size="sm" onClick={refreshLives} disabled={loading}><Users className="h-4 w-4" aria-hidden="true" /> Refresh</Button></div>
    </div>}
    {replayChoice ? <div className="fixed inset-0 z-[70] flex items-end justify-center bg-slate-950/60 p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="live-replay-title">
      <section className="w-full max-w-lg rounded-t-3xl bg-white p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:rounded-3xl">
        <h2 id="live-replay-title" className="text-xl font-semibold text-slate-900">{replayChoice.status === 'PUBLISHED' ? 'Your live replay was posted' : 'Your live replay is saved'}</h2>
        <p className="mt-2 text-sm text-slate-600">{replayChoice.status === 'PUBLISHED' ? 'This recording is available in your feed and can be played below.' : 'Preview your recording before sharing it as a video post.'}</p>
        <div className="mt-4 overflow-hidden rounded-xl bg-black">
          <PostMedia url={replayChoice.mediaUrl} alt={`${replayChoice.title} live replay`} className="max-h-64 w-full object-contain" />
        </div>
        {replayChoice.status === 'READY' ? <label className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-700">Audience
          <select value={replayVisibility} onChange={(event) => setReplayVisibility(event.target.value as typeof replayVisibility)} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5">
            <option value="PUBLIC">Everyone</option><option value="FOLLOWERS">Followers</option><option value="PRIVATE">Only me</option>
          </select>
        </label> : null}
        {replayActionError ? <p className="mt-3 rounded-lg bg-rose-50 p-3 text-sm text-rose-700" role="alert">{replayActionError}</p> : null}
        <div className="mt-5 grid grid-cols-2 gap-2">
          {replayChoice.status === 'READY' ? <>
            <Button variant="primary" onClick={() => void publishReplay(replayChoice)} disabled={replayBusy}>{replayBusy ? 'Saving…' : 'Save and post'}</Button>
            <Button variant="secondary" onClick={() => void deleteReplay(replayChoice)} disabled={replayBusy}>{replayBusy ? 'Please wait…' : 'Delete'}</Button>
          </> : <>
            {replayChoice.publishedPostId ? <Link to="/profile" className="inline-flex min-h-11 items-center justify-center rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white">View post</Link> : null}
            <Button variant="secondary" onClick={() => setReplayChoice(null)}>Close</Button>
          </>}
        </div>
      </section>
    </div> : null}
    </>
  )
}
