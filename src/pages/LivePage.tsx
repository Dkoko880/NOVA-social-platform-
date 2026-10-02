import { useEffect, useState, type FormEvent } from 'react'
import { Headphones, Radio, Users } from 'lucide-react'
import { Button } from '../components/ui/Button'
import { useAuth } from '../context/AuthContext'
import { apiRequest } from '../lib/api'

type LiveComment = { id: string; userId: string; text: string; createdAt: string }
type LiveSession = {
  id: string
  hostId: string
  title: string
  description?: string | null
  visibility: string
  status: string
  viewerCount: number
  provider?: string
  providerConfigured: boolean
  comments: LiveComment[]
}

export function LivePage() {
  const { user } = useAuth()
  const [lives, setLives] = useState<LiveSession[]>([])
  const [joinedLive, setJoinedLive] = useState<LiveSession | null>(null)
  const [comment, setComment] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const loadLives = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await apiRequest<{ lives: LiveSession[] }>('/api/live')
      setLives(response.lives)
      if (joinedLive) setJoinedLive(response.lives.find((live) => live.id === joinedLive.id) ?? null)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load live sessions.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadLives() }, [])

  const joinLive = async (live: LiveSession) => {
    setBusy(true)
    setError('')
    try {
      const response = await apiRequest<{ live: LiveSession }>(`/api/live/${encodeURIComponent(live.id)}/viewers/join`, { method: 'POST' })
      setJoinedLive(response.live)
      setLives((current) => current.map((item) => item.id === live.id ? response.live : item))
    } catch (joinError) {
      setError(joinError instanceof Error ? joinError.message : 'Unable to join this live session.')
    } finally {
      setBusy(false)
    }
  }

  const leaveLive = async () => {
    if (!joinedLive) return
    setBusy(true)
    try {
      await apiRequest(`/api/live/${encodeURIComponent(joinedLive.id)}/viewers/leave`, { method: 'POST' })
      setJoinedLive(null)
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

  const unavailable = lives.length === 0 || lives.every((live) => !live.providerConfigured)

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <header>
        <p className="inline-flex items-center gap-2 text-xs font-semibold uppercase text-indigo-700"><Radio className="h-4 w-4" aria-hidden="true" /> Live</p>
        <h2 className="mt-2 text-2xl font-semibold text-slate-900">Live sessions</h2>
      </header>

      {unavailable ? <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" role="status">Live streaming is unavailable because no media provider is configured.</div> : null}
      {error ? <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700" role="alert">{error}</p> : null}

      {joinedLive ? (
        <section className="rounded-2xl border border-indigo-200 bg-indigo-50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><h3 className="font-semibold text-slate-900">{joinedLive.title}</h3><p className="text-sm text-slate-600">{joinedLive.providerConfigured ? 'You joined as a listener.' : 'The streaming provider is unavailable.'}</p></div>
            <Button variant="secondary" size="sm" onClick={() => void leaveLive()} disabled={busy}>Leave session</Button>
          </div>
          {joinedLive.providerConfigured ? <>
            <ul className="mt-4 max-h-48 space-y-2 overflow-y-auto">{joinedLive.comments.map((entry) => <li key={entry.id} className="rounded-xl bg-white p-2 text-sm text-slate-700">{entry.text}</li>)}</ul>
            <form onSubmit={(event) => void postComment(event)} className="mt-3 flex gap-2"><input value={comment} onChange={(event) => setComment(event.target.value)} maxLength={500} aria-label="Live comment" placeholder="Write a comment" className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm" /><Button type="submit" variant="primary" size="sm" disabled={busy || !comment.trim()}>Send</Button></form>
          </> : null}
        </section>
      ) : null}

      {loading ? <p className="rounded-xl bg-white p-4 text-sm text-slate-500">Loading sessions…</p> : null}
      {!loading && lives.length === 0 && !error ? <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">No live sessions are available.</p> : null}
      <ul className="divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-white">
        {lives.map((live) => (
          <li key={live.id} className="flex flex-wrap items-center gap-3 p-4">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-700"><Headphones className="h-5 w-5" aria-hidden="true" /></span>
            <div className="min-w-0 flex-1"><h3 className="truncate font-semibold text-slate-900">{live.title}</h3><p className="mt-1 text-sm text-slate-500">{live.description || `Hosted by ${live.hostId === user?.id ? 'you' : 'a NOVAKOKO member'}`} · {live.viewerCount} listeners · {live.status}</p></div>
            {live.providerConfigured && live.status === 'live' ? <><Button variant="secondary" size="sm" onClick={() => void react(live)}>React</Button><Button variant="primary" size="sm" onClick={() => void joinLive(live)} disabled={busy}>Join</Button></> : <span className="text-xs font-medium text-amber-700">Streaming unavailable</span>}
            {live.hostId === user?.id && live.providerConfigured && live.status !== 'live' ? <Button variant="primary" size="sm" onClick={() => void apiRequest<{ live: LiveSession }>(`/api/live/${encodeURIComponent(live.id)}/start`, { method: 'POST' }).then(({ live: updated }) => setLives((current) => current.map((item) => item.id === updated.id ? updated : item))).catch((startError) => setError(startError instanceof Error ? startError.message : 'Unable to start the session.'))}>Start</Button> : null}
          </li>
        ))}
      </ul>

      <div className="flex justify-end"><Button variant="secondary" size="sm" onClick={() => void loadLives()} disabled={loading}><Users className="h-4 w-4" aria-hidden="true" /> Refresh</Button></div>
    </div>
  )
}