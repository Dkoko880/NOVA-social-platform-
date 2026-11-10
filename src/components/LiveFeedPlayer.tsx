import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Heart, Maximize2, Minimize2, PhoneOff, Send, Volume2 } from 'lucide-react'
import type { RemoteTrack, Room } from 'livekit-client'
import { apiRequest } from '../lib/api'
import { openAuthenticatedEventStream } from '../lib/eventStream'

type LiveFeedPlayerProps = {
  liveId: string
  title: string
  viewerCount: number
  onViewerCountChange: (count: number) => void
}

type LiveComment = { id: string; userId: string; text: string; createdAt: string }

function AttachedTrack({ track }: { track: RemoteTrack }) {
  const elementRef = useRef<HTMLMediaElement | null>(null)

  useEffect(() => {
    const element = elementRef.current
    if (!element) return
    track.attach(element)
    return () => { track.detach() }
  }, [track])

  if (track.kind === 'video') {
    return <video ref={(element) => { elementRef.current = element }} autoPlay playsInline className="h-full w-full object-contain" />
  }
  return <audio ref={(element) => { elementRef.current = element }} autoPlay />
}

export function LiveFeedPlayer({ liveId, title, viewerCount, onViewerCountChange }: LiveFeedPlayerProps) {
  const [watching, setWatching] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [needsAudioPlayback, setNeedsAudioPlayback] = useState(false)
  const [needsVideoPlayback, setNeedsVideoPlayback] = useState(false)
  const [tracks, setTracks] = useState<Array<{ key: string; track: RemoteTrack }>>([])
  const [fullscreen, setFullscreen] = useState(false)
  const [comments, setComments] = useState<LiveComment[]>([])
  const [comment, setComment] = useState('')
  const [commentBusy, setCommentBusy] = useState(false)
  const roomRef = useRef<Room | null>(null)
  const joinedRef = useRef(false)
  const playerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => onViewerCountChange(viewerCount), [onViewerCountChange, viewerCount])

  const leave = useCallback(async () => {
    const room = roomRef.current
    roomRef.current = null
    setWatching(false)
    setTracks([])
    setComments([])
    setNeedsAudioPlayback(false)
    setNeedsVideoPlayback(false)
    let cleanupError: unknown
    try {
      if (room) await room.disconnect(true)
    } catch (disconnectError) {
      cleanupError = disconnectError
    }
    if (joinedRef.current) {
      joinedRef.current = false
      try {
        await apiRequest(`/api/live/${encodeURIComponent(liveId)}/viewers/leave`, { method: 'POST' })
      } catch (leaveError) {
        cleanupError = cleanupError
          ? new Error(`${cleanupError instanceof Error ? cleanupError.message : 'Media disconnect failed.'} ${leaveError instanceof Error ? leaveError.message : 'Viewer status cleanup failed.'}`)
          : leaveError
      }
    }
    if (cleanupError) throw cleanupError
  }, [liveId])

  useEffect(() => () => {
    const room = roomRef.current
    roomRef.current = null
    if (room) {
      void room.disconnect(true).catch((cleanupError: unknown) => console.error('Unable to disconnect from the feed live broadcast.', cleanupError))
    }
    if (joinedRef.current) {
      joinedRef.current = false
      void apiRequest(`/api/live/${encodeURIComponent(liveId)}/viewers/leave`, { method: 'POST' })
        .catch((cleanupError: unknown) => console.error('Unable to leave the feed live broadcast.', cleanupError))
    }
  }, [liveId])

  useEffect(() => {
    if (!watching) return
    const timer = window.setInterval(() => {
      void apiRequest<{ live: { viewerCount: number } }>(`/api/live/${encodeURIComponent(liveId)}/viewers/heartbeat`, { method: 'POST' })
        .then(({ live }) => onViewerCountChange(live.viewerCount))
        .catch((heartbeatError: unknown) => setError(heartbeatError instanceof Error ? heartbeatError.message : 'Live audience status could not be refreshed.'))
    }, 15_000)
    return () => window.clearInterval(timer)
  }, [liveId, onViewerCountChange, watching])

  useEffect(() => {
    if (!watching) return
    const source = openAuthenticatedEventStream('/api/realtime')
    const onLiveUpdate = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as { live?: { id?: string; viewerCount?: number; status?: string; comments?: LiveComment[] } }
        if (payload.live?.id !== liveId) return
        if (typeof payload.live.viewerCount === 'number') onViewerCountChange(payload.live.viewerCount)
        if (payload.live.comments) setComments(payload.live.comments.slice(-50))
        if (payload.live.status === 'ended') {
          setError('This live broadcast has ended.')
          void leave().catch((leaveError: unknown) => setError(leaveError instanceof Error ? leaveError.message : 'Unable to leave this live broadcast.'))
        }
      } catch {
        setError('A live audience update could not be read.')
      }
    }
    source.addEventListener('live:update', onLiveUpdate)
    return () => source.close()
  }, [leave, liveId, onViewerCountChange, watching])

  useEffect(() => {
    const updateFullscreen = () => setFullscreen(document.fullscreenElement === playerRef.current)
    document.addEventListener('fullscreenchange', updateFullscreen)
    return () => document.removeEventListener('fullscreenchange', updateFullscreen)
  }, [])

  const join = async () => {
    if (busy || watching) return
    setBusy(true)
    setError('')
    let room: Room | null = null
    try {
      const { live } = await apiRequest<{ live: { viewerCount: number } }>(`/api/live/${encodeURIComponent(liveId)}/viewers/join`, { method: 'POST' })
      joinedRef.current = true
      onViewerCountChange(live.viewerCount)
      const { token, url } = await apiRequest<{ token: string; url: string }>(`/api/live/${encodeURIComponent(liveId)}/token`, { method: 'POST' })
      const { Room, RoomEvent } = await import('livekit-client')
      room = new Room({ adaptiveStream: true, dynacast: true })
      roomRef.current = room
      room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
        const key = `${participant.identity}:${track.sid ?? track.mediaStreamTrack.id}`
        setTracks((current) => current.some((entry) => entry.key === key) ? current : [...current, { key, track }])
      })
      room.on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
        const key = `${participant.identity}:${track.sid ?? track.mediaStreamTrack.id}`
        track.detach()
        setTracks((current) => current.filter((entry) => entry.key !== key))
      })
      room.on(RoomEvent.AudioPlaybackStatusChanged, (playing) => setNeedsAudioPlayback(!playing))
      room.on(RoomEvent.VideoPlaybackStatusChanged, (playing) => setNeedsVideoPlayback(!playing))
      room.on(RoomEvent.Reconnecting, () => setError('LiveKit connection interrupted; attempting to reconnect…'))
      room.on(RoomEvent.Reconnected, () => setError(''))
      room.on(RoomEvent.Disconnected, () => {
        if (roomRef.current !== room) return
        roomRef.current = null
        joinedRef.current = false
        setWatching(false)
        setTracks([])
        setNeedsAudioPlayback(false)
        setNeedsVideoPlayback(false)
        setError('The live broadcast disconnected.')
        void apiRequest(`/api/live/${encodeURIComponent(liveId)}/viewers/leave`, { method: 'POST' })
          .catch((leaveError: unknown) => setError(leaveError instanceof Error ? leaveError.message : 'Unable to update live viewer status.'))
      })
      await room.connect(url, token)
      const { live: connectedLive } = await apiRequest<{ live: { viewerCount: number } }>(`/api/live/${encodeURIComponent(liveId)}/viewers/heartbeat`, { method: 'POST' })
      onViewerCountChange(connectedLive.viewerCount)
      try {
        const { live: currentLive } = await apiRequest<{ live: { comments?: LiveComment[] } }>(`/api/live/${encodeURIComponent(liveId)}`)
        setComments(currentLive.comments ?? [])
      } catch (commentsError) {
        setError(commentsError instanceof Error ? `Live video is connected, but comments could not be loaded: ${commentsError.message}` : 'Live video is connected, but comments could not be loaded.')
      }
      setWatching(true)
    } catch (joinError) {
      roomRef.current = null
      let cleanupError: unknown
      if (room) {
        try {
          await room.disconnect(true)
        } catch (disconnectError) {
          cleanupError = disconnectError
        }
      }
      if (joinedRef.current) {
        joinedRef.current = false
        try {
          await apiRequest(`/api/live/${encodeURIComponent(liveId)}/viewers/leave`, { method: 'POST' })
        } catch (leaveError) {
          cleanupError = cleanupError
            ? new Error(`${cleanupError instanceof Error ? cleanupError.message : 'Media disconnect failed.'} ${leaveError instanceof Error ? leaveError.message : 'Viewer status cleanup failed.'}`)
            : leaveError
        }
      }
      setError([
        joinError instanceof Error ? joinError.message : 'Unable to join this live broadcast.',
        cleanupError instanceof Error ? `Cleanup also failed: ${cleanupError.message}` : '',
      ].filter(Boolean).join(' '))
    } finally {
      setBusy(false)
    }
  }

  const enablePlayback = async () => {
    try {
      await roomRef.current?.startAudio()
      setNeedsAudioPlayback(false)
      await roomRef.current?.startVideo()
      setNeedsVideoPlayback(false)
    } catch (playbackError) {
      setError(playbackError instanceof Error ? playbackError.message : 'Unable to start live media playback.')
    }
  }

  const postComment = async (event: FormEvent) => {
    event.preventDefault()
    if (!comment.trim() || commentBusy) return
    setCommentBusy(true)
    setError('')
    try {
      const { comment: postedComment } = await apiRequest<{ comment: LiveComment }>(`/api/live/${encodeURIComponent(liveId)}/comment`, {
        method: 'POST',
        body: JSON.stringify({ text: comment.trim() }),
      })
      setComments((current) => current.some((entry) => entry.id === postedComment.id)
        ? current
        : [...current, postedComment].slice(-50))
      setComment('')
    } catch (commentError) {
      setError(commentError instanceof Error ? commentError.message : 'Unable to post your live comment.')
    } finally {
      setCommentBusy(false)
    }
  }

  const react = async () => {
    setError('')
    try {
      await apiRequest(`/api/live/${encodeURIComponent(liveId)}/react`, {
        method: 'POST',
        body: JSON.stringify({ type: 'LIKE' }),
      })
    } catch (reactionError) {
      setError(reactionError instanceof Error ? reactionError.message : 'Unable to react to this live broadcast.')
    }
  }

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement === playerRef.current) await document.exitFullscreen()
      else await playerRef.current?.requestFullscreen()
    } catch (fullscreenError) {
      setError(fullscreenError instanceof Error ? fullscreenError.message : 'Unable to enter full-screen playback.')
    }
  }

  const videoTracks = tracks.filter(({ track }) => track.kind === 'video')
  const audioTracks = tracks.filter(({ track }) => track.kind === 'audio')

  return (
    <div className="mt-3">
      {watching ? <div ref={playerRef} className="overflow-hidden rounded-lg bg-slate-950" aria-label="Live broadcast player">
        <div className="relative aspect-video">
          {videoTracks.map(({ key, track }) => <AttachedTrack key={key} track={track} />)}
          {videoTracks.length === 0 ? <p className="absolute inset-0 flex items-center justify-center text-sm text-white/80" role="status">Connecting to live video…</p> : null}
        </div>
        <ul className="max-h-24 space-y-1 overflow-y-auto px-3 text-xs text-white" aria-label="Live comments">
          {comments.slice(-5).map((entry) => <li key={entry.id} className="truncate">{entry.text}</li>)}
        </ul>
        {audioTracks.map(({ key, track }) => <AttachedTrack key={key} track={track} />)}
        <div className="flex flex-wrap items-center justify-between gap-2 p-2">
          <span className="w-full truncate text-xs font-medium text-white sm:w-auto sm:flex-1">{title}</span>
          <div className="flex w-full flex-wrap justify-end gap-2 sm:w-auto">
            <button type="button" onClick={() => void toggleFullscreen()} aria-label={fullscreen ? 'Exit full-screen playback' : 'Full-screen playback'} className="flex min-h-10 items-center gap-2 rounded-lg bg-slate-800 px-3 text-xs font-semibold text-white hover:bg-slate-700">{fullscreen ? <Minimize2 className="h-4 w-4" aria-hidden="true" /> : <Maximize2 className="h-4 w-4" aria-hidden="true" />}<span className="sr-only">{fullscreen ? 'Exit full-screen playback' : 'Full-screen playback'}</span></button>
            {needsAudioPlayback || needsVideoPlayback ? <button type="button" onClick={() => void enablePlayback()} aria-label="Enable live playback" className="flex min-h-10 items-center gap-2 rounded-lg bg-white px-3 text-xs font-semibold text-slate-900"><Volume2 className="h-4 w-4" aria-hidden="true" />Enable playback</button> : null}
            <form onSubmit={(event) => void postComment(event)} className="flex min-w-0 gap-1">
              <input value={comment} onChange={(event) => setComment(event.target.value)} maxLength={500} aria-label="Live comment" placeholder="Comment…" className="min-h-10 min-w-0 w-24 rounded-lg bg-slate-800 px-2 text-xs text-white placeholder:text-slate-300 sm:w-36" />
              <button type="submit" disabled={commentBusy || !comment.trim()} aria-label="Send live comment" className="min-h-10 min-w-10 rounded-lg bg-indigo-600 text-white disabled:opacity-50"><Send className="mx-auto h-4 w-4" aria-hidden="true" /></button>
            </form>
            <button type="button" onClick={() => void react()} aria-label="Like live broadcast" className="flex min-h-10 min-w-10 items-center justify-center rounded-lg bg-rose-600 text-white"><Heart className="h-4 w-4" aria-hidden="true" /></button>
            <button type="button" onClick={() => void leave().catch((leaveError: unknown) => setError(leaveError instanceof Error ? leaveError.message : 'Unable to leave this live broadcast.'))} aria-label="Leave live broadcast" className="flex min-h-10 items-center gap-2 rounded-lg bg-slate-800 px-3 text-xs font-semibold text-white hover:bg-slate-700"><PhoneOff className="h-4 w-4" aria-hidden="true" />Leave</button>
          </div>
        </div>
      </div> : <button type="button" onClick={() => void join()} disabled={busy} className="inline-flex min-h-10 items-center rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-60">{busy ? 'Connecting…' : 'Watch live'}</button>}
      {error ? <p className="mt-2 text-xs text-rose-700" role="alert">{error}</p> : null}
    </div>
  )
}