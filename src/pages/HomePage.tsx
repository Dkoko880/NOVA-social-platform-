import { ArrowRight, Plus } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { PostCard } from '../components/PostCard'
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
    <div className="min-h-[calc(100dvh-1px)] w-full bg-slate-100">
      <div className="mx-auto w-full max-w-7xl px-2 py-3 sm:px-4 lg:px-6">
        {/* Facebook-style quick navigation */}
        <div className="mb-3 flex w-full gap-2 overflow-x-auto pb-1">
          <Link to="/" className="shrink-0 rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold text-white">
            Home
          </Link>
          <Link to="/explore" className="shrink-0 rounded-full bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm">
            Explore
          </Link>
          <Link to="/messages" className="shrink-0 rounded-full bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm">
            Messages
          </Link>
          <Link to="/communities?type=GROUP" className="shrink-0 rounded-full bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm">
            Groups
          </Link>
          <Link to="/communities?type=CHANNEL" className="shrink-0 rounded-full bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm">
            Channels
          </Link>
          <Link to="/calls" className="shrink-0 rounded-full bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm">
            Calls
          </Link>
          <Link to="/notifications" className="shrink-0 rounded-full bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm">
            Notifications
          </Link>
        </div>

        {/* Stories / highlights */}
        <section className="mb-3 overflow-hidden rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="font-bold text-slate-900">Stories</h2>
              <p className="text-xs text-slate-500">Share a moment with your community</p>
            </div>
            <Link to="/create" className="text-sm font-semibold text-blue-700">
              Create
            </Link>
          </div>

          <div className="flex gap-3 overflow-x-auto pb-1">
            <Link
              to="/create"
              className="flex h-28 w-20 shrink-0 flex-col items-center justify-center rounded-2xl bg-gradient-to-b from-blue-600 to-indigo-700 text-center text-white"
            >
              <Plus className="h-6 w-6" aria-hidden="true" />
              <span className="mt-2 text-xs font-semibold">Add story</span>
            </Link>

            {['Your friends', 'Creators', 'Communities', 'Trending'].map((label) => (
              <Link
                key={label}
                to="/explore"
                className="flex h-28 w-20 shrink-0 flex-col justify-end rounded-2xl bg-gradient-to-b from-indigo-500 via-blue-600 to-slate-900 p-2 text-white"
              >
                <span className="text-xs font-semibold">{label}</span>
              </Link>
            ))}
          </div>
        </section>

        <div className="grid w-full gap-4 lg:grid-cols-[240px_minmax(0,1fr)_260px]">
          {/* Left Facebook-style shortcuts */}
          <aside className="hidden lg:block">
            <div className="sticky top-3 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
              <h3 className="mb-3 px-2 text-sm font-bold text-slate-900">Shortcuts</h3>

              <div className="space-y-1">
                <Link to="/profile" className="block rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-blue-50">
                  My Profile
                </Link>
                <Link to="/explore" className="block rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-blue-50">
                  Find People
                </Link>
                <Link to="/communities?type=GROUP" className="block rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-blue-50">
                  Groups
                </Link>
                <Link to="/communities?type=COMMUNITY" className="block rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-blue-50">
                  Communities
                </Link>
                <Link to="/communities?type=CHANNEL" className="block rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-blue-50">
                  Channels
                </Link>
                <Link to="/calls" className="block rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-blue-50">
                  Calls
                </Link>
                <Link to="/notifications" className="block rounded-xl px-3 py-2 text-sm font-medium text-slate-700 hover:bg-blue-50">
                  Notifications
                </Link>
              </div>
            </div>
          </aside>

          {/* Main feed */}
          <main className="min-w-0">
            <div className="mb-3 rounded-2xl bg-white p-3 shadow-sm ring-1 ring-slate-200">
              <div className="flex items-center gap-3">
                <Link
                  to="/create"
                  className="flex min-w-0 flex-1 items-center rounded-full bg-slate-100 px-4 py-3 text-sm text-slate-500 hover:bg-slate-200"
                >
                  What&apos;s on your mind?
                </Link>
                <Link
                  to="/create"
                  className="hidden shrink-0 rounded-full bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white sm:inline-flex"
                >
                  <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
                  Post
                </Link>
              </div>

              <div className="mt-3 grid grid-cols-3 border-t border-slate-100 pt-3">
                <Link to="/create" className="py-2 text-center text-xs font-semibold text-slate-600 hover:bg-slate-50">
                  Photo / Video
                </Link>
                <Link to="/live" className="py-2 text-center text-xs font-semibold text-slate-600 hover:bg-slate-50">
                  Live
                </Link>
                <Link to="/create" className="py-2 text-center text-xs font-semibold text-slate-600 hover:bg-slate-50">
                  Create Post
                </Link>
              </div>
            </div>

            <div className="mb-3 flex items-center justify-between">
              <div>
                <h1 className="text-lg font-bold text-slate-900">Your Feed</h1>
                <p className="text-xs text-slate-500">Posts from people and communities you follow</p>
              </div>
              <button
                type="button"
                onClick={() => void loadFeed()}
                disabled={loading}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-blue-50 disabled:opacity-50"
              >
                {loading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>

            {error ? (
              <div className="mb-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span>{error}</span>
                  <button type="button" onClick={() => void loadFeed()} className="font-semibold underline">
                    Retry
                  </button>
                </div>
              </div>
            ) : null}

            {!loading && !error && posts.length === 0 ? (
              <div className="rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-200">
                <p className="font-semibold text-slate-800">Your feed starts here</p>
                <p className="mt-1 text-sm text-slate-500">Create your first post or discover people to follow.</p>
                <Link to="/create" className="mt-4 inline-flex items-center gap-2 rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold text-white">
                  Create a post
                  <Plus className="h-4 w-4" aria-hidden="true" />
                </Link>
              </div>
            ) : null}

            <div className="space-y-3">
              {posts.map((post) => (
                <PostCard
                  key={post.id}
                  post={post}
                  onDeleted={(postId) => setPosts((current) => current.filter((item) => item.id !== postId))}
                />
              ))}
            </div>
          </main>

          {/* Right discovery panel */}
          <aside className="hidden lg:block">
            <div className="sticky top-3 space-y-3">
              <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
                <h3 className="font-bold text-slate-900">Discover</h3>
                <div className="mt-3 space-y-2">
                  <Link to="/explore" className="block rounded-xl bg-slate-50 p-3 hover:bg-blue-50">
                    <p className="text-sm font-semibold text-blue-700">Explore people</p>
                    <p className="mt-1 text-xs text-slate-500">Find people and creators to follow.</p>
                  </Link>
                  <Link to="/communities?type=GROUP" className="block rounded-xl bg-slate-50 p-3 hover:bg-blue-50">
                    <p className="text-sm font-semibold text-blue-700">Groups</p>
                    <p className="mt-1 text-xs text-slate-500">Join conversations around shared interests.</p>
                  </Link>
                  <Link to="/live" className="block rounded-xl bg-slate-50 p-3 hover:bg-blue-50">
                    <p className="text-sm font-semibold text-blue-700">Live</p>
                    <p className="mt-1 text-xs text-slate-500">Discover live conversations and broadcasts.</p>
                  </Link>
                </div>
              </div>

              <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-slate-200">
                <h3 className="font-bold text-slate-900">NOVAKOKO</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  Connect • Chat • Share • Live • Grow
                </p>
                <Link to="/explore" className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-blue-700">
                  Explore NOVAKOKO
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}
