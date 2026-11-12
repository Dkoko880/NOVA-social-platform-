import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Phone, PhoneOff, Volume2 } from 'lucide-react'
import { Avatar } from './ui/Avatar'
import { useAuth } from '../context/AuthContext'
import { apiRequest, resolveMediaUrl } from '../lib/api'
import { openAuthenticatedEventStream } from '../lib/eventStream'
import { getIncomingCallForUser } from '../lib/callPresentation'

type CallParticipant = { userId: string; status: string }
type CallSession = {
  id: string
  callerId: string
  type: 'voice' | 'video'
  status: string
  participants: CallParticipant[]
  createdAt: string
  updatedAt?: string
}
type DirectoryUser = {
  id: string
  name: string
  profile?: { displayName?: string; avatarUrl?: string | null }
}
type NotificationPreferences = { key: string; enabled: boolean }[]

function mergeCallHistory(history: CallSession[], current: CallSession[]) {
  const merged = new Map(history.map((call) => [call.id, call]))
  for (const call of current) {
    const saved = merged.get(call.id)
    if (!saved || Date.parse(call.updatedAt ?? call.createdAt) > Date.parse(saved.updatedAt ?? saved.createdAt)) {
      merged.set(call.id, call)
    }
  }
  return [...merged.values()].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
}

function createRingtone(type: CallSession['type'], onBlocked: () => void) {
  const audio = new Audio(`/audio/${type === 'video' ? 'video' : 'voice'}-call-ringtone.wav`)
  audio.loop = true
  const resume = () => audio.play()
  void resume().catch(onBlocked)

  return {
    stop: () => {
      audio.pause()
      audio.currentTime = 0
    },
    resume,
  }
}

