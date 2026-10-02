import { ArrowUp, Check, Copy, Lightbulb, MessageSquareText, Sparkles, WandSparkles } from 'lucide-react'
import { useState } from 'react'

const starters = [
  { icon: MessageSquareText, label: 'Write a welcome message', prompt: 'Write a warm welcome message for a new community member.' },
  { icon: Lightbulb, label: 'Find a fresh idea', prompt: 'Suggest a thoughtful, low-pressure community activity for this weekend.' },
  { icon: WandSparkles, label: 'Polish my words', prompt: 'Help me make a community announcement sound warm and clear.' },
]

function makeDraft(prompt: string) {
  if (prompt.toLowerCase().includes('welcome')) return 'Welcome in! We’re glad you found your way here. Take your time, say hello whenever you feel ready, and make yourself at home.'
  if (prompt.toLowerCase().includes('weekend') || prompt.toLowerCase().includes('activity')) return 'Try a small neighborhood photo walk: invite everyone to share one detail that made them smile this week. It is easy to join and gives the conversation a gentle starting point.'
  return 'A quick note for our community: we have something lovely coming up, and we would be happy to see you there. More details soon. Thanks for making this space feel welcoming.'
}

export function AiPage() {
  const [prompt, setPrompt] = useState('')
  const [draft, setDraft] = useState('')
  const [copied, setCopied] = useState(false)

  const submitPrompt = (value = prompt) => {
    if (!value.trim()) return
    setPrompt(value)
    setDraft(makeDraft(value))
    setCopied(false)
  }

  const copyDraft = async () => {
    await navigator.clipboard?.writeText(draft)
    setCopied(true)
  }

  return (
    <div className="mx-auto max-w-5xl space-y-7 p-4 sm:p-7">
      <header>
        <p className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-[0.22em] text-indigo-600"><Sparkles className="h-3.5 w-3.5" /> NOVAKOKO AI</p>
        <h2 className="mt-1 text-2xl font-bold text-slate-950 sm:text-3xl">A thoughtful place to start.</h2>
        <p className="mt-1 text-sm text-slate-500">Shape a note, find an idea, or get unstuck.</p>
      </header>

      <section className="rounded-[26px] border border-indigo-100 bg-gradient-to-br from-indigo-50 via-white to-fuchsia-50 p-4 sm:p-7">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-md shadow-indigo-200"><Sparkles className="h-5 w-5" /></div>
          <div><h3 className="font-semibold text-slate-900">What can I help you create?</h3><p className="mt-1 text-sm text-slate-500">Start with a prompt or choose an idea below.</p></div>
        </div>
        <form className="mt-5 flex items-end gap-2 rounded-[20px] border border-slate-200 bg-white p-2 shadow-sm" onSubmit={(event) => { event.preventDefault(); submitPrompt() }}>
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={2} maxLength={600} placeholder="Write a kind welcome note for my group…" aria-label="Describe what you want help creating" className="min-h-14 flex-1 resize-y bg-transparent px-2 py-2 text-sm text-slate-800 outline-none placeholder:text-slate-400" />
          <button type="submit" aria-label="Create draft" disabled={!prompt.trim()} className="mb-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"><ArrowUp className="h-4 w-4" /></button>
        </form>
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          {starters.map(({ icon: Icon, label, prompt: starter }) => <button key={label} type="button" onClick={() => submitPrompt(starter)} className="flex items-center gap-2 rounded-xl border border-indigo-100/80 bg-white/80 px-3 py-3 text-left text-xs font-medium text-slate-700 transition hover:border-indigo-300 hover:bg-white"><Icon className="h-4 w-4 shrink-0 text-indigo-600" />{label}</button>)}
        </div>
      </section>

      {draft ? <section className="rounded-[22px] border border-slate-200 bg-white p-4 shadow-sm sm:p-5"><div className="flex items-center justify-between gap-3"><div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-indigo-600" /><h3 className="text-sm font-semibold text-slate-900">Your draft</h3></div><button type="button" onClick={() => void copyDraft()} className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-50">{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{copied ? 'Copied' : 'Copy'}</button></div><p className="mt-4 text-sm leading-7 text-slate-700">{draft}</p><p className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-400">A starting point. Review and make it yours before sharing.</p></section> : null}

      <section className="grid gap-3 sm:grid-cols-2">
        <article className="rounded-[20px] border border-slate-200 bg-white p-4"><p className="text-sm font-semibold text-slate-900">Community-minded</p><p className="mt-1 text-sm text-slate-500">Ideas for messages that feel warm, inclusive, and clear.</p></article>
        <article className="rounded-[20px] border border-slate-200 bg-white p-4"><p className="text-sm font-semibold text-slate-900">You stay in control</p><p className="mt-1 text-sm text-slate-500">Nothing is posted for you. Review every draft before sharing.</p></article>
      </section>
    </div>
  )
}