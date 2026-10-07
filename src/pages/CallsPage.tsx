import { useEffect, useMemo, useState } from 'react'
import { Phone, Search, Video } from 'lucide-react'
import { Button } from '../components/ui/Button'
import { useAuth } from '../context/AuthContext'
import { apiRequest, API_BASE_URL } from '../lib/api'

type CallParticipant = { userId: string; status: string; muted: boolean; cameraOn: boolean; speakerOn: boolean }
type CallSession = {
  id: string
  callerId: string
  targetUserId: string | null
  type: 'voice' | 'video'
  status: string
  participants: CallParticipant[]
  provider?: string
  providerConfigured?: boolean
  createdAt: string
}
type DirectoryUser = { id: string; name: string; handle: string }

export function CallsPage() {
  const { user } = useAuth()
  const [calls, setCalls] = useState<CallSession[]>([])
  const [users, setUsers] = useState<DirectoryUser[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')

  const loadData = async () => {
    setLoading(true)
    setError('')
    try {
      const [history, directory] = await Promise.all([
        apiRequest<{ calls: CallSession[] }>('/api/calls/history'),
        apiRequest<{ users: DirectoryUser[] }>('/api/users'),
      ])
      setCalls(history.calls)
      setUsers(directory.users.filter((person) => person.id !== user?.id))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load calls.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadData() }, [user?.id])

  useEffect(() => {
    const source = new EventSource(`${API_BASE_URL}/api/realtime`, { withCredentials: true })
    const onCallUpdate = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as { call?: CallSession }
        if (payload.call?.participants.some((participant) => participant.userId === user?.id)) {
          setCalls((current) => current.some((call) => call.id === payload.call!.id)
            ? current.map((call) => call.id === payload.call!.id ? payload.call! : call)
            : [payload.call!, ...current])
        }
      } catch {
        setError('A call status update could not be read. Refresh call history to retry.')
      }
    }
    source.addEventListener('call:update', onCallUpdate)
    return () => source.close()
  }, [user?.id])

  const filteredUsers = useMemo(() => users.filter((person) => `${person.name} ${person.handle}`.toLowerCase().includes(query.toLowerCase())), [users, query])

  const callAction = async (call: CallSession, action: 'accept' | 'reject' | 'cancel' | 'end' | 'leave') => {
    setBusyId(call.id)
    setError('')
    try {
      const response = await apiRequest<{ call: CallSession }>(`/api/calls/${encodeURIComponent(call.id)}/${action}`, { method: 'POST' })
      setCalls((current) => current.map((item) => item.id === call.id ? response.call : item))
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Unable to update this call.')
    } finally {
      setBusyId('')
    }
  }

  const nameFor = (userId: string) => userId === user?.id ? 'You' : users.find((person) => person.id === userId)?.name ?? 'NOVAKOKO member'
  const activeCalls = calls.filter((call) => !['ended', 'cancelled', 'rejected'].includes(call.status))

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <header><p className="text-xs font-semibold uppercase text-indigo-700">Calls</p><h2 className="mt-2 text-2xl font-semibold text-slate-900">Call history</h2></header>
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="status">Calls are unavailable because real-time media and signaling are not configured. No calls will be shown as connected until a real media session is established.</div>
      {error ? <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</p> : null}

      <section className="rounded-2xl border border-slate-200 bg-white p-4">
        <h3 className="font-semibold text-slate-900">Start a call</h3>
        <label className="mt-3 flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-500"><Search className="h-4 w-4" aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a person" aria-label="Find a person to call" className="min-w-0 flex-1 bg-transparent text-slate-800 outline-none" /></label>
        <ul className="mt-3 divide-y divide-slate-100">
          {filteredUsers.map((person) => <li key={person.id} className="flex flex-wrap items-center gap-3 py-3"><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-slate-900">{person.name}</span><span className="text-xs text-slate-500">@{person.handle}</span></span><Button variant="secondary" size="sm" disabled icon={<Phone className="h-4 w-4" aria-hidden="true" />}>Voice unavailable</Button><Button variant="secondary" size="sm" disabled icon={<Video className="h-4 w-4" aria-hidden="true" />}>Video unavailable</Button></li>)}
          {!loading && filteredUsers.length === 0 ? <li className="py-4 text-sm text-slate-500">No people match this search.</li> : null}
        </ul>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between"><h3 className="font-semibold text-slate-900">Recent and active calls</h3><Button variant="ghost" size="sm" onClick={() => void loadData()} disabled={loading}>Refresh</Button></div>
        {loading ? <p className="rounded-xl bg-white p-4 text-sm text-slate-500">Loading call history…</p> : null}
        {!loading && calls.length === 0 ? <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">No calls yet.</p> : null}
        <ul className="divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-white">
          {calls.map((call) => {
            const own = call.participants.find((participant) => participant.userId === user?.id)
            const counterparties = call.participants.filter((participant) => participant.userId !== user?.id).map((participant) => nameFor(participant.userId)).join(', ')
            const incoming = call.callerId !== user?.id && own?.status === 'pending'
            return <li key={call.id} className="flex flex-wrap items-center gap-3 p-4"><span className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-600">{call.type === 'video' ? <Video className="h-5 w-5" /> : <Phone className="h-5 w-5" />}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-slate-900">{counterparties || 'Call'}</p><p className="mt-1 text-xs text-slate-500">{call.type} · {call.status} · {new Date(call.createdAt).toLocaleString()}</p>{call.providerConfigured === false ? <p className="mt-1 text-xs text-amber-700">Media unavailable: provider not configured</p> : null}</div>{incoming ? <><Button variant="primary" size="sm" disabled>Accept unavailable</Button><Button variant="secondary" size="sm" disabled={busyId === call.id} onClick={() => void callAction(call, 'reject')}>Decline</Button></> : null}{call.callerId === user?.id && call.status === 'ringing' ? <Button variant="secondary" size="sm" disabled={busyId === call.id} onClick={() => void callAction(call, 'cancel')}>Cancel</Button> : null}{call.status === 'connected' && own?.status !== 'left' ? <Button variant="secondary" size="sm" disabled={busyId === call.id} onClick={() => void callAction(call, 'leave')}>Leave</Button> : null}</li>
          })}
        </ul>
        {activeCalls.length > 0 ? <p className="mt-2 text-xs text-slate-500">Call actions are restricted while media and signaling are unavailable.</p> : null}
      </section>
    </div>
  )
}