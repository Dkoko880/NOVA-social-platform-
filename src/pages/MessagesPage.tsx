import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Archive, Image, Pin, Search, SendHorizontal, Star, VolumeX } from 'lucide-react'
import { Avatar } from '../components/ui/Avatar'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { useAuth } from '../context/AuthContext'
import { apiRequest, API_BASE_URL } from '../lib/api'

type ConversationParticipant = { userId: string; role?: string; user?: { id: string; name: string } }
type ConversationListItem = {
  id: string
  name: string | null
  participants: ConversationParticipant[]
  lastMessagePreview: string | null
  updatedAt: string
  lastMessageAt: string | null
  lastMessage?: { id: string; senderId: string; text: string; createdAt: string; readAt?: string | null; status?: string }
  pinnedAt?: string | null
  archivedAt?: string | null
  starredAt?: string | null
  mutedUntil?: string | null
}
type MessageReaction = { id?: string; userId: string; type: string }
type MessageItem = {
  id: string
  conversationId: string
  senderId: string
  text: string
  createdAt: string
  updatedAt: string
  readAt?: string | null
  deletedAt?: string | null
  status?: string
  contentType?: string
  mediaUrl?: string | null
  metadata?: Record<string, unknown> | null
  replyToId?: string | null
  forwardedFromId?: string | null
  editedAt?: string | null
  reactions?: MessageReaction[]
}
type DirectoryUser = { id: string; name: string }

