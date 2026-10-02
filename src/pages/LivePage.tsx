import { ArrowUpRight, Headphones, Radio, Users } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { communities } from '../data/mockData'
import { Avatar } from '../components/ui/Avatar'

const rooms = [
  { title: 'Late night, soft thoughts', host: 'Maya Chen', topic: 'Lounge', listeners: '248', color: 'from-indigo-700 via-violet-700 to-fuchsia-600', image: 'photo-1524504388940-b1c1722653e1' },
  { title: 'The Sunday reset', host: 'Jordan Lee', topic: 'Wellness', listeners: '186', color: 'from-sky-700 via-blue-700 to-indigo-600', image: 'photo-1500648767791-00dcc994a43e' },
  { title: 'Good things close by', host: 'Nia Brooks', topic: 'Community', listeners: '92', color: 'from-violet-700 via-purple-700 to-indigo-600', image: 'photo-1534528741775-53994a69daeb' },
]

export function LivePage() {
  const [joinedRoom, setJoinedRoom] = useState('')

  return (
    <div className="space-y-7 p-4 sm:p-7">
      <header className="flex items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-indigo-600">Happening now</p>
          <h2 className="mt-1 text-2xl font-bold text-slate-950 sm:text-3xl">Live rooms</h2>
          <p className="mt-1 text-sm text-slate-500">Drop in, listen, and meet your people.</p>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full bg-rose-50 px-3 py-2 text-xs font-semibold text-rose-700"><span className="h-2 w-2 animate-pulse rounded-full bg-rose-500" /> LIVE</span>
      </header>

      {joinedRoom ? (
        <section role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-indigo-100 bg-indigo-50 p-4 text-sm text-indigo-900">
          <span>You joined <strong>{joinedRoom}</strong> as a listener.</span>
          <button type="button" onClick={() => setJoinedRoom('')} className="font-semibold text-indigo-700 hover:text-indigo-900">Leave room</button>
        </section>
      ) : null}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {rooms.map((room) => (
          <article key={room.title} className="group overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg">
            <div className={`relative flex h-40 flex-col justify-between bg-gradient-to-br ${room.color} p-4 text-white`}>
              <img src={`https://images.unsplash.com/${room.image}?auto=format&fit=crop&w=900&q=80`} alt="" className="absolute inset-0 h-full w-full object-cover opacity-30 mix-blend-luminosity" />
              <div className="relative flex justify-between"><span className="rounded-full bg-black/20 px-3 py-1 text-xs font-medium backdrop-blur">{room.topic}</span><span className="flex items-center gap-1 rounded-full bg-rose-500 px-2.5 py-1 text-[10px] font-bold"><Radio className="h-3 w-3" /> LIVE</span></div>
              <div className="relative flex items-end justify-between"><div><p className="text-xs text-white/75">HOSTED BY</p><p className="font-semibold">{room.host}</p></div><div className="flex items-center gap-1.5 rounded-full bg-black/20 px-2.5 py-1 text-xs backdrop-blur"><Headphones className="h-3.5 w-3.5" /> {room.listeners}</div></div>
            </div>
            <div className="p-4">
              <h3 className="text-lg font-semibold text-slate-900">{room.title}</h3>
              <p className="mt-1 text-sm text-slate-500">A welcoming room for good conversation.</p>
              <button type="button" onClick={() => setJoinedRoom(room.title)} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-full bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-700"><Headphones className="h-4 w-4" /> Join room</button>
            </div>
          </article>
        ))}
      </section>

      <section className="rounded-[24px] border border-indigo-100 bg-gradient-to-r from-indigo-50 via-violet-50 to-fuchsia-50 p-5 sm:flex sm:items-center sm:justify-between sm:p-6">
        <div><p className="text-xs font-bold uppercase tracking-[0.2em] text-indigo-700">Your people, your room</p><h3 className="mt-1 text-xl font-semibold text-slate-900">Start a live conversation</h3><p className="mt-1 text-sm text-slate-600">Bring a group together around something you love.</p></div>
        <Link to="/communities" className="mt-4 inline-flex items-center gap-2 rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-indigo-700 shadow-sm ring-1 ring-indigo-100 sm:mt-0">Explore groups <ArrowUpRight className="h-4 w-4" /></Link>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between"><h3 className="font-semibold text-slate-900">Rooms from your circles</h3><Users className="h-4 w-4 text-indigo-600" /></div>
        <div className="flex gap-3 overflow-x-auto pb-2">
          {communities.slice(0, 4).map((community, index) => <div key={community.id} className="flex min-w-56 items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3"><Avatar src={`https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(community.name)}`} alt={community.name} size="sm" /><div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-800">{community.name}</p><p className="text-xs text-slate-500">{index * 17 + 12} members listening</p></div></div>)}
        </div>
      </section>
    </div>
  )
}