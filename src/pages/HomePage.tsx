import { ArrowRight, Clock3, Sparkles, TrendingUp, Users } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { stories, trendingTopics } from '../data/mockData'
import { Button } from '../components/ui/Button'
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
    shares: 0,
    saved: 0,
  }
}

export function HomePage() {
  const { user } = useAuth()
  const [posts, setPosts] = useState<Post[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    void apiRequest<{ posts: any[] }>('/api/posts')
      .then((response) => setPosts(response.posts.map(toPost)))
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : 'Unable to load your feed.'))
  }, [])

  return (
    <div className="grid gap-6 p-4 sm:p-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-6">
        <section className="rounded-[28px] border border-violet-100 bg-gradient-to-r from-violet-600 via-indigo-600 to-cyan-500 p-5 text-white shadow-lg shadow-violet-200 sm:p-6">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.28em] text-violet-100">Good morning</p>
              <h2 className="mt-2 text-2xl font-semibold sm:text-3xl">Welcome back, {user?.name.split(' ')[0]}.</h2>
              <p className="mt-2 max-w-xl text-sm text-violet-100">
                Stay connected to the people, stories and neighborhoods that make life feel richer and safer.
              </p>
            </div>
            <Link to="/explore">
              <Button variant="secondary" className="bg-white text-indigo-700 hover:bg-indigo-50">
                Explore NOVAKOKO <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Button>
            </Link>
          </div>
        </section>

        <section className="rounded-[28px] border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-900">Stories</p>
            <Button variant="ghost" size="sm" className="text-violet-700">
              View all
            </Button>
          </div>
          <div className="mt-4 flex gap-3 overflow-x-auto pb-1">
            {stories.map((story) => (
              <button
                key={story.id}
                type="button"
                className="group min-w-[80px] rounded-2xl border border-slate-200 bg-slate-50 p-2 text-center transition hover:border-violet-200 hover:bg-violet-50"
              >
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br p-[2px]" style={{ background: `linear-gradient(135deg, ${story.accent}, #e9d5ff)` }}>
                  <img src={story.avatar} alt={story.name} className="h-full w-full rounded-full object-cover" />
                </div>
                <p className="mt-2 text-xs font-medium text-slate-700">{story.name}</p>
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-[28px] border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
          <div className="flex items-start gap-3">
            <Avatar src={`https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(user?.name ?? 'NOVAKOKO')}`} alt={user?.name ?? 'NOVAKOKO'} size="md" />
            <div className="flex-1 rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-3">
              <p className="text-sm font-medium text-slate-500">Share something with your community…</p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="secondary" size="sm">Photo</Button>
            <Button variant="secondary" size="sm">Video</Button>
            <Button variant="secondary" size="sm">Feeling</Button>
            <Button variant="primary" size="sm" className="ml-auto">Publish</Button>
          </div>
        </section>

        <div className="space-y-5">
          {error ? <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div> : null}
          {!error && posts.length === 0 ? <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-6 text-center text-sm text-slate-500">No posts yet. Start the conversation.</div> : null}
          {posts.map((post) => (
            <PostCard key={post.id} post={post} />
          ))}
        </div>
      </div>

      <aside className="space-y-6">
        <section className="rounded-[28px] border border-slate-200 bg-white p-4 shadow-sm lg:hidden xl:block">
          <div className="flex items-center justify-between">
            <p className="font-semibold text-slate-900">Trending</p>
            <TrendingUp className="h-4 w-4 text-violet-600" aria-hidden="true" />
          </div>
          <div className="mt-4 space-y-3">
            {trendingTopics.map((topic, index) => (
              <div key={topic} className="flex items-center justify-between rounded-2xl bg-slate-50 px-3 py-2">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.2em] text-slate-500">#{index + 1}</p>
                  <p className="font-medium text-slate-800">{topic}</p>
                </div>
                <span className="text-xs text-slate-500">{(index + 3) * 12}k</span>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-[28px] border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <p className="font-semibold text-slate-900">Community pulse</p>
            <Users className="h-4 w-4 text-violet-600" aria-hidden="true" />
          </div>
          <div className="mt-4 space-y-3">
            {[
              { label: 'New connections', value: '1,284', tone: 'text-violet-600' },
              { label: 'Safe interactions', value: '94%', tone: 'text-emerald-600' },
              { label: 'Positive feedback', value: '87%', tone: 'text-cyan-600' },
            ].map((metric) => (
              <div key={metric.label} className="rounded-2xl bg-slate-50 p-3">
                <p className="text-xs text-slate-500">{metric.label}</p>
                <p className={`mt-1 text-xl font-semibold ${metric.tone}`}>{metric.value}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-[28px] border border-violet-100 bg-violet-50 p-4 shadow-sm">
          <div className="flex items-center gap-2 text-violet-700">
            <Sparkles className="h-4 w-4" aria-hidden="true" />
            <p className="font-semibold">Safety-first culture</p>
          </div>
          <p className="mt-3 text-sm leading-6 text-slate-600">
            Sexual/adult content, harassment, scams and abusive behavior are prohibited. NOVAKOKO helps keep every space supportive and safe.
          </p>
          <div className="mt-4 flex items-center gap-2 text-sm text-slate-600">
            <Clock3 className="h-4 w-4 text-violet-600" aria-hidden="true" />
            <span>Moderation review in under 24 hours</span>
          </div>
        </section>
      </aside>
    </div>
  )
}
