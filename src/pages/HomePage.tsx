import { ArrowRight, MessageCircle, Phone, Plus, RefreshCw, UsersRound } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { Avatar } from '../components/ui/Avatar'
import { PostCard } from '../components/PostCard'
import { useAuth } from '../context/AuthContext'
import { apiRequest } from '../lib/api'
import type { Post } from '../types'

function toPost(record: any): Post {
  return {
    id: record.id,
    author: { id: record.author.id, name: record.author.name, handle: record.author.handle, avatar: record.author.avatar },
    time: new Date(record.createdAt).toLocaleString(),
    content: record.content,
    image: record.imageUrl ?? undefined,
    likes: record.likes ?? 0,
    comments: record.comments ?? 0,
    shares: record.shares ?? 0,
    saved: record.saved ?? 0,
    savedByCurrentUser: record.savedByCurrentUser ?? false,
    visibility: record.visibility ?? 'PUBLIC',
    currentUserReaction: record.currentUserReaction ?? null,
    authorFollowing: record.authorFollowing ?? false,
  }
}

export function HomePage() {
  const { user } = useAuth()
  const [posts, setPosts] = useState<Post[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const loadFeed = async () => {
    setLoading(true)
    setError('')
    try {
      const response = await apiRequest<{ posts: any[] }>('/api/posts?limit=50')
      setPosts(response.posts.map(toPost))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load your feed.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void loadFeed() }, [])

  return (
    <div className="mx-auto grid max-w-7xl gap-6 p-4 sm:p-6 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="space-y-6">
        <section className="relative overflow-hidden rounded-[28px] bg-gradient-to-br from-[#10214f] via-blue-800 to-indigo-700 p-5 text-white shadow-xl shadow-blue-950/15 sm:p-7">
          <div aria-hidden="true" className="absolute -right-12 -top-20 h-64 w-64 rounded-full bg-sky-400/20 blur-3xl" />
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-sky-200">Your people. Your moments.</p>
              <h2 className="mt-2 text-2xl font-semibold sm:text-3xl">Welcome back, {user?.name.split(' ')[0]}.</h2>
              <p className="mt-2 max-w-xl text-sm text-blue-100">
                Catch up with your community and share what matters to you.
              </p>
            </div>
            <Link to="/explore" className="relative inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-blue-800 shadow-sm hover:bg-blue-50">
              Find people <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
        </section>

        <section className="rounded-[24px] border border-blue-100 bg-white p-4 shadow-sm sm:p-5">
          <Link to="/create" className="flex items-center gap-3">
            <Avatar src={`https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(user?.name ?? 'NOVAKOKO')}`} alt={user?.name ?? 'NOVAKOKO'} size="md" />
            <div className="min-w-0 flex-1 rounded-full border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-slate-500 transition hover:bg-blue-50">
              Share something with your community…
            </div>
            <span className="hidden items-center gap-2 rounded-full bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white sm:inline-flex"><Plus className="h-4 w-4" aria-hidden="true" />Post</span>
          </Link>
        </section>

        <nav aria-label="Social shortcuts" className="grid grid-cols-3 gap-2 sm:gap-3">
          <Link to="/messages" className="flex items-center justify-center gap-2 rounded-2xl border border-blue-100 bg-white px-2 py-3 text-xs font-semibold text-blue-800 shadow-sm transition hover:bg-blue-50 sm:text-sm">
            <MessageCircle className="h-4 w-4" aria-hidden="true" />Messages
          </Link>
          <Link to="/communities" className="flex items-center justify-center gap-2 rounded-2xl border border-blue-100 bg-white px-2 py-3 text-xs font-semibold text-blue-800 shadow-sm transition hover:bg-blue-50 sm:text-sm">
            <UsersRound className="h-4 w-4" aria-hidden="true" />Groups
          </Link>
          <Link to="/calls" className="flex items-center justify-center gap-2 rounded-2xl border border-blue-100 bg-white px-2 py-3 text-xs font-semibold text-blue-800 shadow-sm transition hover:bg-blue-50 sm:text-sm">
            <Phone className="h-4 w-4" aria-hidden="true" />Calls
          </Link>
        </nav>

        <div className="space-y-5">
          <div className="flex justify-end">
            <button type="button" onClick={() => void loadFeed()} disabled={loading} className="inline-flex items-center gap-2 rounded-xl border border-blue-100 bg-white px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50">
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Refresh feed
            </button>
          </div>
          {error ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700"><span>{error}</span><button type="button" onClick={() => void loadFeed()} className="font-semibold underline">Retry</button></div> : null}
          {loading ? <div className="rounded-2xl border border-blue-100 bg-white p-6 text-sm text-slate-500">Loading your feed…</div> : null}
          {!loading && !error && posts.length === 0 ? <div className="rounded-2xl border border-dashed border-blue-200 bg-white p-8 text-center"><p className="font-semibold text-slate-800">Your feed starts here</p><p className="mt-1 text-sm text-slate-500">Share a post or find people to follow.</p><Link to="/create" className="mt-4 inline-flex items-center gap-2 rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold text-white">Create a post <Plus className="h-4 w-4" /></Link></div> : null}
          {posts.map((post) => (
            <PostCard key={post.id} post={post} onDeleted={(postId) => setPosts((current) => current.filter((item) => item.id !== postId))} />
          ))}
        </div>
      </div>

      <aside className="space-y-6">
        <section className="rounded-[24px] border border-blue-100 bg-gradient-to-br from-blue-50 to-indigo-50 p-5">
          <p className="font-semibold text-blue-950">Find your people</p>
          <p className="mt-2 text-sm leading-6 text-slate-600">Discover members and communities, then join the conversations that matter to you.</p>
          <Link to="/explore" className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-blue-700">Explore NOVAKOKO <ArrowRight className="h-4 w-4" aria-hidden="true" /></Link>
        </section>
        <section className="rounded-[24px] border border-slate-200 bg-white p-5">
          <p className="font-semibold text-slate-900">A thoughtful community</p>
          <p className="mt-2 text-sm leading-6 text-slate-600">Keep interactions respectful. Posts and comments are subject to NOVAKOKO moderation.</p>
        </section>
      </aside>
    </div>
  )
}
