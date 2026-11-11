import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { Room as LiveKitRoom } from 'livekit-client'
import { Eye, Expand, Headphones, MessageCircle, Minimize, Radio, Users, X } from 'lucide-react'
import { Button } from '../components/ui/Button'
import { useAuth } from '../context/AuthContext'
import { API_BASE_URL, apiRequest } from '../lib/api'
import { openAuthenticatedEventStream } from '../lib/eventStream'
import { getStoredAccessToken } from '../lib/session'
import { appendLiveRecordingChunk, beginLiveRecording, createRecordingId, deleteLiveRecording, getPendingLiveRecordings, markLiveRecordingPending, type LiveRecording } from '../lib/liveRecording'

type LiveComment = { id: string; userId: string; text: string; createdAt: string }
type LiveSession = {
  id: string
  hostId: string
  title: string
  description?: string | null
  visibility: string
  status: string
  viewerCount: number
  provider?: 'livekit' | 'webrtc-peer'
  providerConfigured: boolean
  comments: LiveComment[]
}
type LiveSignal = { type: 'join' | 'leave' } | { type: 'offer' | 'answer'; sdp: string } | ({ type: 'candidate' } & RTCIceCandidateInit)
type LiveViewer = { userId: string; name: string; joinedAt: string }
type RecordingProgress = { recordingId: string; loaded: number; total: number; stage: 'uploading' | 'saving' }

