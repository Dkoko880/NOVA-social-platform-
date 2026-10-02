import { Filter, Sparkles, Users, UsersRound } from 'lucide-react'
import { communities, recommendedUsers, trendingTopics } from '../data/mockData'
import { Avatar } from '../components/ui/Avatar'
import { Button } from '../components/ui/Button'
import { SearchBar } from '../components/ui/SearchBar'
import { useMemo, useState } from 'react'

export function ExplorePage() {
  const [term, setTerm] = useState('')
  const filteredTopics = useMemo(
    () => trendingTopics.filter((topic) => topic.toLowerCase().includes(term.toLowerCase())),
    [term],
  )

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.28em] text-indigo-600">Discover</p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-900">Explore what matters to you</h2>
        </div>
        <Button variant="secondary" size="sm" icon={<Filter className="h-4 w-4" aria-hidden="true" />}>
          Filters
        </Button>
      </div>

      <SearchBar value={term} onChange={setTerm} placeholder="Search communities, people and ideas" />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <section className="rounded-[28px] border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <p className="font-semibold text-slate-900">Trending topics</p>
              <Sparkles className="h-4 w-4 text-indigo-600" aria-hidden="true" />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {filteredTopics.length ? (
                filteredTopics.map((topic) => (
                  <button
                    key={topic}
                    type="button"
                    className="rounded-full border border-indigo-100 bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-700 transition hover:bg-indigo-100"
                  >
                    #{topic}
                  </button>
                ))
              ) : (
                <span className="text-sm text-slate-500">No matching topics found.</span>
              )}
            </div>
          </section>

          <section className="rounded-[28px] border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-4 flex items-center justify-between">
              <p className="font-semibold text-slate-900">Content discovery</p>
              <span className="text-xs text-slate-500">Fresh picks</span>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              {[
                {
                  title: 'Neighborhood learning hubs',
                  description: 'Explore families organizing creative workshops and community classes.',
                  image:
                    'https://images.unsplash.com/photo-1523240795612-9a054b0db644?auto=format&fit=crop&w=900&q=80',
                },
                {
                  title: 'Weekend care circles',
                  description: 'Connect with caring local groups sharing safe, family-friendly activities.',
                  image:
                    'https://images.unsplash.com/photo-1517486808906-6ca8b3d5c8b7?auto=format&fit=crop&w=900&q=80',
                },
              ].map((card) => (
                <article key={card.title} className="overflow-hidden rounded-[24px] border border-slate-200 bg-slate-50">
                  <img src={card.image} alt={card.title} className="h-40 w-full object-cover" />
                  <div className="p-4">
                    <p className="font-semibold text-slate-900">{card.title}</p>
                    <p className="mt-2 text-sm leading-6 text-slate-600">{card.description}</p>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>

        <div className="space-y-6">
          <section className="rounded-[28px] border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <p className="font-semibold text-slate-900">Recommended users</p>
              <UsersRound className="h-4 w-4 text-indigo-600" aria-hidden="true" />
            </div>
            <div className="mt-4 space-y-3">
              {recommendedUsers.map((person) => (
                <div key={person.id} className="flex items-center justify-between gap-3 rounded-2xl bg-slate-50 p-3">
                  <div className="flex items-center gap-3">
                    <Avatar src={person.avatar} alt={person.name} size="sm" />
                    <div>
                      <p className="font-medium text-slate-900">{person.name}</p>
                      <p className="text-xs text-slate-500">{person.handle}</p>
                    </div>
                  </div>
                  <Button variant="secondary" size="sm">Follow</Button>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-[28px] border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <p className="font-semibold text-slate-900">Recommended communities</p>
              <Users className="h-4 w-4 text-indigo-600" aria-hidden="true" />
            </div>
            <div className="mt-4 space-y-3">
              {communities.slice(0, 2).map((community) => (
                <div key={community.id} className="overflow-hidden rounded-[20px] border border-slate-200 bg-slate-50">
                  <img src={community.cover} alt={community.name} className="h-24 w-full object-cover" />
                  <div className="p-3">
                    <p className="font-semibold text-slate-900">{community.name}</p>
                    <p className="mt-1 text-xs text-slate-500">{community.members}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
