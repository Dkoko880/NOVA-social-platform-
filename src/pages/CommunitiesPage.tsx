import { Flag, Globe2, LockKeyhole, Megaphone, Plus, Shield, UserMinus, UserPlus, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '../components/ui/Button'
import { useAuth } from '../context/AuthContext'
import { apiRequest } from '../lib/api'

type Community = {
  id: string
  name: string
  slug: string
  description: string | null
  type: 'GROUP' | 'COMMUNITY' | 'CHANNEL'
  isPrivate: boolean
  memberCount: number
  joined: boolean
  myRole: 'OWNER' | 'MODERATOR' | 'MEMBER' | null
}

type CommunityDetail = Community & {
  members: Array<{ userId: string; role: string; user?: { name: string } | null }>
  posts: Array<{ id: string; content: string; authorId: string; createdAt: string }>
}

type DirectoryUser = { id: string; name: string }

const typeLabels: Record<Community['type'], string> = {
  GROUP: 'Group',
  COMMUNITY: 'Community',
  CHANNEL: 'Channel',
}

export function CommunitiesPage() {
  const { user } = useAuth()
  const [communities, setCommunities] = useState<Community[]>([])
  const [selected, setSelected] = useState<CommunityDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [type, setType] = useState<Community['type']>('COMMUNITY')
  const [isPrivate, setIsPrivate] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const [reportReason, setReportReason] = useState('')
  const [directory, setDirectory] = useState<DirectoryUser[]>([])
  const [inviteId, setInviteId] = useState('')

  const loadCommunities = async () => {
    try {
      setLoading(true)
      const response = await apiRequest<{ communities: Community[] }>('/api/communities')
      setCommunities(response.communities)
      setSelected((current) => current ? response.communities.find((item) => item.id === current.id) ? current : null : null)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load communities.')
    } finally {
      setLoading(false)
    }
  }

  const openCommunity = async (communityId: string) => {
    try {
      const response = await apiRequest<{ community: CommunityDetail }>(`/api/communities/${communityId}`)
      setSelected(response.community)
      setError('')
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to open this community.')
    }
  }

  useEffect(() => { void loadCommunities() }, [])

  const createCommunity = async () => {
    try {
      const response = await apiRequest<{ community: CommunityDetail }>('/api/communities', {
        method: 'POST',
        body: JSON.stringify({ name, description, type, isPrivate }),
      })
      setShowCreate(false)
      setName('')
      setDescription('')
      setIsPrivate(false)
      await loadCommunities()
      await openCommunity(response.community.id)
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Unable to create this community.')
    }
  }

  const joinCommunity = async (communityId: string) => {
    try {
      await apiRequest(`/api/communities/${communityId}/join`, { method: 'POST' })
      await loadCommunities()
      await openCommunity(communityId)
    } catch (joinError) {
      setError(joinError instanceof Error ? joinError.message : 'Unable to join this community.')
    }
  }

  const leaveCommunity = async () => {
    if (!selected || !user) return
    try {
      await apiRequest(`/api/communities/${selected.id}/members/${user.id}`, { method: 'DELETE' })
      setSelected(null)
      await loadCommunities()
    } catch (leaveError) {
      setError(leaveError instanceof Error ? leaveError.message : 'Unable to leave this community.')
    }
  }

  const postAnnouncement = async () => {
    if (!selected || !announcement.trim()) return
    try {
      await apiRequest(`/api/communities/${selected.id}/announcements`, { method: 'POST', body: JSON.stringify({ content: announcement }) })
      setAnnouncement('')
      await openCommunity(selected.id)
    } catch (postError) {
      setError(postError instanceof Error ? postError.message : 'Unable to publish this announcement.')
    }
  }

  const loadDirectory = async () => {
    const response = await apiRequest<{ users: DirectoryUser[] }>('/api/users')
    setDirectory(response.users.filter((person) => person.id !== user?.id && !selected?.members.some((member) => member.userId === person.id)))
  }

  const inviteMember = async () => {
    if (!selected || !inviteId) return
    try {
      await apiRequest(`/api/communities/${selected.id}/invites`, { method: 'POST', body: JSON.stringify({ userId: inviteId }) })
      setInviteId('')
      await openCommunity(selected.id)
      await loadDirectory()
    } catch (inviteError) {
      setError(inviteError instanceof Error ? inviteError.message : 'Unable to invite this member.')
    }
  }

  const submitReport = async () => {
    if (!selected || reportReason.trim().length < 4) return
    try {
      await apiRequest(`/api/communities/${selected.id}/report`, { method: 'POST', body: JSON.stringify({ category: 'OTHER', reason: reportReason }) })
      setReportReason('')
      setError('Report submitted.')
    } catch (reportError) {
      setError(reportError instanceof Error ? reportError.message : 'Unable to submit this report.')
    }
  }

  const updateMemberRole = async (member: CommunityDetail['members'][number]) => {
    if (!selected) return
    try {
      await apiRequest(`/api/communities/${selected.id}/members/${member.userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: member.role === 'MODERATOR' ? 'MEMBER' : 'MODERATOR' }),
      })
      await openCommunity(selected.id)
    } catch (roleError) {
      setError(roleError instanceof Error ? roleError.message : 'Unable to update this member role.')
    }
  }

  const removeMember = async (memberId: string) => {
    if (!selected) return
    try {
      await apiRequest(`/api/communities/${selected.id}/members/${memberId}`, { method: 'DELETE' })
      await openCommunity(selected.id)
      await loadCommunities()
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : 'Unable to remove this member.')
    }
  }

  const canModerate = selected?.myRole === 'OWNER' || selected?.myRole === 'MODERATOR'

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-700">Groups, communities, channels</p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-900">Your spaces</h2>
        </div>
        <Button variant="primary" size="sm" icon={<Plus className="h-4 w-4" aria-hidden="true" />} onClick={() => setShowCreate((current) => !current)}>
          Create space
        </Button>
      </header>

      {error ? <p role="status" className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</p> : null}

      {showCreate ? (
        <section className="grid gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:grid-cols-2">
          <label className="text-sm font-medium text-slate-700">Name
            <input value={name} onChange={(event) => setName(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal" maxLength={80} />
          </label>
          <label className="text-sm font-medium text-slate-700">Type
            <select value={type} onChange={(event) => setType(event.target.value as Community['type'])} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal">
              <option value="GROUP">Group</option><option value="COMMUNITY">Community</option><option value="CHANNEL">Channel</option>
            </select>
          </label>
          <label className="text-sm font-medium text-slate-700 sm:col-span-2">Description
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal" rows={2} maxLength={1000} />
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-700 sm:col-span-2"><input type="checkbox" checked={isPrivate} onChange={(event) => setIsPrivate(event.target.checked)} />Private, invite only</label>
          <div className="sm:col-span-2"><Button variant="primary" size="sm" disabled={name.trim().length < 2} onClick={() => void createCommunity()}>Create</Button></div>
        </section>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.4fr)]">
        <section className="min-w-0">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="font-semibold text-slate-900">Discover</h3>
            <span className="text-xs text-slate-500">{communities.length} spaces</span>
          </div>
          {loading ? <p className="text-sm text-slate-500">Loading spaces…</p> : communities.length === 0 ? <p className="rounded-xl border border-dashed border-slate-300 p-5 text-sm text-slate-500">No spaces yet.</p> : (
            <div className="divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-white">
              {communities.map((community) => (
                <article key={community.id} className={`flex items-center gap-3 p-3 ${selected?.id === community.id ? 'bg-indigo-50' : ''}`}>
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-700">
                    {community.isPrivate ? <LockKeyhole className="h-4 w-4" /> : community.type === 'CHANNEL' ? <Megaphone className="h-4 w-4" /> : community.type === 'GROUP' ? <Users className="h-4 w-4" /> : <Globe2 className="h-4 w-4" />}
                  </div>
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => void openCommunity(community.id)}>
                    <span className="block truncate text-sm font-semibold text-slate-900">{community.name}</span>
                    <span className="text-xs text-slate-500">{typeLabels[community.type]} · {community.memberCount} members</span>
                  </button>
                  {community.joined ? <span className="text-xs text-slate-500">Joined</span> : <Button variant="secondary" size="sm" onClick={() => void joinCommunity(community.id)}>Join</Button>}
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
          {!selected ? <div className="flex min-h-48 flex-col items-center justify-center text-center text-slate-500"><Users className="h-6 w-6" /><p className="mt-2 text-sm">Select a space to view its members and announcements.</p></div> : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-4">
                <div><p className="text-xs font-semibold uppercase text-indigo-700">{typeLabels[selected.type]}{selected.isPrivate ? ' · Private' : ''}</p><h3 className="mt-1 text-xl font-semibold text-slate-900">{selected.name}</h3><p className="mt-1 text-sm text-slate-600">{selected.description}</p><p className="mt-2 text-xs text-slate-500">{selected.memberCount} members</p></div>
                <div className="flex flex-wrap gap-2">
                  {selected.joined && selected.myRole !== 'OWNER' ? <Button variant="secondary" size="sm" onClick={() => void leaveCommunity()}>Leave</Button> : null}
                  {!selected.joined ? <Button variant="primary" size="sm" onClick={() => void joinCommunity(selected.id)}>Join</Button> : null}
                  <Button variant="ghost" size="sm" icon={<Flag className="h-4 w-4" />} onClick={() => void submitReport()} disabled={reportReason.trim().length < 4}>Report</Button>
                </div>
              </div>

              <label className="mt-3 block text-xs text-slate-600">Report reason<input value={reportReason} onChange={(event) => setReportReason(event.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" minLength={4} maxLength={500} /></label>

              {canModerate ? (
                <div className="mt-4 space-y-3 rounded-lg bg-slate-50 p-3">
                  <label className="block text-xs font-medium text-slate-600">Announcement<textarea value={announcement} onChange={(event) => setAnnouncement(event.target.value)} rows={2} maxLength={2500} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" /></label>
                  <div className="flex flex-wrap items-center gap-2"><Button variant="primary" size="sm" icon={<Megaphone className="h-4 w-4" />} onClick={() => void postAnnouncement()} disabled={!announcement.trim()}>Publish</Button><Button variant="secondary" size="sm" icon={<UserPlus className="h-4 w-4" />} onClick={() => void loadDirectory()}>Load invite list</Button>
                    {directory.length ? <><select aria-label="Invite member" value={inviteId} onChange={(event) => setInviteId(event.target.value)} className="max-w-48 rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm"><option value="">Select member</option>{directory.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select><Button variant="secondary" size="sm" onClick={() => void inviteMember()} disabled={!inviteId}>Invite</Button></> : null}
                  </div>
                </div>
              ) : null}

              <div className="mt-5 grid gap-5 md:grid-cols-2">
                <div><h4 className="flex items-center gap-2 text-sm font-semibold text-slate-900"><Shield className="h-4 w-4 text-indigo-700" />Members</h4><ul className="mt-2 divide-y divide-slate-100">{selected.members.map((member) => <li key={member.userId} className="flex items-center justify-between gap-2 py-2 text-sm"><span className="min-w-0 truncate text-slate-700">{member.user?.name ?? member.userId}</span><div className="flex shrink-0 items-center gap-2"><span className="text-xs text-slate-500">{member.role.toLowerCase()}</span>{canModerate && member.role !== 'OWNER' ? <><Button variant="ghost" size="sm" icon={<Shield className="h-3.5 w-3.5" />} onClick={() => void updateMemberRole(member)} aria-label={member.role === 'MODERATOR' ? 'Remove moderator role' : 'Make moderator'} /><Button variant="ghost" size="sm" icon={<UserMinus className="h-3.5 w-3.5" />} onClick={() => void removeMember(member.userId)} aria-label="Remove member" /></> : null}</div></li>)}</ul></div>
                <div><h4 className="text-sm font-semibold text-slate-900">Announcements</h4><ul className="mt-2 space-y-2">{selected.posts.map((post) => <li key={post.id} className="rounded-lg bg-slate-50 p-3"><p className="whitespace-pre-wrap text-sm text-slate-700">{post.content}</p><time className="mt-1 block text-[11px] text-slate-500">{new Date(post.createdAt).toLocaleString()}</time></li>)}{selected.posts.length === 0 ? <li className="text-sm text-slate-500">No announcements yet.</li> : null}</ul></div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
