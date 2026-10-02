import { ChevronRight, Lock, ShieldCheck, Bell, UserCog, HelpCircle, SlidersHorizontal, LogOut, MonitorSmartphone } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { ApiError, apiRequest } from '../lib/api'
import { settingsGroups } from '../data/mockData'

const iconMap = {
  account: UserCog,
  privacy: Lock,
  security: ShieldCheck,
  notifications: Bell,
  safety: SlidersHorizontal,
  help: HelpCircle,
}

type Session = {
  id: string
  userAgent: string | null
  deviceName: string | null
  ipAddress: string | null
  createdAt: string
  lastSeenAt: string | null
  expiresAt: string
}

export function SettingsPage() {
  const navigate = useNavigate()
  const { logout } = useAuth()
  const [sessions, setSessions] = useState<Session[]>([])
  const [sessionError, setSessionError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let mounted = true
    apiRequest<{ sessions: Session[] }>('/api/auth/sessions')
      .then((response) => { if (mounted) setSessions(response.sessions) })
      .catch(() => { if (mounted) setSessionError('Active sessions could not be loaded.') })
    return () => { mounted = false }
  }, [])

  const revokeSession = async (id: string) => {
    setBusy(true)
    setSessionError('')
    try {
      await apiRequest(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
      setSessions((current) => current.filter((session) => session.id !== id))
    } catch (error) {
      setSessionError(error instanceof ApiError ? error.message : 'This session could not be revoked.')
    } finally {
      setBusy(false)
    }
  }

  const revokeAllSessions = async () => {
    setBusy(true)
    setSessionError('')
    try {
      await apiRequest('/api/auth/logout-all', { method: 'POST' })
      await logout()
      navigate('/login', { replace: true })
    } catch (error) {
      setSessionError(error instanceof ApiError ? error.message : 'Sessions could not be ended.')
      setBusy(false)
    }
  }

  return (
    <div className="p-4 sm:p-6">
      <div className="mx-auto max-w-5xl rounded-[32px] border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
        <div>
          <p className="text-xs uppercase tracking-[0.28em] text-violet-600">Preferences</p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-900">Settings</h2>
        </div>

        <section className="mt-6 border-t border-slate-200 pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <MonitorSmartphone className="h-5 w-5 text-violet-700" aria-hidden="true" />
              <div>
                <h3 className="font-semibold text-slate-900">Active sessions</h3>
                <p className="text-sm text-slate-500">Devices currently signed in to your account.</p>
              </div>
            </div>
            <button type="button" onClick={() => void revokeAllSessions()} disabled={busy || sessions.length === 0} className="inline-flex items-center gap-2 rounded-lg border border-rose-200 px-3 py-2 text-sm font-semibold text-rose-700 disabled:opacity-50">
              <LogOut className="h-4 w-4" aria-hidden="true" /> Sign out all devices
            </button>
          </div>
          {sessionError ? <p className="mt-3 text-sm text-rose-700" role="alert">{sessionError}</p> : null}
          <ul className="mt-4 divide-y divide-slate-200">
            {sessions.map((session) => (
              <li key={session.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-800">{session.deviceName || session.userAgent || 'Unknown device'}</p>
                  <p className="mt-1 text-xs text-slate-500">{session.ipAddress || 'Location unavailable'} · Signed in {new Date(session.createdAt).toLocaleString()}</p>
                </div>
                <button type="button" onClick={() => void revokeSession(session.id)} disabled={busy} className="rounded-lg px-3 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50">Revoke</button>
              </li>
            ))}
            {sessions.length === 0 ? <li className="py-4 text-sm text-slate-500">No active sessions found.</li> : null}
          </ul>
        </section>

        <div className="mt-6 space-y-5">
          {settingsGroups.map((group) => {
            const Icon = iconMap[group.id as keyof typeof iconMap] ?? UserCog

            return (
              <section key={group.id} className="rounded-[24px] border border-slate-200 bg-slate-50 p-4">
                <div className="mb-4 flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white text-violet-700 shadow-sm">
                    <Icon className="h-4 w-4" aria-hidden="true" />
                  </div>
                  <p className="font-semibold text-slate-900">{group.title}</p>
                </div>
                <div className="space-y-2">
                  {group.items.map((item) => (
                    <div key={item.label} className="flex items-center justify-between gap-3 rounded-2xl bg-white px-3 py-3 text-sm">
                      <span className="text-slate-700">{item.label}</span>
                      <span className={`inline-flex items-center gap-2 ${item.highlight ? 'font-semibold text-violet-700' : 'text-slate-500'}`}>
                        {item.value}
                        <ChevronRight className="h-4 w-4" aria-hidden="true" />
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}
