import { ArrowDownLeft, ArrowUpRight, Headphones, MessageCircle, Phone, Search, Video } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { recommendedUsers } from '../data/mockData'
import { Avatar } from '../components/ui/Avatar'

const recentCalls = [
  { name: 'Maya Chen', note: 'Today, 10:42 AM', type: 'Voice call', incoming: true, duration: '12 min' },
  { name: 'Jordan Lee', note: 'Yesterday, 8:18 PM', type: 'Video call', incoming: false, duration: '24 min' },
  { name: 'Nia Brooks', note: 'Yesterday, 3:06 PM', type: 'Voice call', incoming: true, duration: '6 min' },
]

export function CallsPage() {
  const [query, setQuery] = useState('')
  const people = useMemo(() => recommendedUsers.filter((person) => person.name.toLowerCase().includes(query.toLowerCase())), [query])

  return (
    <div className="space-y-7 p-4 sm:p-7">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.22em] text-indigo-600">Stay close</p>
        <h2 className="mt-1 text-2xl font-bold text-slate-950 sm:text-3xl">Calls</h2>
        <p className="mt-1 text-sm text-slate-500">Pick up where the conversation left off.</p>
      </header>

      <section className="rounded-[24px] bg-gradient-to-br from-indigo-700 via-violet-700 to-fuchsia-700 p-5 text-white shadow-lg shadow-indigo-200 sm:flex sm:items-center sm:justify-between sm:p-7">
        <div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-indigo-100">A little more personal</p><h3 className="mt-2 text-2xl font-semibold">Make time to catch up.</h3><p className="mt-2 max-w-md text-sm text-indigo-100">Start a conversation from Messages when you’re ready.</p></div>
        <Link to="/messages" className="mt-5 inline-flex items-center gap-2 rounded-full bg-white px-4 py-2.5 text-sm font-semibold text-indigo-700 shadow-sm sm:mt-0"><Phone className="h-4 w-4" /> Open messages</Link>
      </section>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(280px,.75fr)]">
        <div>
          <div className="mb-3 flex items-center justify-between"><h3 className="font-semibold text-slate-900">Recent</h3><span className="text-xs text-slate-500">This week</span></div>
          <div className="divide-y divide-slate-100 overflow-hidden rounded-[20px] border border-slate-200 bg-white">
            {recentCalls.map((call) => <div key={call.name} className="flex items-center gap-3 px-4 py-3.5"><Avatar src={`https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(call.name)}`} alt={call.name} size="md" /><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-slate-900">{call.name}</p><p className="mt-0.5 text-xs text-slate-500">{call.note} · {call.duration}</p></div><div className="hidden items-center gap-2 text-xs text-slate-500 sm:flex">{call.type === 'Video call' ? <Video className="h-4 w-4" /> : <Phone className="h-4 w-4" />}{call.type}</div>{call.incoming ? <ArrowDownLeft className="h-4 w-4 text-emerald-600" /> : <ArrowUpRight className="h-4 w-4 text-indigo-600" />}<Link aria-label={`Message ${call.name}`} to="/messages" className="rounded-full p-2 text-indigo-600 hover:bg-indigo-50"><MessageCircle className="h-4 w-4" /></Link></div>)}
          </div>
          <p className="mt-3 flex items-center gap-2 text-xs text-slate-500"><Headphones className="h-4 w-4 text-indigo-500" /> Calls are available from supported conversations.</p>
        </div>

        <aside>
          <h3 className="mb-3 font-semibold text-slate-900">Connect with someone</h3>
          <label className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-400"><Search className="h-4 w-4" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a person" aria-label="Find a person" className="w-full bg-transparent text-slate-800 outline-none placeholder:text-slate-400" /></label>
          <div className="mt-3 divide-y divide-slate-100 overflow-hidden rounded-[20px] border border-slate-200 bg-white">
            {people.map((person) => <div key={person.id} className="flex items-center gap-3 p-3"><Avatar src={person.avatar} alt={person.name} size="sm" /><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-slate-900">{person.name}</p><p className="truncate text-xs text-slate-500">{person.handle}</p></div><Link to="/messages" aria-label={`Message ${person.name}`} className="rounded-full bg-indigo-50 p-2 text-indigo-700 hover:bg-indigo-100"><MessageCircle className="h-4 w-4" /></Link></div>)}
            {people.length === 0 ? <p className="p-4 text-sm text-slate-500">No people match that search.</p> : null}
          </div>
        </aside>
      </section>
    </div>
  )
}