export function IncomingCallManager() {
  const { user, isLoading } = useAuth()
  const navigate = useNavigate()
  const [calls, setCalls] = useState<CallSession[]>([])
  const [users, setUsers] = useState<DirectoryUser[]>([])
  const [callsEnabled, setCallsEnabled] = useState(true)
  const [busyCallId, setBusyCallId] = useState('')
  const [audioBlocked, setAudioBlocked] = useState(false)
  const [actionError, setActionError] = useState('')
  const [callsLoaded, setCallsLoaded] = useState(false)
  const [audioPrompt, setAudioPrompt] = useState<(() => Promise<void>) | null>(null)
  const [isCallManagerOwner, setIsCallManagerOwner] = useState(true)
  const callsRef = useRef<CallSession[]>([])
  const handledNotificationRef = useRef('')
  const callManagerOwnerRef = useRef(true)
  callManagerOwnerRef.current = isCallManagerOwner

  useEffect(() => {
    if (!user || isLoading) {
      setIsCallManagerOwner(true)
      return
    }
    const lockKey = `novachat:incoming-call-owner:${user.id}`
    const tabId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
    const readOwner = () => {
      const saved = window.localStorage.getItem(lockKey)
      return saved ? JSON.parse(saved) as { tabId: string; expiresAt: number; visible: boolean } : null
    }
    const claimOrRenew = () => {
      try {
        const current = readOwner()
        const visible = document.visibilityState === 'visible'
        if (!current || current.expiresAt <= Date.now() || current.tabId === tabId || (visible && !current.visible)) {
          window.localStorage.setItem(lockKey, JSON.stringify({ tabId, expiresAt: Date.now() + 12_000, visible }))
        }
        setIsCallManagerOwner(readOwner()?.tabId === tabId)
      } catch {
        setIsCallManagerOwner(true)
      }
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key !== lockKey) return
      claimOrRenew()
    }
    const onVisibilityChange = () => claimOrRenew()
    claimOrRenew()
    const heartbeat = window.setInterval(claimOrRenew, 4000)
    window.addEventListener('storage', onStorage)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.clearInterval(heartbeat)
      window.removeEventListener('storage', onStorage)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      try {
        if (readOwner()?.tabId === tabId) window.localStorage.removeItem(lockKey)
      } catch {
        setIsCallManagerOwner(true)
      }
    }
  }, [isLoading, user?.id])

  const applyCall = useCallback((call: CallSession) => {
    const next = callsRef.current.filter((entry) => entry.id !== call.id)
    next.push(call)
    next.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    callsRef.current = next
    setCalls(next)
  }, [])

  useEffect(() => {
    if (isLoading || !user) {
      callsRef.current = []
      setCalls([])
      setUsers([])
      setCallsLoaded(false)
      return
    }
    let active = true
    void Promise.all([
      apiRequest<{ calls: CallSession[] }>(`/api/calls/history?sync=${Date.now()}`),
      apiRequest<{ users: DirectoryUser[] }>('/api/users'),
      apiRequest<{ preferences: NotificationPreferences }>('/api/notifications/preferences'),
    ]).then(([history, directory, preferences]) => {
      if (!active) return
      const merged = mergeCallHistory(history.calls, callsRef.current)
      callsRef.current = merged
      setCalls(merged)
      setUsers(directory.users)
      setCallsEnabled(preferences.preferences.find((preference) => preference.key === 'calls')?.enabled ?? true)
      setCallsLoaded(true)
    }).catch((error: unknown) => {
      setActionError(error instanceof Error ? error.message : 'Call notifications could not be loaded.')
      setCallsLoaded(true)
      console.error('Unable to initialize the global incoming-call manager.', error)
    })

    const stream = openAuthenticatedEventStream('/api/realtime')
    stream.addEventListener('call:update', (event) => {
      try {
        const payload = JSON.parse(event.data) as { call?: CallSession }
        const call = payload.call
        if (!call || !call.participants.some((participant) => participant.userId === user.id)) return
        applyCall(call)
        if (callManagerOwnerRef.current && getIncomingCallForUser([call], user.id) && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
          void navigator.serviceWorker?.ready.then((registration) => {
            const options: NotificationOptions & { actions: { action: string; title: string }[] } = {
              body: 'Open NOVACHAT to answer or decline this call.',
              tag: `novachat-call-${call.id}`,
              icon: '/icons/icon-192.png',
              data: { callId: call.id },
              actions: [{ action: 'accept', title: 'Accept' }, { action: 'reject', title: 'Reject' }],
            }
            return registration.showNotification(`Incoming ${call.type} call`, options)
          }).catch((error: unknown) => console.error('Unable to show an incoming call notification.', error))
        }
      } catch (error) {
        console.error('Unable to read a global call update.', error)
      }
    })
    const refreshCallState = () => {
      void apiRequest<{ calls: CallSession[] }>(`/api/calls/history?sync=${Date.now()}`)
        .then((history) => {
          if (!active) return
          const merged = mergeCallHistory(history.calls, callsRef.current)
          callsRef.current = merged
          setCalls(merged)
        })
        .catch((error: unknown) => console.error('Unable to refresh global call state.', error))
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshCallState()
    }
    const refreshTimer = window.setInterval(refreshCallState, 15_000)
    document.addEventListener('visibilitychange', onVisibilityChange)
    const onCallPreferenceChange = (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail?.enabled !== 'boolean') return
      setCallsEnabled(event.detail.enabled)
    }
    window.addEventListener('novachat:call-notification-preference', onCallPreferenceChange)

    return () => {
      active = false
      stream.close()
      window.clearInterval(refreshTimer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('novachat:call-notification-preference', onCallPreferenceChange)
    }
  }, [applyCall, isLoading, user])

  const incomingCall = useMemo(() => {
    if (!user) return undefined
    return getIncomingCallForUser(calls, user.id)
  }, [calls, user])

  useEffect(() => {
    if (!incomingCall || !callsEnabled || !isCallManagerOwner) {
      setAudioBlocked(false)
      setAudioPrompt(null)
      return
    }
    const ringtone = createRingtone(incomingCall.type, () => setAudioBlocked(true))
    setAudioPrompt(() => () => ringtone.resume().then(() => setAudioBlocked(false)).catch(() => setAudioBlocked(true)))
    const vibration = 'vibrate' in navigator ? window.setInterval(() => navigator.vibrate?.([350, 250, 350]), 1800) : undefined
    return () => {
      ringtone.stop()
      if (vibration !== undefined) {
        window.clearInterval(vibration)
        navigator.vibrate?.(0)
      }
    }
  }, [callsEnabled, incomingCall, isCallManagerOwner])

  useEffect(() => {
    const handleNotificationRoute = () => {
      const parameters = new URLSearchParams(window.location.search)
      const callId = parameters.get('call')
      const action = parameters.get('callAction')
      if (!callId || !action || isLoading || !user || !callsLoaded || handledNotificationRef.current === `${callId}:${action}`) return
      if (!['accept', 'reject'].includes(action)) {
        window.history.replaceState(window.history.state, '', window.location.pathname)
        return
      }
      handledNotificationRef.current = `${callId}:${action}`
      const requestedCall = callsRef.current.find((call) => call.id === callId)
      if (!requestedCall || !getIncomingCallForUser([requestedCall], user.id)) {
        window.history.replaceState(window.history.state, '', window.location.pathname)
        return
      }
      void (async () => {
        try {
          const endpoint = action === 'accept' ? 'accept' : 'reject'
          const response = await apiRequest<{ call: CallSession }>(`/api/calls/${encodeURIComponent(callId)}/${endpoint}`, { method: 'POST' })
          applyCall(response.call)
          window.history.replaceState(window.history.state, '', window.location.pathname)
          if (action === 'accept') navigate(`/calls?call=${encodeURIComponent(callId)}&accepted=1`)
        } catch (error) {
          setActionError(error instanceof Error ? error.message : 'Unable to respond to this call notification.')
          console.error('Unable to handle the call notification action.', error)
        }
      })()
    }
    handleNotificationRoute()
    window.addEventListener('popstate', handleNotificationRoute)
    return () => window.removeEventListener('popstate', handleNotificationRoute)
  }, [applyCall, calls, callsLoaded, isLoading, navigate, user])

  const respond = async (call: CallSession, action: 'accept' | 'reject') => {
    setBusyCallId(call.id)
    setActionError('')
    try {
      const response = await apiRequest<{ call: CallSession }>(`/api/calls/${encodeURIComponent(call.id)}/${action}`, { method: 'POST' })
      applyCall(response.call)
      if (action === 'accept') navigate(`/calls?call=${encodeURIComponent(call.id)}&accepted=1`)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : `Unable to ${action} this call.`)
      console.error(`Unable to ${action} incoming call.`, error)
    } finally {
      setBusyCallId('')
    }
  }

  if (!incomingCall || !isCallManagerOwner) return null
  const caller = users.find((person) => person.id === incomingCall.callerId)
  const callerName = caller?.profile?.displayName || caller?.name || 'NOVACHAT member'

  return (
    <section
      aria-label="Incoming call"
      aria-modal="true"
      className="fixed inset-0 z-[100] flex h-[100dvh] flex-col items-center justify-center gap-5 overflow-y-auto bg-gradient-to-b from-indigo-950 via-slate-950 to-black px-[max(1.25rem,env(safe-area-inset-left))] py-[max(1rem,env(safe-area-inset-top))] text-white"
      role="dialog"
    >
      <Avatar src={resolveMediaUrl(caller?.profile?.avatarUrl)} alt={callerName} size="xl" />
      <div className="max-w-full text-center">
        <h2 className="break-words text-2xl font-semibold">{callerName}</h2>
        <p className="mt-2 text-sm text-white/75">Incoming {incomingCall.type === 'video' ? 'video' : 'voice'} call</p>
        <p className="mt-1 text-sm text-emerald-200">Ringing</p>
      </div>
      {actionError ? <p role="alert" className="max-w-md rounded-xl bg-rose-950/70 px-4 py-2 text-center text-sm text-rose-100">{actionError}</p> : null}
      {audioBlocked && callsEnabled ? (
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-full border border-white/30 px-4 py-2 text-sm text-white"
          onClick={() => { void audioPrompt?.().catch(() => setAudioBlocked(true)) }}
        >
          <Volume2 className="h-4 w-4" aria-hidden="true" /> Tap to enable ringing
        </button>
      ) : null}
      {!callsEnabled ? <p className="text-sm text-white/70">Call alerts are muted in your notification preferences.</p> : null}
      <div className="mt-8 flex items-center gap-10">
        <button
          type="button"
          onClick={() => void respond(incomingCall, 'reject')}
          disabled={busyCallId === incomingCall.id}
          className="flex min-h-16 min-w-16 items-center justify-center rounded-full bg-rose-600 text-white shadow-lg hover:bg-rose-700 disabled:opacity-50"
          aria-label="Reject call"
        >
          <PhoneOff className="h-7 w-7" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={() => void respond(incomingCall, 'accept')}
          disabled={busyCallId === incomingCall.id}
          className="flex min-h-16 min-w-16 items-center justify-center rounded-full bg-emerald-600 text-white shadow-lg hover:bg-emerald-700 disabled:opacity-50"
          aria-label="Accept call"
        >
          <Phone className="h-7 w-7" aria-hidden="true" />
        </button>
      </div>
      {busyCallId === incomingCall.id ? <p className="text-sm text-white/75">Connecting securely…</p> : null}
    </section>
  )
}
