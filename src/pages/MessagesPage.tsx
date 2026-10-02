import { Search, SendHorizonal } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Avatar } from '../components/ui/Avatar'
import { Button } from '../components/ui/Button'
import { EmptyState } from '../components/ui/EmptyState'
import { useAuth } from '../context/AuthContext'
import { apiRequest, API_BASE_URL } from '../lib/api'

type ConversationListItem = {
  id: string
  name: string | null
  participants: Array<{ userId: string; role?: string; user?: { id: string; name: string } }>
  lastMessagePreview: string | null
  updatedAt: string
  lastMessageAt: string | null
  lastMessage?: { id: string; senderId: string; text: string; createdAt: string; readAt?: string | null; status?: string }
}

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
  const [showNew, setShowNew] = useState(false)
  const [directory, setDirectory] = useState<DirectoryUser[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)

  const loadConversations = async () => {
    try {
      setLoading(true)
      setError('')
      const response = await apiRequest<{ conversations: ConversationListItem[] }>('/api/conversations')
      setConversations(response.conversations)
      if (!selectedId && response.conversations[0]) {
        setSelectedId(response.conversations[0].id)
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load conversations.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadConversations()
  }, [])

  useEffect(() => {
    const source = new EventSource(`${API_BASE_URL}/api/realtime`, { withCredentials: true })
    const onMessage = (event: MessageEvent<string>) => {
      const payload = JSON.parse(event.data) as { conversationId: string; message?: MessageItem }
      if (payload.message && payload.conversationId === selectedId) {
        setMessages((current) => current.some((message) => message.id === payload.message!.id) ? current : [...current, payload.message!])
        void apiRequest(`/api/conversations/${selectedId}/read`, { method: 'POST' })
      }
      void loadConversations()
    }
    const onRead = (event: MessageEvent<string>) => {
      const payload = JSON.parse(event.data) as { conversationId: string; messageId: string; readAt: string }
      setMessages((current) => current.map((message) => message.id === payload.messageId ? { ...message, readAt: payload.readAt, status: 'READ' } : message))
    }
    source.addEventListener('message:new', onMessage)
    source.addEventListener('message:read', onRead)
    source.onerror = () => source.close()
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
        const response = await apiRequest<{ messages: MessageItem[]; hasMore: boolean }>(`/api/conversations/${selectedId}/messages?limit=50`)
        setMessages(response.messages)
        setHasMore(response.hasMore)
        await apiRequest(`/api/conversations/${selectedId}/read`, { method: 'POST' })
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : 'Unable to load messages.')
      } finally {
        setMessagesLoading(false)
      }
    }

    void loadMessages()
  }, [selectedId])

  const loadOlderMessages = async () => {
    if (!selectedId || !messages[0] || loadingOlder) return
    try {
      setLoadingOlder(true)
      const response = await apiRequest<{ messages: MessageItem[]; hasMore: boolean }>(`/api/conversations/${selectedId}/messages?limit=50&before=${encodeURIComponent(messages[0].createdAt)}`)
      setMessages((current) => [...response.messages, ...current])
      setHasMore(response.hasMore)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load older messages.')
    } finally {
      setLoadingOlder(false)
    }
  }

  const openNewConversation = async () => {
    setShowNew((current) => !current)
    if (!directory.length) {
      const response = await apiRequest<{ users: DirectoryUser[] }>('/api/users')
      setDirectory(response.users.filter((directoryUser) => directoryUser.id !== user?.id))
    }
  }

  const createConversation = async (participantId: string) => {
    try {
      const response = await apiRequest<{ conversation: { id: string } }>('/api/conversations', { method: 'POST', body: JSON.stringify({ participantId }) })
      await loadConversations()
      setSelectedId(response.conversation.id)
      setShowNew(false)
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Unable to start conversation.')
    }
  }

  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedId) ?? null,
    [conversations, selectedId],
  )

  const activePeer = useMemo(() => {
    if (!activeConversation) {
      return null
    }

    return activeConversation.participants.find((participant) => participant.userId !== user?.id)?.user ?? null
  }, [activeConversation, user])

  const handleSendMessage = async () => {
    if (!draft.trim() || !selectedId || sending) {
      return
    }

    try {
      setSending(true)
      setError('')
      const response = await apiRequest<{ message: MessageItem }>(`/api/conversations/${selectedId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text: draft.trim() }),
      })

      setMessages((current) => [...current, response.message])
      setDraft('')
      await loadConversations()
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'Unable to send message.')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="p-4 sm:p-6">
      <div className="mx-auto grid max-w-6xl overflow-hidden rounded-[32px] border border-slate-200 bg-white shadow-sm lg:grid-cols-[340px_minmax(0,1fr)]">
        <aside className="border-b border-slate-200 bg-slate-50 p-4 lg:border-b-0 lg:border-r">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-xl font-semibold text-slate-900">Messages</h2>
            <Button variant="secondary" size="sm" onClick={() => void openNewConversation()}>New</Button>
          </div>

          {showNew ? (
            <div className="mt-3 rounded-2xl border border-slate-200 bg-white p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Start a conversation</p>
              <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
                {directory.map((directoryUser) => (
                  <button key={directoryUser.id} type="button" onClick={() => void createConversation(directoryUser.id)} className="w-full rounded-xl px-2 py-2 text-left hover:bg-slate-100">
                    <p className="text-sm font-medium text-slate-900">{directoryUser.name}</p>
                    <p className="text-xs text-slate-500">Open profile</p>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <label className="mt-4 flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-500 shadow-sm">
            <Search className="h-4 w-4" aria-hidden="true" />
            <input
              aria-label="Search conversations"
              placeholder="Search conversations"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="w-full border-0 bg-transparent text-slate-800 placeholder:text-slate-400 focus:outline-none"
            />
          </label>

          <div className="mt-4 space-y-2">
            {loading ? (
              <div className="rounded-2xl border border-slate-200 bg-white p-3 text-sm text-slate-500">Loading conversations…</div>
            ) : conversations.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-3 text-sm text-slate-500">No conversations yet.</div>
            ) : (
              conversations.filter((conversation) => {
                const peer = conversation.participants.find((participant) => participant.userId !== user?.id)?.user
                return `${conversation.name ?? ''} ${peer?.name ?? ''}`.toLowerCase().includes(search.toLowerCase())
              }).map((conversation) => {
                const lastMessage = conversation.lastMessage ?? null
                const peer = conversation.participants.find((participant) => participant.userId !== user?.id)?.user

                return (
                  <button
                    key={conversation.id}
                    type="button"
                    onClick={() => setSelectedId(conversation.id)}
                    className={`flex w-full items-center gap-3 rounded-[20px] p-3 text-left transition ${
                      selectedId === conversation.id ? 'bg-violet-50 ring-1 ring-violet-100' : 'hover:bg-slate-100'
                    }`}
                  >
                    <Avatar src={peer?.name ? `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(peer.name)}` : 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=400&q=80'} alt={peer?.name ?? 'conversation'} size="md" status="online" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate font-medium text-slate-900">{conversation.name ?? peer?.name ?? 'Direct message'}</p>
                        <span className="text-[10px] text-slate-500">{conversation.lastMessageAt ? new Date(conversation.lastMessageAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''}</span>
                      </div>
                      <p className="truncate text-xs text-slate-500">{lastMessage?.text ?? conversation.lastMessagePreview ?? 'Start the conversation'}</p>
                    </div>
                    {lastMessage && lastMessage.senderId !== user?.id && !lastMessage.readAt ? (
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-violet-600 text-[10px] font-semibold text-white">1</span>
                    ) : null}
                  </button>
                )
              })
            )}
          </div>
        </aside>

        <section className="min-h-[500px] bg-white p-4">
          {error ? (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>
          ) : null}

          {activeConversation && activePeer ? (
            <>
              <div className="flex items-center justify-between border-b border-slate-200 pb-4">
                <div className="flex items-center gap-3">
                  <Avatar src={`https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(activePeer.name)}`} alt={activePeer.name} size="md" status="online" />
                  <div>
                    <p className="font-semibold text-slate-900">{activePeer.name}</p>
                  </div>
                </div>
                <Button variant="secondary" size="sm">View profile</Button>
              </div>

              <div className="mt-6 space-y-4">
                {hasMore ? <Button variant="secondary" size="sm" onClick={() => void loadOlderMessages()} disabled={loadingOlder}>{loadingOlder ? 'Loading…' : 'Load older messages'}</Button> : null}
                {messagesLoading ? (
                  <div className="rounded-2xl bg-slate-50 p-3 text-sm text-slate-500">Loading messages…</div>
                ) : messages.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500">No messages yet. Start the conversation.</div>
                ) : (
                  messages.map((message) => {
                    const isOwn = message.senderId === user?.id
                    return (
                      <div key={message.id} className={`flex ${isOwn ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-md rounded-2xl px-4 py-3 text-sm ${isOwn ? 'bg-violet-600 text-white' : 'bg-slate-100 text-slate-700'}`}>
                          <p>{message.text}</p>
                          <div className={`mt-1 text-[10px] ${isOwn ? 'text-violet-100' : 'text-slate-500'}`}>
                            {new Date(message.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                            {isOwn ? ` · ${message.readAt ? 'Read' : 'Sent'}` : ''}
                          </div>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>

              <div className="mt-6 flex items-center gap-3 rounded-[24px] border border-slate-200 bg-slate-50 p-3">
                <input
                  aria-label="Type message"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void handleSendMessage();
                    }
                  }}
                  placeholder="Write a message..."
                  className="flex-1 border-0 bg-transparent text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none"
                />
                <Button variant="primary" size="sm" onClick={() => void handleSendMessage()} disabled={sending || !draft.trim()} icon={<SendHorizonal className="h-4 w-4" aria-hidden="true" />}>
                  {sending ? 'Sending…' : 'Send'}
                </Button>
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center p-6">
              <EmptyState
                title="No conversation selected"
                description="Pick a chat from the list to preview messages and continue the conversation."
              />
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
