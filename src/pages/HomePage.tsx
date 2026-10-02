import { ArrowRight, Plus, RefreshCw } from 'lucide-react'
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
    <div className="grid gap-6 p-4 sm:p-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-6">
        <section className="rounded-[28px] border border-violet-100 bg-gradient-to-r from-violet-600 via-indigo-600 to-cyan-500 p-5 text-white shadow-lg shadow-violet-200 sm:p-6">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.28em] text-violet-100">Good morning</p>
              <h2 className="mt-2 text-2xl font-semibold sm:text-3xl">Welcome back, {user?.name.split(' ')[0]}.</h2>
              <p className="mt-2 max-w-xl text-sm text-violet-100">
                See what your NOVAKOKO community is sharing today.
              </p>
            </div>
            <Link to="/explore">
              <Link to="/explore" className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-50">
                Find people <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </Link>
          </div>
        </section>

        <section className="rounded-[28px] border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
          <Link to="/create" className="flex items-start gap-3">
            <Avatar src={`https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(user?.name ?? 'NOVAKOKO')}`} alt={user?.name ?? 'NOVAKOKO'} size="md" />
            <div className="flex-1 rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-3 text-sm font-medium text-slate-500">
              <p className="text-sm font-medium text-slate-500">Share something with your community…</p>
            </div>
            <span className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-3 py-2 text-sm font-semibold text-white"><Plus className="h-4 w-4" aria-hidden="true" />Create</span>
          </Link>
        </section>

        <div className="space-y-5">
          <div className="flex justify-end">
            <button type="button" onClick={() => void loadFeed()} disabled={loading} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Refresh feed
            </button>
          </div>
          {error ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700"><span>{error}</span><button type="button" onClick={() => void loadFeed()} className="font-semibold underline">Retry</button></div> : null}
          {loading ? <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500">Loading your feed…</div> : null}
          {!loading && !error && posts.length === 0 ? <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-6 text-center text-sm text-slate-500">No posts yet. Start the conversation.</div> : null}
          {posts.map((post) => (
            <PostCard key={post.id} post={post} onDeleted={(postId) => setPosts((current) => current.filter((item) => item.id !== postId))} />
          ))}
        </div>
      </div>

      <aside className="space-y-6">
        <section className="rounded-[28px] border border-violet-100 bg-violet-50 p-4">
          <p className="font-semibold text-violet-900">A thoughtful community</p>
          <p className="mt-2 text-sm leading-6 text-slate-600">Keep interactions respectful. Posts and comments are subject to NOVAKOKO moderation.</p>
          <Link to="/explore" className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-indigo-700">Discover people <ArrowRight className="h-4 w-4" aria-hidden="true" /></Link>
        </section>
      </aside>
    </div>
  )
}