export function MessagesPage() {
  const { user } = useAuth()
  const [conversations, setConversations] = useState<ConversationListItem[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [messages, setMessages] = useState<MessageItem[]>([])
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [messagesLoading, setMessagesLoading] = useState(false)
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [search, setSearch] = useState('')
  const [messageSearch, setMessageSearch] = useState('')
  const [searchResults, setSearchResults] = useState<MessageItem[] | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [isGroup, setIsGroup] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [selectedParticipants, setSelectedParticipants] = useState<string[]>([])
  const [directory, setDirectory] = useState<DirectoryUser[]>([])
  const [directoryError, setDirectoryError] = useState('')
  const [hasMore, setHasMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [replyTarget, setReplyTarget] = useState<MessageItem | null>(null)
  const [editingId, setEditingId] = useState('')
  const [editDraft, setEditDraft] = useState('')
  const [forwardingId, setForwardingId] = useState('')
  const [forwardTargetId, setForwardTargetId] = useState('')
  const [showMedia, setShowMedia] = useState(false)
  const [media, setMedia] = useState<MessageItem[]>([])
  const [composeType, setComposeType] = useState('TEXT')
  const [mediaUrl, setMediaUrl] = useState('')
  const [contactName, setContactName] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [locationLabel, setLocationLabel] = useState('')
  const [latitude, setLatitude] = useState('')
  const [longitude, setLongitude] = useState('')
  const [showArchived, setShowArchived] = useState(false)

  const loadConversations = async () => {
    try {
      setLoading(true)
      setError('')
      const response = await apiRequest<{ conversations: ConversationListItem[] }>('/api/conversations')
      setConversations(response.conversations)
      setSelectedId((current) => current || response.conversations[0]?.id || '')
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load conversations.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadConversations() }, [])

  useEffect(() => {
    const source = new EventSource(`${API_BASE_URL}/api/realtime`, { withCredentials: true })
    const onMessage = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as { conversationId: string; message?: MessageItem; messageId?: string; reactions?: MessageReaction[]; deleted?: boolean }
        if (payload.conversationId === selectedId) {
          if (payload.message) {
            setMessages((current) => current.some((message) => message.id === payload.message!.id)
              ? current.map((message) => message.id === payload.message!.id ? payload.message! : message)
              : [...current, payload.message!])
          } else if (payload.messageId && payload.reactions) {
            setMessages((current) => current.map((message) => message.id === payload.messageId ? { ...message, reactions: payload.reactions } : message))
          }
        }
        void loadConversations()
      } catch {
        setError('A live message update could not be read. Reopen the conversation to refresh.')
      }
    }
    const onRead = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as { messageId: string; readAt: string }
        setMessages((current) => current.map((message) => message.id === payload.messageId ? { ...message, readAt: payload.readAt, status: 'READ' } : message))
      } catch {
        setError('A read status update could not be read.')
      }
    }
    source.addEventListener('message:new', onMessage)
    source.addEventListener('message:read', onRead)
    return () => source.close()
  }, [selectedId])

  useEffect(() => {
    if (!selectedId) {
      setMessages([])
      return
    }

    const loadMessages = async () => {
      try {
        setMessagesLoading(true)
        setError('')
        const response = await apiRequest<{ messages: MessageItem[]; hasMore: boolean }>(`/api/conversations/${encodeURIComponent(selectedId)}/messages?limit=50`)
        setMessages(response.messages)
        setHasMore(response.hasMore)
        await apiRequest(`/api/conversations/${encodeURIComponent(selectedId)}/read`, { method: 'POST' })
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Unable to load messages.')
      } finally {
        setMessagesLoading(false)
      }
    }

    void loadMessages()
  }, [selectedId])

  const loadDirectory = async () => {
    setDirectoryError('')
    try {
      const response = await apiRequest<{ users: DirectoryUser[] }>('/api/users')
      setDirectory(response.users.filter((directoryUser) => directoryUser.id !== user?.id))
    } catch (loadError) {
      setDirectoryError(loadError instanceof Error ? loadError.message : 'Unable to load users.')
    }
  }

  const openNewConversation = async () => {
    setShowNew((current) => !current)
    setSelectedParticipants([])
    if (!directory.length) await loadDirectory()
  }

  const createConversation = async (participantId?: string) => {
    try {
      const payload = isGroup
        ? { participantIds: selectedParticipants, ...(groupName.trim() ? { name: groupName.trim() } : {}) }
        : { participantId }
      const response = await apiRequest<{ conversation: { id: string } }>('/api/conversations', { method: 'POST', body: JSON.stringify(payload) })
      await loadConversations()
      setSelectedId(response.conversation.id)
      setShowNew(false)
      setIsGroup(false)
      setGroupName('')
      setSelectedParticipants([])
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Unable to start conversation.')
    }
  }

  const activeConversation = useMemo(() => conversations.find((conversation) => conversation.id === selectedId) ?? null, [conversations, selectedId])
  const activePeer = useMemo(() => activeConversation?.participants.find((participant) => participant.userId !== user?.id)?.user ?? null, [activeConversation, user])
  const visibleConversations = useMemo(() => conversations
    .filter((conversation) => showArchived || !conversation.archivedAt)
    .filter((conversation) => {
      const peer = conversation.participants.find((participant) => participant.userId !== user?.id)?.user
      return `${conversation.name ?? ''} ${peer?.name ?? ''}`.toLowerCase().includes(search.toLowerCase())
    })
    .sort((left, right) => Number(Boolean(right.pinnedAt)) - Number(Boolean(left.pinnedAt)) || new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()), [conversations, search, showArchived, user?.id])

  const loadOlderMessages = async () => {
    if (!selectedId || !messages[0] || loadingOlder) return
    try {
      setLoadingOlder(true)
      const response = await apiRequest<{ messages: MessageItem[]; hasMore: boolean }>(`/api/conversations/${encodeURIComponent(selectedId)}/messages?limit=50&before=${encodeURIComponent(messages[0].createdAt)}`)
      setMessages((current) => [...response.messages, ...current])
      setHasMore(response.hasMore)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load older messages.')
    } finally {
      setLoadingOlder(false)
    }
  }

  const canSend = composeType === 'TEXT' ? Boolean(draft.trim())
    : ['IMAGE', 'VIDEO', 'DOCUMENT', 'VOICE'].includes(composeType) ? Boolean(mediaUrl.trim())
      : composeType === 'CONTACT' ? Boolean(contactName.trim() && contactPhone.trim())
        : Boolean(latitude.trim() && longitude.trim())

  const handleSendMessage = async (event?: FormEvent) => {
    event?.preventDefault()
    if (!canSend || !selectedId || sending) return
    const metadata = composeType === 'CONTACT' ? { name: contactName.trim(), phone: contactPhone.trim() }
      : composeType === 'LOCATION' ? { label: locationLabel.trim(), latitude: Number(latitude), longitude: Number(longitude) }
        : undefined
    try {
      setSending(true)
      setError('')
      const response = await apiRequest<{ message: MessageItem }>(`/api/conversations/${encodeURIComponent(selectedId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          contentType: composeType,
          ...(draft.trim() ? { text: draft.trim() } : {}),
          ...(mediaUrl.trim() ? { mediaUrl: mediaUrl.trim() } : {}),
          ...(metadata ? { metadata } : {}),
          ...(replyTarget ? { replyToId: replyTarget.id } : {}),
        }),
      })
      setMessages((current) => current.some((message) => message.id === response.message.id) ? current : [...current, response.message])
      setDraft('')
      setMediaUrl('')
      setContactName('')
      setContactPhone('')
      setLocationLabel('')
      setLatitude('')
      setLongitude('')
      setReplyTarget(null)
      await loadConversations()
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'Unable to send message.')
    } finally {
      setSending(false)
    }
  }

  const searchMessages = async (event: FormEvent) => {
    event.preventDefault()
    if (messageSearch.trim().length < 2) return
    try {
      setError('')
      const response = await apiRequest<{ messages: MessageItem[] }>(`/api/messages/search?q=${encodeURIComponent(messageSearch.trim())}${selectedId ? `&conversationId=${encodeURIComponent(selectedId)}` : ''}`)
      setSearchResults(response.messages)
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : 'Unable to search messages.')
    }
  }

  const toggleMedia = async () => {
    const next = !showMedia
    setShowMedia(next)
    if (!next || !selectedId) return
    try {
      const response = await apiRequest<{ media: MessageItem[] }>(`/api/conversations/${encodeURIComponent(selectedId)}/media`)
      setMedia(response.media)
    } catch (mediaError) {
      setError(mediaError instanceof Error ? mediaError.message : 'Unable to load chat media.')
    }
  }

  const updatePreference = async (key: 'pinned' | 'archived' | 'starred' | 'mutedUntil') => {
    if (!activeConversation) return
    const currentlyEnabled = key === 'pinned' ? Boolean(activeConversation.pinnedAt)
      : key === 'archived' ? Boolean(activeConversation.archivedAt)
        : key === 'starred' ? Boolean(activeConversation.starredAt)
          : Boolean(activeConversation.mutedUntil && new Date(activeConversation.mutedUntil).getTime() > Date.now())
    const value = key === 'mutedUntil' ? (currentlyEnabled ? null : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()) : !currentlyEnabled
    try {
      await apiRequest(`/api/conversations/${encodeURIComponent(activeConversation.id)}/preferences`, { method: 'PATCH', body: JSON.stringify({ [key]: value }) })
      await loadConversations()
    } catch (preferenceError) {
      setError(preferenceError instanceof Error ? preferenceError.message : 'Unable to update conversation settings.')
    }
  }

  const toggleReaction = async (message: MessageItem) => {
    try {
      const response = await apiRequest<{ reactions: MessageReaction[] }>(`/api/messages/${encodeURIComponent(message.id)}/reactions`, { method: 'POST', body: JSON.stringify({ type: 'LIKE' }) })
      setMessages((current) => current.map((item) => item.id === message.id ? { ...item, reactions: response.reactions } : item))
    } catch (reactionError) {
      setError(reactionError instanceof Error ? reactionError.message : 'Unable to react to this message.')
    }
  }

  const reportMessage = async (message: MessageItem) => {
    const reason = window.prompt('Why are you reporting this message?')
    if (!reason || reason.trim().length < 4) return
    try {
      await apiRequest(`/api/messages/${encodeURIComponent(message.id)}/report`, { method: 'POST', body: JSON.stringify({ category: 'OTHER', reason: reason.trim() }) })
      setError('Message report submitted for review.')
    } catch (reportError) {
      setError(reportError instanceof Error ? reportError.message : 'Unable to report this message.')
    }
  }

  const deleteMessage = async (message: MessageItem) => {
    if (!window.confirm('Delete this message?')) return
    try {
      const response = await apiRequest<{ message: MessageItem }>(`/api/messages/${encodeURIComponent(message.id)}`, { method: 'DELETE' })
      setMessages((current) => current.map((item) => item.id === message.id ? response.message : item))
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Unable to delete this message.')
    }
  }

  const saveMessageEdit = async (message: MessageItem) => {
    try {
      const response = await apiRequest<{ message: MessageItem }>(`/api/messages/${encodeURIComponent(message.id)}`, { method: 'PATCH', body: JSON.stringify({ text: editDraft.trim() }) })
      setMessages((current) => current.map((item) => item.id === message.id ? response.message : item))
      setEditingId('')
    } catch (editError) {
      setError(editError instanceof Error ? editError.message : 'Unable to edit this message.')
    }
  }

  const forwardMessage = async (message: MessageItem) => {
    if (!forwardTargetId) return
    try {
      await apiRequest(`/api/messages/${encodeURIComponent(message.id)}/forward`, { method: 'POST', body: JSON.stringify({ conversationId: forwardTargetId }) })
      setForwardingId('')
      setForwardTargetId('')
      setError('Message forwarded.')
      await loadConversations()
    } catch (forwardError) {
      setError(forwardError instanceof Error ? forwardError.message : 'Unable to forward this message.')
    }
  }

  return (
    <div className="p-4 sm:p-6">
      <div className="mx-auto grid max-w-6xl overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm lg:grid-cols-[340px_minmax(0,1fr)]">
        <aside className="border-b border-slate-200 bg-slate-50 p-4 lg:border-b-0 lg:border-r">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-xl font-semibold text-slate-900">Messages</h2>
            <Button variant="secondary" size="sm" onClick={() => void openNewConversation()}>New</Button>
          </div>

          {showNew ? (
            <div className="mt-3 rounded-2xl border border-slate-200 bg-white p-3">
              <div className="flex gap-2">
                <Button variant={!isGroup ? 'primary' : 'secondary'} size="sm" onClick={() => setIsGroup(false)}>Direct</Button>
                <Button variant={isGroup ? 'primary' : 'secondary'} size="sm" onClick={() => setIsGroup(true)}>Group</Button>
              </div>
              <p className="mt-3 text-xs font-semibold uppercase text-slate-500">{isGroup ? 'Choose group members' : 'Start a conversation'}</p>
              {isGroup ? <input aria-label="Group name" value={groupName} onChange={(event) => setGroupName(event.target.value)} placeholder="Group name (optional)" className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" /> : null}
              {directoryError ? <p role="alert" className="mt-2 text-xs text-rose-700">{directoryError}</p> : null}
              <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
                {directory.map((directoryUser) => (
                  <label key={directoryUser.id} className="flex cursor-pointer items-center gap-2 rounded-xl px-2 py-2 hover:bg-slate-100">
                    {isGroup ? <input type="checkbox" checked={selectedParticipants.includes(directoryUser.id)} onChange={(event) => setSelectedParticipants((current) => event.target.checked ? [...current, directoryUser.id] : current.filter((id) => id !== directoryUser.id))} /> : null}
                    <span className="min-w-0 flex-1 text-sm font-medium text-slate-900">{directoryUser.name}</span>
                    {!isGroup ? <button type="button" onClick={() => void createConversation(directoryUser.id)} className="text-xs font-semibold text-indigo-700">Open</button> : null}
                  </label>
                ))}
              </div>
              {isGroup ? <Button variant="primary" size="sm" className="mt-2 w-full" disabled={!selectedParticipants.length} onClick={() => void createConversation()}>Create group</Button> : null}
            </div>
          ) : null}

          <label className="mt-4 flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-500 shadow-sm">
            <Search className="h-4 w-4" aria-hidden="true" />
            <input aria-label="Search conversations" placeholder="Search conversations" value={search} onChange={(event) => setSearch(event.target.value)} className="w-full border-0 bg-transparent text-slate-800 placeholder:text-slate-400 focus:outline-none" />
          </label>
          <button type="button" onClick={() => setShowArchived((current) => !current)} className="mt-3 inline-flex items-center gap-2 text-xs font-medium text-slate-600"><Archive className="h-4 w-4" aria-hidden="true" />{showArchived ? 'Hide archived' : 'Show archived'}</button>

          <div className="mt-3 space-y-2">
            {loading ? <div className="rounded-2xl border border-slate-200 bg-white p-3 text-sm text-slate-500">Loading conversations…</div> : null}
            {!loading && conversations.length === 0 ? <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-3 text-sm text-slate-500">No conversations yet.</div> : null}
            {!loading && conversations.length > 0 && visibleConversations.length === 0 ? <div className="rounded-2xl bg-white p-3 text-sm text-slate-500">No matching conversations.</div> : null}
            {visibleConversations.map((conversation) => {
              const lastMessage = conversation.lastMessage ?? null
              const peer = conversation.participants.find((participant) => participant.userId !== user?.id)?.user
              const title = conversation.name ?? peer?.name ?? 'Group conversation'
              return (
                <button key={conversation.id} type="button" onClick={() => { setSelectedId(conversation.id); setSearchResults(null) }} className={`flex w-full items-center gap-3 rounded-[20px] p-3 text-left transition ${selectedId === conversation.id ? 'bg-indigo-50 ring-1 ring-indigo-100' : 'hover:bg-slate-100'}`}>
                  <Avatar src={`https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(title)}`} alt={title} size="md" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-slate-900">{title}</span>
                      {conversation.pinnedAt ? <Pin className="h-3.5 w-3.5 shrink-0 text-indigo-600" aria-label="Pinned" /> : null}
                    </span>
                    <span className="block truncate text-xs text-slate-500">{lastMessage?.text ?? conversation.lastMessagePreview ?? 'Start the conversation'}</span>
                  </span>
                  {lastMessage && lastMessage.senderId !== user?.id && !lastMessage.readAt ? <span className="flex h-5 w-5 items-center justify-center rounded-full bg-indigo-600 text-[10px] font-semibold text-white">1</span> : null}
                </button>
              )
            })}
          </div>
        </aside>

        <section className="flex min-h-[600px] min-w-0 flex-col bg-white p-4">
          {error ? <div className="mb-3 rounded-2xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700" role="alert">{error}</div> : null}
          {activeConversation ? (
            <>
              <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar src={`https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(activeConversation.name ?? activePeer?.name ?? 'Group')}`} alt={activeConversation.name ?? activePeer?.name ?? 'Group'} size="md" />
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-slate-900">{activeConversation.name ?? activePeer?.name ?? 'Group conversation'}</p>
                    {activePeer ? <Link to={`/profile/${encodeURIComponent(activePeer.id)}`} className="text-xs text-indigo-700">View profile</Link> : <p className="text-xs text-slate-500">{activeConversation.participants.length} members</p>}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <button type="button" title="Pin conversation" aria-label="Pin conversation" onClick={() => void updatePreference('pinned')} className={`rounded-lg p-2 ${activeConversation.pinnedAt ? 'text-indigo-700' : 'text-slate-500 hover:bg-slate-100'}`}><Pin className="h-4 w-4" /></button>
                  <button type="button" title="Star conversation" aria-label="Star conversation" onClick={() => void updatePreference('starred')} className={`rounded-lg p-2 ${activeConversation.starredAt ? 'text-amber-600' : 'text-slate-500 hover:bg-slate-100'}`}><Star className="h-4 w-4" /></button>
                  <button type="button" title="Mute for 24 hours" aria-label="Mute conversation" onClick={() => void updatePreference('mutedUntil')} className={`rounded-lg p-2 ${activeConversation.mutedUntil && new Date(activeConversation.mutedUntil).getTime() > Date.now() ? 'text-indigo-700' : 'text-slate-500 hover:bg-slate-100'}`}><VolumeX className="h-4 w-4" /></button>
                  <button type="button" title="Archive conversation" aria-label="Archive conversation" onClick={() => void updatePreference('archived')} className={`rounded-lg p-2 ${activeConversation.archivedAt ? 'text-indigo-700' : 'text-slate-500 hover:bg-slate-100'}`}><Archive className="h-4 w-4" /></button>
                  <button type="button" title="Shared media" aria-label="Shared media" onClick={() => void toggleMedia()} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><Image className="h-4 w-4" /></button>
                </div>
              </header>

              {showMedia ? <div className="mt-3 grid grid-cols-2 gap-2 rounded-xl bg-slate-50 p-3 sm:grid-cols-3">{media.length ? media.map((item) => item.mediaUrl ? <a key={item.id} href={item.mediaUrl} target="_blank" rel="noreferrer" className="min-w-0 overflow-hidden rounded-lg bg-white text-xs text-indigo-700">{item.contentType === 'IMAGE' ? <img src={item.mediaUrl} alt="Shared image" className="aspect-square w-full object-cover" /> : <span className="block truncate p-2">{item.contentType}: {item.mediaUrl}</span>}</a> : null) : <p className="text-xs text-slate-500">No shared media.</p>}</div> : null}
              <form onSubmit={(event) => void searchMessages(event)} className="mt-3 flex gap-2">
                <input aria-label="Search messages" value={messageSearch} onChange={(event) => setMessageSearch(event.target.value)} placeholder="Search messages in this chat" minLength={2} className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none" />
                <Button type="submit" variant="secondary" size="sm" disabled={messageSearch.trim().length < 2} icon={<Search className="h-4 w-4" aria-hidden="true" />}>Search</Button>
                {searchResults ? <Button type="button" variant="ghost" size="sm" onClick={() => setSearchResults(null)}>Clear</Button> : null}
              </form>

              <div className="mt-4 min-h-0 flex-1 space-y-4 overflow-y-auto">
                {hasMore && !searchResults ? <Button variant="secondary" size="sm" onClick={() => void loadOlderMessages()} disabled={loadingOlder}>{loadingOlder ? 'Loading…' : 'Load older messages'}</Button> : null}
                {messagesLoading ? <div className="rounded-2xl bg-slate-50 p-3 text-sm text-slate-500">Loading messages…</div> : null}
                {!messagesLoading && searchResults && searchResults.length === 0 ? <p className="text-center text-sm text-slate-500">No matching messages.</p> : null}
                {!messagesLoading && !searchResults && messages.length === 0 ? <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">No messages yet. Start the conversation.</div> : null}
                {(searchResults ?? messages).map((message) => {
                  const isOwn = message.senderId === user?.id
                  const reply = message.replyToId ? messages.find((item) => item.id === message.replyToId) : null
                  return (
                    <div key={message.id} className={`flex ${isOwn ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[min(90%,32rem)] rounded-2xl px-4 py-3 text-sm ${isOwn ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-700'}`}>
                        {message.forwardedFromId ? <p className={`mb-1 text-[10px] ${isOwn ? 'text-indigo-100' : 'text-slate-500'}`}>Forwarded</p> : null}
                        {reply ? <p className={`mb-2 border-l-2 pl-2 text-xs ${isOwn ? 'border-indigo-200 text-indigo-100' : 'border-indigo-400 text-slate-500'}`}>{reply.text}</p> : null}
                        {message.contentType === 'IMAGE' && message.mediaUrl ? <a href={message.mediaUrl} target="_blank" rel="noreferrer"><img src={message.mediaUrl} alt="Message attachment" className="mb-2 max-h-64 rounded-xl object-cover" /></a> : null}
                        {message.contentType === 'VIDEO' && message.mediaUrl ? <video controls src={message.mediaUrl} className="mb-2 max-h-64 rounded-xl" /> : null}
                        {message.text ? <p className="whitespace-pre-wrap">{message.text}</p> : null}
                        {message.contentType === 'CONTACT' && message.metadata ? <p>{String(message.metadata.name ?? 'Contact')} · {String(message.metadata.phone ?? '')}</p> : null}
                        {message.contentType === 'LOCATION' && message.metadata ? <p>{String(message.metadata.label ?? 'Location')} · {String(message.metadata.latitude)}, {String(message.metadata.longitude)}</p> : null}
                        {['DOCUMENT', 'VOICE'].includes(message.contentType ?? '') && message.mediaUrl ? <a href={message.mediaUrl} target="_blank" rel="noreferrer" className={`underline ${isOwn ? 'text-white' : 'text-indigo-700'}`}>Open {message.contentType?.toLowerCase()}</a> : null}
                        <div className={`mt-1 flex items-center gap-1 text-[10px] ${isOwn ? 'text-indigo-100' : 'text-slate-500'}`}>
                          <span>{new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                          {message.editedAt ? <span>· edited</span> : null}
                          {isOwn ? <span>· {message.readAt ? 'Read' : 'Sent'}</span> : null}
                        </div>
                        {message.reactions?.length ? <p className={`mt-1 text-xs ${isOwn ? 'text-indigo-100' : 'text-slate-500'}`}>{message.reactions.map((reaction) => reaction.type).join(' ')}</p> : null}
                        {!message.deletedAt ? <div className={`mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] ${isOwn ? 'text-indigo-100' : 'text-slate-500'}`}>
                          <button type="button" onClick={() => setReplyTarget(message)} className="hover:underline">Reply</button>
                          <button type="button" onClick={() => void toggleReaction(message)} className="hover:underline">React</button>
                          <button type="button" onClick={() => { setForwardingId(forwardingId === message.id ? '' : message.id); setForwardTargetId('') }} className="hover:underline">Forward</button>
                          {!isOwn ? <button type="button" onClick={() => void reportMessage(message)} className="hover:underline">Report</button> : null}
                          {isOwn && message.contentType === 'TEXT' ? <button type="button" onClick={() => { setEditingId(message.id); setEditDraft(message.text) }} className="hover:underline">Edit</button> : null}
                          {isOwn ? <button type="button" onClick={() => void deleteMessage(message)} className="hover:underline">Delete</button> : null}
                        </div> : null}
                        {editingId === message.id ? <div className="mt-2 flex gap-2"><input value={editDraft} onChange={(event) => setEditDraft(event.target.value)} className="min-w-0 flex-1 rounded-lg px-2 py-1 text-slate-900" /><button type="button" onClick={() => void saveMessageEdit(message)} className="font-semibold">Save</button><button type="button" onClick={() => setEditingId('')}>Cancel</button></div> : null}
                        {forwardingId === message.id ? <div className="mt-2 flex gap-2"><select aria-label="Forward to conversation" value={forwardTargetId} onChange={(event) => setForwardTargetId(event.target.value)} className="min-w-0 flex-1 rounded-lg px-2 py-1 text-slate-900"><option value="">Choose chat</option>{conversations.filter((item) => item.id !== selectedId).map((item) => <option key={item.id} value={item.id}>{item.name ?? item.participants.find((participant) => participant.userId !== user?.id)?.user?.name ?? 'Group chat'}</option>)}</select><button type="button" disabled={!forwardTargetId} onClick={() => void forwardMessage(message)} className="font-semibold disabled:opacity-50">Send</button></div> : null}
                      </div>
                    </div>
                  )
                })}
              </div>

              <form onSubmit={(event) => void handleSendMessage(event)} className="mt-4 rounded-[24px] border border-slate-200 bg-slate-50 p-3">
                {replyTarget ? <div className="mb-2 flex items-center justify-between rounded-xl bg-white px-3 py-2 text-xs text-slate-600"><span className="truncate">Replying to: {replyTarget.text || replyTarget.contentType}</span><button type="button" onClick={() => setReplyTarget(null)} aria-label="Cancel reply">×</button></div> : null}
                <div className="flex flex-wrap gap-2">
                  <select aria-label="Message type" value={composeType} onChange={(event) => setComposeType(event.target.value)} className="rounded-xl border border-slate-200 bg-white px-2 py-2 text-xs text-slate-700">
                    {['TEXT', 'IMAGE', 'VIDEO', 'DOCUMENT', 'VOICE', 'CONTACT', 'LOCATION'].map((type) => <option key={type} value={type}>{type[0] + type.slice(1).toLowerCase()}</option>)}
                  </select>
                  {['IMAGE', 'VIDEO', 'DOCUMENT', 'VOICE'].includes(composeType) ? <input type="url" aria-label="Attachment URL" value={mediaUrl} onChange={(event) => setMediaUrl(event.target.value)} placeholder="Attachment URL" className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm" /> : null}
                  {composeType === 'CONTACT' ? <><input aria-label="Contact name" value={contactName} onChange={(event) => setContactName(event.target.value)} placeholder="Contact name" className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm" /><input aria-label="Contact phone" value={contactPhone} onChange={(event) => setContactPhone(event.target.value)} placeholder="Phone number" className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm" /></> : null}
                  {composeType === 'LOCATION' ? <><input aria-label="Location label" value={locationLabel} onChange={(event) => setLocationLabel(event.target.value)} placeholder="Place name" className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm" /><input aria-label="Latitude" type="number" step="any" value={latitude} onChange={(event) => setLatitude(event.target.value)} placeholder="Latitude" className="w-28 rounded-xl border border-slate-200 px-3 py-2 text-sm" /><input aria-label="Longitude" type="number" step="any" value={longitude} onChange={(event) => setLongitude(event.target.value)} placeholder="Longitude" className="w-28 rounded-xl border border-slate-200 px-3 py-2 text-sm" /></> : null}
                </div>
                <div className="mt-2 flex items-center gap-3">
                  <input aria-label="Type message" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && composeType === 'TEXT') { event.preventDefault(); void handleSendMessage() } }} placeholder={composeType === 'TEXT' ? 'Write a message…' : 'Optional message'} className="min-w-0 flex-1 border-0 bg-transparent text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none" />
                  <Button type="submit" variant="primary" size="sm" disabled={sending || !canSend} icon={<SendHorizontal className="h-4 w-4" aria-hidden="true" />}>{sending ? 'Sending…' : 'Send'}</Button>
                </div>
              </form>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center p-6"><EmptyState title="No conversation selected" description="Choose a conversation or start a new one." /></div>
          )}
        </section>
      </div>
    </div>
  )
}