export function LivePage() {
  const { user } = useAuth()
  const [lives, setLives] = useState<LiveSession[]>([])
  const [joinedLive, setJoinedLive] = useState<LiveSession | null>(null)
  const [comment, setComment] = useState('')
  const [newTitle, setNewTitle] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pendingRecordings, setPendingRecordings] = useState<LiveRecording[]>([])
  const [recordingProgress, setRecordingProgress] = useState<RecordingProgress | null>(null)
  const [viewerListOpen, setViewerListOpen] = useState(false)
  const [viewers, setViewers] = useState<LiveViewer[]>([])
  const [viewerListLoading, setViewerListLoading] = useState(false)
  const [commentsOpen, setCommentsOpen] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const uploadingRecordingRef = useRef<string | null>(null)
  const hostStreamRef = useRef<MediaStream | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordingIdRef = useRef<string | null>(null)
  const recordingQueueRef = useRef<Promise<void>>(Promise.resolve())
  const liveKitRoomRef = useRef<LiveKitRoom | null>(null)
  const remoteStreamRef = useRef<MediaStream | null>(null)
  const peerConnectionsRef = useRef(new Map<string, RTCPeerConnection>())
  const pendingCandidatesRef = useRef(new Map<string, RTCIceCandidateInit[]>())
  const iceServersRef = useRef<RTCIceServer[] | null>(null)
  const joinedLiveRef = useRef<LiveSession | null>(null)
  const livesRef = useRef<LiveSession[]>([])
  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null)
  const viewerStageRef = useRef<HTMLElement | null>(null)

  const setLiveState = (live: LiveSession) => {
    livesRef.current = livesRef.current.some((entry) => entry.id === live.id)
      ? livesRef.current.map((entry) => entry.id === live.id ? live : entry)
      : [live, ...livesRef.current]
    setLives(livesRef.current)
    if (joinedLiveRef.current?.id === live.id) {
      joinedLiveRef.current = live
      setJoinedLive(live)
    }
  }

  const sendSignal = async (liveId: string, to: string, signal: LiveSignal) => {
    await apiRequest(`/api/live/${encodeURIComponent(liveId)}/signaling`, {
      method: 'POST',
      body: JSON.stringify({ to, signal }),
    })
  }

  const rtcConfiguration = useCallback(async () => {
    if (!iceServersRef.current) {
      const response = await apiRequest<{ iceServers: RTCIceServer[] }>('/api/rtc/config')
      iceServersRef.current = response.iceServers
    }
    return { iceServers: iceServersRef.current }
  }, [])

  const loadPendingRecordings = async () => {
    try {
      const recordings = await getPendingLiveRecordings()
      setPendingRecordings(recordings)
      return recordings
    } catch (storageError) {
      setError(storageError instanceof Error ? storageError.message : 'Unable to recover saved live recordings.')
      return []
    }
  }

  const connectLiveKitRoom = async (live: LiveSession, host: boolean) => {
    const { createLocalTracks, Room, RoomEvent } = await import('livekit-client')
    const credentials = await apiRequest<{ serverUrl: string; token: string }>(`/api/live/${encodeURIComponent(live.id)}/livekit-token`, { method: 'POST' })
    const room = new Room({ adaptiveStream: true, dynacast: true })
    const roomRemoteStream = new MediaStream()
    liveKitRoomRef.current = room
    room.on(RoomEvent.TrackSubscribed, (track) => {
      const mediaTrack = track.mediaStreamTrack
      if (!roomRemoteStream.getTracks().some((entry) => entry.id === mediaTrack.id)) roomRemoteStream.addTrack(mediaTrack)
      remoteStreamRef.current = new MediaStream(roomRemoteStream.getTracks())
      setRemoteStream(remoteStreamRef.current)
    })
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      roomRemoteStream.removeTrack(track.mediaStreamTrack)
      remoteStreamRef.current = new MediaStream(roomRemoteStream.getTracks())
      setRemoteStream(remoteStreamRef.current)
    })
    room.on(RoomEvent.Reconnecting, () => setError('Reconnecting to LiveKit…'))
    room.on(RoomEvent.Reconnected, () => setError(''))
    room.on(RoomEvent.Disconnected, () => {
      if (liveKitRoomRef.current === room) setError('The LiveKit connection ended. Rejoin the live session to reconnect.')
    })
    await room.connect(credentials.serverUrl, credentials.token)
    if (host) {
      const tracks = await createLocalTracks({ audio: true, video: true })
      const stream = new MediaStream(tracks.map((track) => track.mediaStreamTrack))
      await Promise.all(tracks.map((track) => room.localParticipant.publishTrack(track)))
      return stream
    }
    return null
  }

  const uploadPendingRecording = async (recording: LiveRecording) => {
    if (uploadingRecordingRef.current) return
    const contentType = recording.mimeType.split(';', 1)[0]
    const extension = contentType === 'video/mp4' ? 'mp4' : 'webm'
    const blob = new Blob(recording.chunks, { type: contentType })
    if (!blob.size) {
      setError('The saved recording has no video data to upload.')
      return
    }
    uploadingRecordingRef.current = recording.recordingId
    setIsUploading(true)
    setError('')
    try {
      await new Promise<void>((resolve, reject) => {
        const body = new FormData()
        body.append('file', blob, `live-replay.${extension}`)
        const xhr = new XMLHttpRequest()
        xhr.open('POST', `${API_BASE_URL}/api/live/${encodeURIComponent(recording.liveId)}/recording/replay/${encodeURIComponent(recording.recordingId)}`)
        xhr.withCredentials = true
        const accessToken = getStoredAccessToken()
        if (accessToken) xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`)
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) setRecordingProgress({ recordingId: recording.recordingId, loaded: event.loaded, total: event.total, stage: 'uploading' })
        }
        xhr.upload.onload = () => setRecordingProgress((current) => current?.recordingId === recording.recordingId ? { ...current, stage: 'saving' } : current)
        xhr.onerror = () => reject(new Error('The replay upload was interrupted. Your local recording is still available to retry.'))
        xhr.onabort = () => reject(new Error('The replay upload was cancelled. Your local recording is still available to retry.'))
        xhr.onload = () => {
          let response: { message?: string } = {}
          try {
            response = JSON.parse(xhr.responseText) as { message?: string }
          } catch {
            reject(new Error('The server returned an invalid replay upload response.'))
            return
          }
          if (xhr.status < 200 || xhr.status >= 300) {
            reject(new Error(response.message || `The replay could not be saved (HTTP ${xhr.status}).`))
            return
          }
          resolve()
        }
        xhr.send(body)
      })
      await deleteLiveRecording(recording.recordingId)
      setPendingRecordings((current) => current.filter((entry) => entry.recordingId !== recording.recordingId))
      setRecordingProgress(null)
      await loadLives()
    } catch (uploadError) {
      setRecordingProgress(null)
      setError(uploadError instanceof Error ? uploadError.message : 'Unable to publish the replay. Your local recording is preserved.')
    } finally {
      uploadingRecordingRef.current = null
      setIsUploading(false)
    }
  }

  const retryPendingRecordings = async () => {
    try {
      const recordings = await getPendingLiveRecordings()
      setPendingRecordings(recordings)
      for (const recording of recordings) {
        if (recording.recordingId !== recordingIdRef.current) await uploadPendingRecording(recording)
      }
    } catch (storageError) {
      setError(storageError instanceof Error ? storageError.message : 'Unable to recover saved live recordings.')
    }
  }

  const applyQueuedCandidates = async (peer: RTCPeerConnection, peerId: string) => {
    const queued = pendingCandidatesRef.current.get(peerId) ?? []
    pendingCandidatesRef.current.delete(peerId)
    for (const candidate of queued) await peer.addIceCandidate(candidate)
  }

  const createLivePeer = useCallback(async (liveId: string, peerId: string, host: boolean) => {
    const existing = peerConnectionsRef.current.get(peerId)
    if (existing) return existing
    const peer = new RTCPeerConnection(await rtcConfiguration())
    peerConnectionsRef.current.set(peerId, peer)
    if (host) hostStreamRef.current?.getTracks().forEach((track) => peer.addTrack(track, hostStreamRef.current!))
    peer.onicecandidate = (event) => {
      if (!event.candidate) return
      void sendSignal(liveId, peerId, { type: 'candidate', ...event.candidate.toJSON() }).catch((signalError) => {
        setError(signalError instanceof Error ? signalError.message : 'Unable to send the live media candidate.')
      })
    }
    peer.ontrack = (event) => {
      const stream = event.streams[0]
      if (stream && !host) setRemoteStream(stream)
    }
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'failed') setError('The live media connection failed. Check network access or configure TURN relay in the server environment.')
    }
    return peer
  }, [rtcConfiguration])

  const handleLiveSignal = useCallback(async (event: MessageEvent<string>) => {
    try {
      const payload = JSON.parse(event.data) as { liveId: string; from: string; to: string; signal: LiveSignal }
      if (payload.to !== user?.id) return
      const live = livesRef.current.find((entry) => entry.id === payload.liveId)
      if (!live) return
      const isHost = live.hostId === user?.id
      if (payload.signal.type === 'join' && isHost) {
        if (!hostStreamRef.current) throw new Error('Start broadcasting before accepting viewers.')
        const peer = await createLivePeer(live.id, payload.from, true)
        const offer = await peer.createOffer()
        await peer.setLocalDescription(offer)
        await sendSignal(live.id, payload.from, { type: 'offer', sdp: offer.sdp ?? '' })
      } else if (payload.signal.type === 'leave' && isHost) {
        peerConnectionsRef.current.get(payload.from)?.close()
        peerConnectionsRef.current.delete(payload.from)
      } else if (payload.signal.type === 'offer' && !isHost) {
        const peer = await createLivePeer(live.id, payload.from, false)
        await peer.setRemoteDescription({ type: 'offer', sdp: payload.signal.sdp })
        await applyQueuedCandidates(peer, payload.from)
        const answer = await peer.createAnswer()
        await peer.setLocalDescription(answer)
        await sendSignal(live.id, payload.from, { type: 'answer', sdp: answer.sdp ?? '' })
      } else if (payload.signal.type === 'answer' && isHost) {
        const peer = peerConnectionsRef.current.get(payload.from)
        if (peer) {
          await peer.setRemoteDescription({ type: 'answer', sdp: payload.signal.sdp })
          await applyQueuedCandidates(peer, payload.from)
        }
      } else if (payload.signal.type === 'candidate') {
        const peer = peerConnectionsRef.current.get(payload.from)
        if (payload.signal.type !== 'candidate') return
     const candidate: RTCIceCandidateInit = {
       candidate: payload.signal.candidate,
       sdpMid: payload.signal.sdpMid,
       sdpMLineIndex: payload.signal.sdpMLineIndex,
       usernameFragment: payload.signal.usernameFragment,
     }
     if (peer?.remoteDescription) await peer.addIceCandidate(candidate)
        else pendingCandidatesRef.current.set(payload.from, [...(pendingCandidatesRef.current.get(payload.from) ?? []), candidate])
      }
    } catch (signalError) {
      setError(signalError instanceof Error ? signalError.message : 'Unable to process the live media signal.')
    }
  }, [createLivePeer, user?.id])

  const loadLives = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await apiRequest<{ lives: LiveSession[] }>('/api/live')
      livesRef.current = response.lives
      setLives(response.lives)
      if (joinedLiveRef.current) {
        const refreshed = response.lives.find((live) => live.id === joinedLiveRef.current?.id) ?? null
        joinedLiveRef.current = refreshed
        setJoinedLive(refreshed)
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load live sessions.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadLives()
    void loadPendingRecordings()
    const retryPending = () => { void retryPendingRecordings() }
    const onFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement))
    window.addEventListener('online', retryPending)
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => {
      window.removeEventListener('online', retryPending)
      document.removeEventListener('fullscreenchange', onFullscreenChange)
    }
  }, [])

  useEffect(() => {
    const source = openAuthenticatedEventStream('/api/realtime')
    const onLiveUpdate = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as { live?: LiveSession }
        if (!payload.live) return
        setLiveState(payload.live)
        if (payload.live.status === 'ended') {
          if (payload.live.hostId === user?.id) {
            hostStreamRef.current?.getTracks().forEach((track) => track.stop())
            hostStreamRef.current = null
            setLocalStream(null)
          }
          peerConnectionsRef.current.forEach((peer) => peer.close())
          peerConnectionsRef.current.clear()
          void liveKitRoomRef.current?.disconnect()
          liveKitRoomRef.current = null
          setRemoteStream(null)
        }
      } catch {
        setError('A live session update could not be read. Refresh to retry.')
      }
    }
    source.addEventListener('live:update', onLiveUpdate)
    source.addEventListener('live:signal', (event: MessageEvent<string>) => { void handleLiveSignal(event) })
    return () => source.close()
  }, [handleLiveSignal, user?.id])

  useEffect(() => {
    if (localVideoRef.current) localVideoRef.current.srcObject = localStream
  }, [localStream])

  useEffect(() => {
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteStream
  }, [remoteStream])

  useEffect(() => {
    if (!joinedLive) return
    const heartbeat = () => {
      void apiRequest<{ live: LiveSession }>(`/api/live/${encodeURIComponent(joinedLive.id)}/viewers/heartbeat`, { method: 'POST' })
        .then((response) => setLiveState(response.live))
        .catch(() => undefined)
    }
    const interval = window.setInterval(heartbeat, 20_000)
    return () => window.clearInterval(interval)
  }, [joinedLive?.id])

  useEffect(() => {
    if (!viewerListOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setViewerListOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [viewerListOpen])

  useEffect(() => {
    const stopCapture = () => {
      const recorder = mediaRecorderRef.current
      if (recorder?.state === 'recording') {
        recorder.addEventListener('stop', () => {
          const recordingId = recordingIdRef.current
          if (recordingId) void recordingQueueRef.current.then(() => markLiveRecordingPending(recordingId)).catch(() => undefined)
        }, { once: true })
        recorder.stop()
      } else {
        const recordingId = recordingIdRef.current
        if (recordingId) void recordingQueueRef.current.then(() => markLiveRecordingPending(recordingId)).catch(() => undefined)
      }
      const joined = joinedLiveRef.current
      if (joined) void apiRequest(`/api/live/${encodeURIComponent(joined.id)}/viewers/leave`, { method: 'POST' }).catch(() => undefined)
    }
    window.addEventListener('pagehide', stopCapture)
    return () => {
      window.removeEventListener('pagehide', stopCapture)
      stopCapture()
      peerConnectionsRef.current.forEach((peer) => peer.close())
      peerConnectionsRef.current.clear()
      void liveKitRoomRef.current?.disconnect()
      liveKitRoomRef.current = null
      hostStreamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  const createLive = async (event: FormEvent) => {
    event.preventDefault()
    if (!newTitle.trim()) return
    setBusy(true)
    setError('')
    try {
      const response = await apiRequest<{ live: LiveSession }>('/api/live/create', {
        method: 'POST',
        body: JSON.stringify({ title: newTitle.trim(), description: newDescription.trim() }),
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

  const startBroadcast = async (live: LiveSession) => {
    if (live.provider !== 'livekit' && !navigator.mediaDevices?.getUserMedia) {
      setError('This browser does not support live video capture.')
      return
    }
    if (typeof MediaRecorder === 'undefined') {
      setError('This browser cannot record a recoverable live replay.')
      return
    }
    setBusy(true)
    setError('')
    let stream: MediaStream | null = null
    try {
      if (live.provider !== 'livekit') {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: { ideal: 1280 }, height: { ideal: 720 } } })
      }
      const response = await apiRequest<{ live: LiveSession }>(`/api/live/${encodeURIComponent(live.id)}/start`, { method: 'POST' })
      setLiveState(response.live)
      if (live.provider === 'livekit') stream = await connectLiveKitRoom(response.live, true)
      if (!stream) throw new Error('The camera and microphone stream could not be started.')
      const supportedMimeType = ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find((type) => MediaRecorder.isTypeSupported(type))
      const recorder = new MediaRecorder(stream, supportedMimeType ? { mimeType: supportedMimeType } : undefined)
      const recordingId = createRecordingId()
      const contentType = recorder.mimeType.split(';', 1)[0]
      if (!['video/webm', 'video/mp4'].includes(contentType)) throw new Error('This browser cannot create a supported video replay format.')
      await beginLiveRecording({ recordingId, liveId: live.id, title: live.title, mimeType: contentType })
      recordingIdRef.current = recordingId
      recordingQueueRef.current = Promise.resolve()
      recorder.ondataavailable = (event) => {
        if (!event.data.size) return
        recordingQueueRef.current = recordingQueueRef.current
          .catch(() => undefined)
          .then(() => appendLiveRecordingChunk(recordingId, event.data))
          .catch((storageError) => {
            setError(storageError instanceof Error ? storageError.message : 'A recording chunk could not be saved locally.')
            if (recorder.state === 'recording') recorder.stop()
          })
      }
      recorder.start(2000)
      mediaRecorderRef.current = recorder
      hostStreamRef.current = stream
      setLocalStream(stream)
    } catch (startError) {
      if (mediaRecorderRef.current?.state === 'recording') mediaRecorderRef.current.stop()
      await recordingQueueRef.current.catch(() => undefined)
      if (recordingIdRef.current) await markLiveRecordingPending(recordingIdRef.current).catch(() => undefined)
      mediaRecorderRef.current = null
      recordingIdRef.current = null
      void liveKitRoomRef.current?.disconnect()
      liveKitRoomRef.current = null
      stream?.getTracks().forEach((track) => track.stop())
      hostStreamRef.current = null
      setLocalStream(null)
      setError(startError instanceof Error ? startError.message : 'Unable to start the live broadcast.')
      await loadPendingRecordings()
    } finally {
      setBusy(false)
    }
  }

  const stopLocalRecording = async () => {
    const recorder = mediaRecorderRef.current
    if (recorder?.state === 'recording') {
      await new Promise<void>((resolve) => {
        recorder.addEventListener('stop', () => resolve(), { once: true })
        recorder.stop()
      })
    }
    const recordingId = recordingIdRef.current
    await recordingQueueRef.current.catch(() => undefined)
    if (recordingId) await markLiveRecordingPending(recordingId)
    mediaRecorderRef.current = null
    recordingIdRef.current = null
    await loadPendingRecordings()
  }

  const endBroadcast = async (live: LiveSession) => {
    setBusy(true)
    setError('')
    try {
      await stopLocalRecording()
      void liveKitRoomRef.current?.disconnect()
      liveKitRoomRef.current = null
      peerConnectionsRef.current.forEach((peer) => peer.close())
      peerConnectionsRef.current.clear()
      const response = await apiRequest<{ live: LiveSession }>(`/api/live/${encodeURIComponent(live.id)}/end`, { method: 'POST' })
      setLiveState(response.live)
      hostStreamRef.current?.getTracks().forEach((track) => track.stop())
      hostStreamRef.current = null
      setLocalStream(null)
      const saved = await getPendingLiveRecordings()
      setPendingRecordings(saved)
      const justEnded = saved.find((recording) => recording.liveId === live.id)
      if (justEnded) await uploadPendingRecording(justEnded)
    } catch (endError) {
      setError(endError instanceof Error ? endError.message : 'Unable to end this live session.')
    } finally {
      setBusy(false)
    }
  }

  const joinLive = async (live: LiveSession) => {
    setBusy(true)
    setError('')
    try {
      const response = await apiRequest<{ live: LiveSession }>(`/api/live/${encodeURIComponent(live.id)}/viewers/join`, { method: 'POST' })
      joinedLiveRef.current = response.live
      setJoinedLive(response.live)
      setLiveState(response.live)
      if (live.provider === 'livekit') await connectLiveKitRoom(response.live, false)
      else await sendSignal(live.id, live.hostId, { type: 'join' })
    } catch (joinError) {
      setError(joinError instanceof Error ? joinError.message : 'Unable to join this live session.')
    } finally {
      setBusy(false)
    }
  }

  const leaveLive = async () => {
    const currentLive = joinedLiveRef.current
    if (!currentLive) return
    setBusy(true)
    try {
      if (currentLive.provider === 'livekit') {
        await liveKitRoomRef.current?.disconnect()
        liveKitRoomRef.current = null
      } else {
        await sendSignal(currentLive.id, currentLive.hostId, { type: 'leave' })
      }
      await apiRequest(`/api/live/${encodeURIComponent(currentLive.id)}/viewers/leave`, { method: 'POST' })
      peerConnectionsRef.current.forEach((peer) => peer.close())
      peerConnectionsRef.current.clear()
      setRemoteStream(null)
      remoteStreamRef.current = null
      joinedLiveRef.current = null
      setJoinedLive(null)
      setCommentsOpen(false)
      setViewerListOpen(false)
      await loadLives()
    } catch (leaveError) {
      setError(leaveError instanceof Error ? leaveError.message : 'Unable to leave this session.')
    } finally {
      setBusy(false)
    }
  }

  const postComment = async (event: FormEvent) => {
    event.preventDefault()
    if (!joinedLive || !comment.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      const response = await apiRequest<{ comment: LiveComment }>(`/api/live/${encodeURIComponent(joinedLive.id)}/comment`, { method: 'POST', body: JSON.stringify({ text: comment.trim() }) })
      setJoinedLive((current) => current ? { ...current, comments: [...current.comments, response.comment] } : current)
      setComment('')
    } catch (commentError) {
      setError(commentError instanceof Error ? commentError.message : 'Unable to post your comment.')
    } finally {
      setBusy(false)
    }
  }

  const react = async (live: LiveSession) => {
    try {
      await apiRequest(`/api/live/${encodeURIComponent(live.id)}/react`, { method: 'POST', body: JSON.stringify({ type: 'LIKE' }) })
    } catch (reactionError) {
      setError(reactionError instanceof Error ? reactionError.message : 'Unable to react to this session.')
    }
  }

  const loadViewers = async (live: LiveSession) => {
    setViewerListLoading(true)
    try {
      const response = await apiRequest<{ viewers: LiveViewer[]; viewerCount: number }>(`/api/live/${encodeURIComponent(live.id)}/viewers`)
      setViewers(response.viewers)
      setLiveState({ ...live, viewerCount: response.viewerCount })
    } catch (viewerError) {
      setError(viewerError instanceof Error ? viewerError.message : 'Unable to load the live audience.')
    } finally {
      setViewerListLoading(false)
    }
  }

  const toggleViewerList = async (live: LiveSession) => {
    const nextOpen = !viewerListOpen
    setViewerListOpen(nextOpen)
    if (nextOpen) await loadViewers(live)
  }

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await viewerStageRef.current?.requestFullscreen()
    } catch {
      setError('Fullscreen is not available in this browser.')
    }
  }

  const hostLive = lives.find((live) => live.hostId === user?.id && live.status === 'live')

  return (
    <div className="min-w-0 space-y-5 overflow-x-hidden p-3 pb-28 sm:p-6">
      <header>
        <p className="inline-flex items-center gap-2 text-xs font-semibold uppercase text-indigo-700"><Radio className="h-4 w-4" aria-hidden="true" /> Live</p>
        <h2 className="mt-2 text-2xl font-semibold text-slate-900">Live sessions</h2>
      </header>

      <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900" role="status">Replays are recorded in your browser and retained locally until the server confirms the Feed post. LiveKit Egress recording is not configured.</div>
      {error ? <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700" role="alert">{error}</p> : null}

      {pendingRecordings.length ? <section aria-label="Saved live recordings" className="space-y-2 border-y border-amber-200 py-3">
        <h3 className="text-sm font-semibold text-slate-900">Saved replays awaiting upload</h3>
        {pendingRecordings.map((recording) => {
          const progress = recordingProgress?.recordingId === recording.recordingId ? recordingProgress : null
          return <div key={recording.recordingId} className="flex min-w-0 flex-wrap items-center gap-3">
            <p className="min-w-0 flex-1 truncate text-sm text-slate-700">{recording.title} · {recording.chunks.length} saved chunks</p>
            {progress ? <span className="text-xs text-slate-600" role="status">{progress.stage === 'saving' ? 'Saving replay…' : `${Math.floor((progress.loaded / Math.max(progress.total, 1)) * 100)}% uploaded`}</span> : null}
            <Button type="button" variant="secondary" size="sm" disabled={isUploading} onClick={() => void uploadPendingRecording(recording)}>{isUploading && progress ? 'Uploading…' : 'Retry upload'}</Button>
          </div>
        })}
      </section> : null}

      <form onSubmit={(event) => void createLive(event)} className="min-w-0 space-y-3 rounded-xl border border-slate-200 bg-white p-4">
        <h3 className="font-semibold text-slate-900">Create a live session</h3>
        <input aria-label="Live session title" required maxLength={120} value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="What are you going live about?" className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
        <textarea aria-label="Live session description" maxLength={1000} value={newDescription} onChange={(event) => setNewDescription(event.target.value)} placeholder="Add a description (optional)" className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
        <div className="flex justify-end"><Button type="submit" variant="primary" size="sm" disabled={busy || !newTitle.trim()}>Create session</Button></div>
      </form>

      {hostLive ? <section className="min-w-0 rounded-xl border border-indigo-200 bg-white p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><h3 className="font-semibold text-slate-900">Your live broadcast</h3><p className="truncate text-sm text-slate-600">{hostLive.title}</p></div>{localStream ? <Button variant="secondary" size="sm" onClick={() => void endBroadcast(hostLive)} disabled={busy}>End broadcast</Button> : <Button variant="primary" size="sm" onClick={() => void startBroadcast(hostLive)} disabled={busy}>Resume camera</Button>}</div>
        {localStream ? <video ref={localVideoRef} autoPlay muted playsInline className="mt-3 max-h-[70dvh] w-full rounded-lg bg-slate-950 object-contain" style={{ aspectRatio: '4 / 3' }} /> : null}
        <div className="mt-3 flex items-center justify-between gap-3 text-xs text-slate-600">
          <span>{hostLive.provider === 'livekit' ? 'LiveKit room' : 'Browser peer connection'} · Browser recording active</span>
          <button type="button" onClick={() => void toggleViewerList(hostLive)} className="inline-flex min-h-10 items-center gap-2 rounded-full bg-slate-100 px-3 font-medium text-slate-800" aria-label={`${hostLive.viewerCount} live viewers`}><Eye className="h-4 w-4" aria-hidden="true" />{hostLive.viewerCount}</button>
        </div>
      </section> : null}

      {joinedLive ? (
        <section ref={viewerStageRef} className="fixed inset-0 z-[60] overflow-hidden bg-black text-white" aria-label={`${joinedLive.title} live video`}>
          <video ref={remoteVideoRef} autoPlay playsInline controls className="absolute inset-0 h-full w-full bg-black object-cover sm:object-contain" />
          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 px-3 pt-[max(env(safe-area-inset-top),0.75rem)] sm:px-5">
            <div className="pointer-events-auto min-w-0 max-w-[70vw] rounded-xl bg-black/55 px-3 py-2 backdrop-blur-sm">
              <p className="truncate text-sm font-semibold">{joinedLive.title}</p>
              <p className="text-xs text-white/75">{remoteStream ? (joinedLive.provider === 'livekit' ? 'LiveKit connected' : 'Live connection active') : 'Connecting to live video…'}</p>
            </div>
            <div className="pointer-events-auto flex shrink-0 items-center gap-2">
              <button type="button" onClick={() => void toggleViewerList(joinedLive)} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-black/55 px-3 text-sm font-semibold backdrop-blur-sm" aria-label={`Show ${joinedLive.viewerCount} viewers`}><Eye className="h-4 w-4" aria-hidden="true" />{joinedLive.viewerCount}</button>
              <button type="button" onClick={() => void toggleFullscreen()} className="flex h-11 w-11 items-center justify-center rounded-full bg-black/55" aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} title={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}>{isFullscreen ? <Minimize className="h-5 w-5" aria-hidden="true" /> : <Expand className="h-5 w-5" aria-hidden="true" />}</button>
              <button type="button" onClick={() => void leaveLive()} disabled={busy} className="flex h-11 w-11 items-center justify-center rounded-full bg-black/55 disabled:opacity-50" aria-label="Leave live session" title="Leave live session"><X className="h-5 w-5" aria-hidden="true" /></button>
            </div>
          </div>
          {error ? <p role="alert" className="absolute left-3 right-3 top-20 mx-auto max-w-lg rounded-xl bg-rose-950/85 p-3 text-center text-sm text-white">{error}</p> : null}
          <div className="absolute inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+3.5rem)] flex justify-end px-3 sm:px-5">
            <button type="button" onClick={() => setCommentsOpen((open) => !open)} className="flex h-12 w-12 items-center justify-center rounded-full bg-black/55" aria-label={commentsOpen ? 'Close live comments' : 'Open live comments'} title={commentsOpen ? 'Close live comments' : 'Open live comments'}><MessageCircle className="h-5 w-5" aria-hidden="true" /></button>
          </div>
          {commentsOpen ? <>
            <button type="button" aria-label="Close live comments" onClick={() => setCommentsOpen(false)} className="absolute inset-0 bg-black/15" />
            <section aria-label="Live comments" className="absolute inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] z-10 mx-auto flex max-h-[50dvh] max-w-lg flex-col rounded-xl bg-white text-slate-900 shadow-xl" onClick={(event) => event.stopPropagation()}>
              <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2"><h3 className="text-sm font-semibold">Comments</h3><button type="button" onClick={() => setCommentsOpen(false)} aria-label="Close comments" className="flex h-10 w-10 items-center justify-center rounded-full text-slate-600 hover:bg-slate-100"><X className="h-4 w-4" aria-hidden="true" /></button></div>
              <ul className="min-h-12 flex-1 space-y-2 overflow-y-auto p-3">{joinedLive.comments.map((entry) => <li key={entry.id} className="rounded-lg bg-slate-50 p-2 text-sm text-slate-700">{entry.text}</li>)}</ul>
              <form onSubmit={(event) => void postComment(event)} className="flex gap-2 border-t border-slate-200 p-3"><input value={comment} onChange={(event) => setComment(event.target.value)} maxLength={500} aria-label="Live comment" placeholder="Write a comment" className="min-w-0 min-h-11 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm" /><Button type="submit" variant="primary" size="sm" disabled={busy || !comment.trim()}>Send</Button></form>
            </section>
          </> : null}
          {viewerListOpen ? <div className="absolute inset-0 z-20" role="dialog" aria-modal="true" aria-label="Live viewers">
            <button type="button" aria-label="Close viewer list" onClick={() => setViewerListOpen(false)} className="absolute inset-0 bg-black/15" />
            <section className="absolute right-3 top-[calc(env(safe-area-inset-top)+4.5rem)] max-h-[min(60dvh,28rem)] w-[calc(100%-1.5rem)] max-w-sm overflow-hidden rounded-xl bg-white text-slate-900 shadow-2xl sm:right-5" onClick={(event) => event.stopPropagation()}>
              <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5"><h3 className="text-sm font-semibold">{joinedLive.viewerCount} viewers</h3><button type="button" onClick={() => setViewerListOpen(false)} aria-label="Close viewer list" className="flex h-10 w-10 items-center justify-center rounded-full text-slate-600 hover:bg-slate-100"><X className="h-4 w-4" aria-hidden="true" /></button></div>
              {viewerListLoading ? <p className="p-4 text-sm text-slate-500">Loading viewers…</p> : <ul className="max-h-[calc(min(60dvh,28rem)-3.5rem)] divide-y divide-slate-100 overflow-y-auto">{viewers.map((viewer) => <li key={viewer.userId} className="px-4 py-3 text-sm text-slate-800">{viewer.name}</li>)}</ul>}
            </section>
          </div> : null}
        </section>
      ) : null}

      {loading ? <p className="rounded-xl bg-white p-4 text-sm text-slate-500">Loading sessions…</p> : null}
      {!loading && lives.length === 0 && !error ? <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">No live sessions are available.</p> : null}
      <ul className="min-w-0 divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white">
        {lives.map((live) => (
          <li key={live.id} className="flex flex-wrap items-center gap-3 p-4">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-700"><Headphones className="h-5 w-5" aria-hidden="true" /></span>
            <div className="min-w-0 flex-1"><h3 className="truncate font-semibold text-slate-900">{live.title}</h3><p className="mt-1 text-sm text-slate-500">{live.description || `Hosted by ${live.hostId === user?.id ? 'you' : 'a NOVAKOKO member'}`} · {live.viewerCount} viewers · {live.status}</p></div>
            {live.hostId === user?.id && live.status === 'paused' ? <Button variant="primary" size="sm" onClick={() => void startBroadcast(live)} disabled={busy}>Start broadcasting</Button> : null}
            {live.hostId !== user?.id && live.status === 'live' && joinedLive?.id !== live.id ? <><Button variant="secondary" size="sm" onClick={() => void react(live)}>React</Button><Button variant="primary" size="sm" onClick={() => void joinLive(live)} disabled={busy}>Join live</Button></> : null}
          </li>
        ))}
      </ul>

      <div className="flex justify-end"><Button variant="secondary" size="sm" onClick={() => void loadLives()} disabled={loading}><Users className="h-4 w-4" aria-hidden="true" /> Refresh</Button></div>
    </div>
  )
}