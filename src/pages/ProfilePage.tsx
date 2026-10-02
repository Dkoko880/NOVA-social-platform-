import { Camera, Link2, MapPin, PencilLine, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Avatar } from '../components/ui/Avatar'
import { Button } from '../components/ui/Button'
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

export function ProfilePage() {
  const { user } = useAuth()
  const [posts, setPosts] = useState<Post[]>([])
  const [profile, setProfile] = useState<any>(null)

  useEffect(() => {
    if (!user) return
    void Promise.all([
      apiRequest<{ user: any }>(`/api/users/${user.id}`),
      apiRequest<{ posts: any[] }>('/api/posts'),
    ]).then(([userResponse, postsResponse]) => {
      setProfile(userResponse.user)
      setPosts(postsResponse.posts.filter((post) => post.author.id === user.id).map(toPost))
    })
  }, [user])

  const displayName = profile?.profile?.displayName ?? user?.name ?? 'NOVA user'
  const avatar = profile?.profile?.avatarUrl ?? `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(displayName)}`

  return (
    <div className="p-4 sm:p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <section className="overflow-hidden rounded-[32px] border border-slate-200 bg-white shadow-sm">
          <div className="h-40 bg-gradient-to-r from-violet-600 via-indigo-600 to-cyan-500" />
          <div className="relative p-4 sm:p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
              <div className="flex items-end gap-4">
                <div className="-mt-14 rounded-full border-4 border-white bg-white p-1">
                  <Avatar src={avatar} alt={displayName} size="xl" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-2xl font-semibold text-slate-900">{displayName}</h2>
                    <ShieldCheck className="h-5 w-5 text-violet-600" aria-hidden="true" />
                  </div>
                  <p className="text-sm text-slate-500">@{profile?.handle ?? user?.username ?? user?.email?.split('@')[0] ?? user?.phoneE164 ?? 'member'}</p>
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" icon={<PencilLine className="h-4 w-4" aria-hidden="true" />}>
                  Edit profile
                </Button>
                <Button variant="primary" size="sm" icon={<Camera className="h-4 w-4" aria-hidden="true" />}>
                  Share
                </Button>
              </div>
            </div>

            <p className="mt-5 max-w-2xl text-sm leading-7 text-slate-600">
              {profile?.profile?.bio ?? 'Share your story with the NOVA community.'}
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-5 text-sm text-slate-500">
              {profile?.profile?.location ? <span className="inline-flex items-center gap-2"><MapPin className="h-4 w-4" aria-hidden="true" /> {profile.profile.location}</span> : null}
              {profile?.profile?.website ? <span className="inline-flex items-center gap-2"><Link2 className="h-4 w-4" aria-hidden="true" /> {profile.profile.website}</span> : null}
            </div>

            <div className="mt-5 flex flex-wrap gap-4">
              {[
                { label: 'Posts', value: posts.length },
                { label: 'Followers', value: profile?.followerCount ?? 0 },
                { label: 'Following', value: profile?.followingCount ?? 0 },
              ].map((stat) => (
                <div key={stat.label} className="rounded-2xl bg-slate-50 px-4 py-3">
                  <p className="text-xl font-semibold text-slate-900">{stat.value}</p>
                  <p className="text-xs text-slate-500">{stat.label}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="space-y-5">
          {posts.map((post) => (
            <PostCard key={post.id} post={post} />
          ))}
        </section>
      </div>
    </div>
  )
}
