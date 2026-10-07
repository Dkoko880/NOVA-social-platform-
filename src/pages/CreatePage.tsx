import { Image, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '../components/ui/Button'
import { apiRequest, uploadMedia } from '../lib/api'

export function CreatePage() {
  const navigate = useNavigate()
  const [content, setContent] = useState('')
  const [imageUrl, setImageUrl] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [visibility, setVisibility] = useState<'PUBLIC' | 'FOLLOWERS' | 'PRIVATE'>('PUBLIC')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const publishPost = async () => {
    if (!content.trim() || submitting) return
    setSubmitting(true)
    setError('')
    try {
      const uploaded = imageFile ? await uploadMedia(imageFile) : null
      await apiRequest('/api/posts', {
        method: 'POST',
        body: JSON.stringify({ content: content.trim(), ...((uploaded?.mediaUrl ?? imageUrl.trim()) ? { imageUrl: uploaded?.mediaUrl ?? imageUrl.trim() } : {}), visibility }),
      })
      navigate('/')
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : 'Unable to publish this post.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="p-4 sm:p-6">
      <div className="mx-auto max-w-3xl rounded-[32px] border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-violet-600">Create</p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-900">Share a new post</h2>
          </div>
          <span className="text-xs text-slate-500">Posts are reviewed under community safety rules.</span>
        </div>

        <div className="mt-6 rounded-[28px] border border-slate-200 bg-slate-50 p-4">
          <textarea
            aria-label="Post content"
            placeholder="What’s happening in your corner of the world?"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            maxLength={2500}
            className="min-h-[160px] w-full resize-none border-0 bg-transparent text-base text-slate-800 placeholder:text-slate-400 focus:outline-none"
          />
        </div>

        <label className="mt-5 flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500">
          <Image className="h-5 w-5 shrink-0" aria-hidden="true" />
          <input
            type="url"
            aria-label="Image URL"
            placeholder="Image URL (https://...)"
            value={imageUrl}
            onChange={(event) => { setImageUrl(event.target.value); setImageFile(null) }}
            className="min-w-0 flex-1 bg-transparent text-slate-800 placeholder:text-slate-400 focus:outline-none"
          />
        </label>
        <label className="mt-3 block rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
          <span className="mb-2 block font-medium">Or upload an image (JPEG, PNG, or WebP; up to 10 MB)</span>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            aria-label="Upload post image"
            onChange={(event) => { setImageFile(event.target.files?.[0] ?? null); setImageUrl('') }}
            className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-indigo-50 file:px-3 file:py-2 file:font-semibold file:text-indigo-700"
          />
        </label>
        <label className="mt-3 flex items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
          <span>Who can see this post?</span>
          <select
            aria-label="Post privacy"
            value={visibility}
            onChange={(event) => setVisibility(event.target.value as typeof visibility)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 focus:border-indigo-400 focus:outline-none"
          >
            <option value="PUBLIC">Everyone</option>
            <option value="FOLLOWERS">Followers</option>
            <option value="PRIVATE">Only me</option>
          </select>
        </label>
        {imageFile ? <p className="mt-2 text-xs text-slate-500">{imageFile.name} · {(imageFile.size / 1024 / 1024).toFixed(1)} MB</p> : null}
        {imageUrl ? <img src={imageUrl} alt="Post preview" className="mt-3 max-h-80 w-full rounded-2xl object-cover" /> : null}

        <div className="mt-6 rounded-[24px] border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm font-semibold text-slate-900">Community safety</p>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Posts are checked by NOVAKOKO moderation before publication.
          </p>
        </div>

        <div className="mt-6 rounded-[24px] border border-amber-200 bg-amber-50 p-4">
          <div className="flex items-start gap-3">
            <ShieldAlert className="mt-0.5 h-5 w-5 text-amber-600" aria-hidden="true" />
            <div>
              <p className="font-semibold text-amber-900">Content safety notice</p>
              <p className="mt-1 text-sm leading-6 text-amber-800">
                Sexual/adult content, harassment, scams, and abusive behavior are prohibited on NOVAKOKO. Please keep community spaces respectful and safe.
              </p>
            </div>
          </div>
        </div>

        {error ? <p className="mt-4 text-sm text-rose-700" role="alert">{error}</p> : null}
        <div className="mt-6 flex justify-end">
          <Button variant="primary" size="lg" onClick={() => void publishPost()} disabled={submitting || !content.trim()}>
            {submitting ? 'Publishing…' : 'Post to NOVAKOKO'}
          </Button>
        </div>
      </div>
    </div>
  )
}
