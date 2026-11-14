import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  ArrowLeft,
  AtSign,
  CalendarDays,
  Camera,
  ChevronDown,
  ChevronLeft,
  Globe2,
  MapPin,
  Music2,
  Radio,
  Smile,
  UserRoundPlus,
  X,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { apiRequest, resolveMediaUrl, uploadMedia, uploadMessageAttachment, uploadVideo } from '../lib/api'
import { postMediaFileType, validatePostMediaFile } from '../lib/postMedia'
import { postBackgrounds } from '../lib/postBackgrounds'
import { Avatar } from './ui/Avatar'

type PostComposerProps = {
  onClose: () => void
  onPublished: () => void
}

type Visibility = 'PUBLIC' | 'FOLLOWERS' | 'PRIVATE'
type ComposerUser = { id: string; name: string; handle: string; avatar: string }
type ComposerUserSearchResult = { id: string; name: string; profile?: { displayName?: string | null; username?: string | null; avatarUrl?: string | null } }
type ComposerProfileResponse = {
  id?: string
  name?: string
  profile?: { displayName?: string | null; username?: string | null; avatarUrl?: string | null }
}

const feelings = ['happy', 'grateful', 'loved', 'excited', 'blessed', 'tired', 'celebrating']
const activities = ['watching a movie', 'listening to music', 'traveling', 'eating', 'working out']

export function PostComposer({ onClose, onPublished }: PostComposerProps) {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [content, setContent] = useState('')
  const [mediaUrl, setMediaUrl] = useState('')
  const [mediaFile, setMediaFile] = useState<File | null>(null)
  const [uploadedMedia, setUploadedMedia] = useState<{ file: File; url: string } | null>(null)
  const [visibility, setVisibility] = useState<Visibility>('PUBLIC')
  const [uploadProgress, setUploadProgress] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [previewUrl, setPreviewUrl] = useState('')
  const [profile, setProfile] = useState<ComposerUser | null>(null)
  const [profileError, setProfileError] = useState('')
  const [mentionOpen, setMentionOpen] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [users, setUsers] = useState<ComposerUser[]>([])
  const [usersLoading, setUsersLoading] = useState(false)
  const [usersError, setUsersError] = useState('')
  const [locationOpen, setLocationOpen] = useState(false)
  const [location, setLocation] = useState('')
  const [locationDraft, setLocationDraft] = useState('')
  const [feelingOpen, setFeelingOpen] = useState(false)
  const [feeling, setFeeling] = useState('')
  const [backgroundIndex, setBackgroundIndex] = useState(-1)
  const mediaInputRef = useRef<HTMLInputElement>(null)
  const musicInputRef = useRef<HTMLInputElement>(null)
  const textAreaRef = useRef<HTMLTextAreaElement>(null)
  const previewUrlRef = useRef('')
  const selectedMedia = mediaFile ? postMediaFileType(mediaFile) : null

  useEffect(() => {
    let active = true
    if (!user?.id) return
    void apiRequest<{ user: ComposerProfileResponse }>(`/api/users/${encodeURIComponent(user.id)}`)
      .then(({ user: currentUser }) => {
        if (active) {
          setProfile({
            id: currentUser.id ?? user.id,
            name: currentUser.profile?.displayName ?? currentUser.name ?? user.name ?? 'NOVAKOKO member',
            handle: currentUser.profile?.username ?? user.username ?? '',
            avatar: currentUser.profile?.avatarUrl ?? '',
          })
        }
      })
      .catch(() => {
        if (active) {
          setProfile(null)
          setProfileError('Your profile details could not be loaded.')
        }
      })
    return () => { active = false }
  }, [user?.id, user?.name, user?.username])

  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
  }, [])

  const setMediaPreview = (file?: File) => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
    previewUrlRef.current = file ? URL.createObjectURL(file) : ''
    setPreviewUrl(previewUrlRef.current)
  }

  const chooseMedia = (file?: File) => {
    setError('')
    setUploadProgress(null)
    setUploadedMedia(null)
    if (!file) {
      setMediaFile(null)
      setMediaPreview()
      return
    }
    const validationError = validatePostMediaFile(file)
    if (validationError) {
      setMediaFile(null)
      setMediaPreview()
      setError(validationError)
      return
    }
    const mediaType = postMediaFileType(file)
    if (!mediaType) {
      setMediaFile(null)
      setMediaPreview()
      setError('Choose a supported image, video, or audio file.')
      return
    }
    setMediaUrl('')
    const normalizedFile = file.type === mediaType.type ? file : new File([file], file.name, { type: mediaType.type })
    setMediaFile(normalizedFile)
    setMediaPreview(normalizedFile)
  }

  const openMentions = async () => {
    setMentionOpen(true)
    setUsersError('')
    if (users.length || usersLoading) return
    setUsersLoading(true)
    try {
      const response = await apiRequest<{ users: ComposerUserSearchResult[] }>('/api/users')
      setUsers(response.users
        .filter((candidate) => candidate.id !== user?.id)
        .map((candidate) => ({
          id: candidate.id,
          name: candidate.profile?.displayName ?? candidate.name,
          handle: candidate.profile?.username ?? '',
          avatar: candidate.profile?.avatarUrl ?? '',
        })))
    } catch (loadError) {
      setUsersError(loadError instanceof Error ? loadError.message : 'Unable to load people.')
    } finally {
      setUsersLoading(false)
    }
  }

  const insertMention = (person: ComposerUser) => {
    const handle = person.handle.replace(/^@/, '')
    setContent((current) => `${current}${current && !/\s$/.test(current) ? ' ' : ''}@${handle} `)
    setMentionOpen(false)
    requestAnimationFrame(() => textAreaRef.current?.focus())
  }

  const appendCaptionDetails = (caption: string) => {
    const additions = [
      feeling ? `is ${feeling}` : '',
      location ? `📍 ${location}` : '',
    ].filter(Boolean)
    if (!additions.length) return caption.slice(0, 2500)
    const suffix = additions.join('\n')
    return [caption.slice(0, Math.max(0, 2499 - suffix.length)), suffix].filter(Boolean).join('\n')
  }

  const publishPost = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting) return
    const postContent = appendCaptionDetails(content.trim())
    if (!postContent.trim()) {
      setError('Add some text before publishing your post.')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      let publishedMediaUrl = mediaUrl.trim()
      if (mediaFile) {
        const previouslyUploadedUrl = uploadedMedia?.file === mediaFile ? uploadedMedia.url : ''
        if (previouslyUploadedUrl) {
          publishedMediaUrl = previouslyUploadedUrl
        } else {
          if (selectedMedia?.kind !== 'audio') setUploadProgress(0)
          const uploaded = selectedMedia?.kind === 'video'
            ? await uploadVideo(mediaFile, setUploadProgress)
            : selectedMedia?.kind === 'audio'
              ? await uploadMessageAttachment(mediaFile)
              : await uploadMedia(mediaFile, setUploadProgress)
          publishedMediaUrl = uploaded.mediaUrl
          setUploadedMedia({ file: mediaFile, url: uploaded.mediaUrl })
          setUploadProgress(null)
        }
      }
      await apiRequest('/api/posts', {
        method: 'POST',
        body: JSON.stringify({
          content: postContent,
          ...(publishedMediaUrl ? { imageUrl: publishedMediaUrl } : {}),
          visibility,
          background: backgroundIndex >= 0 ? postBackgrounds[backgroundIndex].value : null,
        }),
      })
      onPublished()
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : 'Unable to publish this post.')
    } finally {
      setSubmitting(false)
    }
  }

  const filteredUsers = users.filter((candidate) =>
    `${candidate.name} ${candidate.handle}`.toLowerCase().includes(mentionQuery.trim().replace(/^@/, '').toLowerCase()),
  ).slice(0, 8)
  const composerBackground = postBackgrounds[Math.max(backgroundIndex, 0)]

  const openLive = () => {
    navigate('/live')
  }

  const addFeeling = (value: string, type: 'feeling' | 'activity') => {
    setFeeling(type === 'feeling' ? `feeling ${value}` : `doing ${value}`)
    setFeelingOpen(false)
  }

  return (
    <div className="fixed inset-0 z-[60] flex min-h-0 flex-col bg-white text-slate-950" role="dialog" aria-modal="true" aria-labelledby="post-composer-title">
      <form onSubmit={(event) => void publishPost(event)} className="flex h-[100dvh] min-h-0 flex-1 flex-col">
        <header className="flex h-[60px] shrink-0 items-center justify-between border-b border-slate-200 px-5 pt-[env(safe-area-inset-top)]">
          <div className="flex items-center gap-6">
            <button type="button" onClick={onClose} disabled={submitting} aria-label="Go back" className="rounded-full text-slate-700 hover:bg-slate-100 disabled:opacity-50">
              <ArrowLeft className="h-7 w-7" aria-hidden="true" />
            </button>
            <h2 id="post-composer-title" className="text-2xl font-bold tracking-tight">Create post</h2>
          </div>
          <button type="submit" disabled={submitting || !content.trim()} className="text-xl font-bold text-slate-400 disabled:cursor-not-allowed enabled:text-blue-600">
            {submitting ? 'Posting…' : 'Post'}
          </button>
        </header>

        <div className="flex shrink-0 items-center gap-4 px-6 py-3">
          <div className="flex h-[88px] w-[88px] shrink-0 items-center justify-center overflow-hidden bg-slate-100">
            {profile?.avatar
              ? <img src={resolveMediaUrl(profile.avatar)} alt={profile.name} crossOrigin={profile.avatar.startsWith('/api/media/') ? 'use-credentials' : undefined} className="h-full w-full object-cover" />
              : <span className="text-2xl font-bold text-slate-600">{(profile?.name ?? user?.name ?? '?').split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase()}</span>}
          </div>
          <div className="min-w-0">
            <p className="truncate text-[21px] font-bold leading-tight">{profile?.name ?? user?.name ?? 'NOVAKOKO member'}</p>
            {profile?.handle || user?.username ? <p className="truncate text-sm text-slate-500">@{(profile?.handle ?? user?.username ?? '').replace(/^@/, '')}</p> : null}
            <label className="mt-1 inline-flex cursor-pointer items-center gap-2 rounded-2xl bg-slate-200 px-4 py-2 text-base font-semibold">
              <Globe2 className="h-5 w-5" aria-hidden="true" />
              <select aria-label="Post privacy" value={visibility} onChange={(event) => setVisibility(event.target.value as Visibility)} className="max-w-36 appearance-none bg-transparent outline-none">
                <option value="PUBLIC">Public</option>
                <option value="FOLLOWERS">Followers</option>
                <option value="PRIVATE">Only me</option>
              </select>
              <ChevronDown className="h-4 w-4" aria-hidden="true" />
            </label>
          </div>
        </div>

        <div className="relative flex min-h-[150px] flex-1 flex-col overflow-y-auto" style={{ background: composerBackground.value, color: composerBackground.text }}>
          <textarea
            ref={textAreaRef}
            aria-label="Post content"
            placeholder="Share something that you're grateful for..."
            value={content}
            onChange={(event) => setContent(event.target.value)}
            maxLength={2500}
            className="min-h-0 flex-1 resize-none border-0 bg-transparent px-7 pb-5 pt-6 text-[clamp(28px,6vw,48px)] leading-[1.2] outline-none placeholder:opacity-100"
            style={{ color: composerBackground.text }}
          />

          {mediaFile && selectedMedia ? (
            <div className="mx-6 mb-3 overflow-hidden rounded-xl border border-slate-200 bg-black/5">
              {selectedMedia.kind === 'video'
                ? <video src={previewUrl} controls playsInline className="max-h-52 w-full object-contain" />
                : selectedMedia.kind === 'audio'
                  ? <audio src={previewUrl} controls className="w-full p-3" />
                  : <img src={previewUrl} alt="Selected post preview" className="max-h-52 w-full object-contain" />}
              <div className="flex items-center justify-between gap-3 bg-white px-3 py-2 text-xs text-slate-600">
                <span className="min-w-0 truncate">{mediaFile.name} · {(mediaFile.size / 1024 / 1024).toFixed(1)} MB</span>
                <button type="button" onClick={() => chooseMedia()} className="shrink-0 font-semibold text-rose-700">Remove</button>
              </div>
            </div>
          ) : mediaUrl ? <p className="mx-6 mb-3 truncate rounded-lg bg-white/70 px-3 py-2 text-sm">{mediaUrl}</p> : null}

          <div className="sticky bottom-0 flex shrink-0 items-center gap-3 overflow-x-auto px-6 py-3" aria-label="Post background and mention options">
            <button type="button" aria-label="Previous background colors" onClick={() => setBackgroundIndex((current) => ((current < 0 ? 0 : current) - 1 + postBackgrounds.length) % postBackgrounds.length)} className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-slate-200 bg-white shadow">
              <ChevronLeft className="h-6 w-6 text-slate-600" aria-hidden="true" />
            </button>
            {postBackgrounds.map((background, index) => (
              <button
                key={background.label}
                type="button"
                aria-label={`${background.label} background`}
                aria-pressed={backgroundIndex === index}
                onClick={() => setBackgroundIndex(index)}
                className="h-12 w-12 shrink-0 rounded-2xl border border-slate-200 shadow"
                style={{ background: background.value }}
              />
            ))}
            <button
              type="button"
              onClick={() => { setContent((current) => `${current}${current && !/\s$/.test(current) ? ' ' : ''}@`); requestAnimationFrame(() => textAreaRef.current?.focus()) }}
              aria-label="Insert @ mention"
              className="sticky right-0 flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-600 shadow"
            >
              <AtSign className="h-6 w-6" aria-hidden="true" />
            </button>
          </div>
        </div>

        <section className="relative flex min-h-0 flex-[2] flex-col bg-white px-7 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1">
          <input
            ref={mediaInputRef}
            type="file"
            aria-label="Choose photos or videos"
            accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,video/ogg,.jpg,.jpeg,.png,.webp,.mp4,.webm,.ogg"
            onChange={(event) => { chooseMedia(event.target.files?.[0]); event.currentTarget.value = '' }}
            className="sr-only"
          />
          <input
            ref={musicInputRef}
            type="file"
            aria-label="Choose music"
            accept="audio/mpeg,audio/mp4,.mp3,.m4a"
            onChange={(event) => { chooseMedia(event.target.files?.[0]); event.currentTarget.value = '' }}
            className="sr-only"
          />

          <div className="min-h-0 flex-1 overflow-y-auto">
          <ActionRow icon={Camera} color="text-[#82b755]" label="Photos/Videos" onClick={() => mediaInputRef.current?.click()} />
          <ActionRow icon={Music2} color="text-[#e85ba8]" label="Music" onClick={() => musicInputRef.current?.click()} />
          <ActionRow icon={UserRoundPlus} color="text-[#2470c8]" label="Tag people" onClick={() => void openMentions()} />
          <ActionRow icon={MapPin} color="text-[#df2945]" label="Add location" onClick={() => { setLocationDraft(location); setLocationOpen((open) => !open); setFeelingOpen(false) }} />
          <ActionRow icon={Smile} color="text-[#b29a00]" label="Feeling/activity" onClick={() => { setFeelingOpen((open) => !open); setLocationOpen(false) }} />
          <ActionRow icon={CalendarDays} color="text-[#ed4652]" label="Create Event" onClick={() => setNotice('Event creation is not available in NOVAKOKO yet; no event API is configured.')} />
          <ActionRow icon={Radio} color="text-[#b51d37]" label="Go live" onClick={openLive} />

          {locationOpen ? (
            <div className="mb-2 rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
              <label className="block text-sm font-semibold text-slate-700" htmlFor="post-location">Location</label>
              <div className="mt-2 flex gap-2">
                <input id="post-location" value={locationDraft} onChange={(event) => setLocationDraft(event.target.value)} maxLength={80} placeholder="Add a place" className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900" />
                <button type="button" onClick={() => { setLocation(locationDraft.trim()); setLocationOpen(false) }} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white">Save</button>
              </div>
            </div>
          ) : null}

          {feelingOpen ? (
            <div className="mb-2 max-h-52 overflow-y-auto rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
              <p className="mb-2 text-sm font-semibold text-slate-700">Feeling</p>
              <div className="flex flex-wrap gap-2">
                {feelings.map((value) => <button key={value} type="button" onClick={() => addFeeling(value, 'feeling')} className="rounded-full bg-slate-100 px-3 py-1.5 text-sm text-slate-800">😊 {value}</button>)}
              </div>
              <p className="mb-2 mt-3 text-sm font-semibold text-slate-700">Activity</p>
              <div className="flex flex-wrap gap-2">
                {activities.map((value) => <button key={value} type="button" onClick={() => addFeeling(value, 'activity')} className="rounded-full bg-slate-100 px-3 py-1.5 text-sm text-slate-800">{value}</button>)}
              </div>
            </div>
          ) : null}

          {mentionOpen ? (
            <div className="absolute inset-x-4 bottom-[calc(100%+0.5rem)] z-10 rounded-2xl border border-slate-200 bg-white p-4 text-slate-900 shadow-xl">
              <div className="flex items-center justify-between gap-4">
                <h3 className="font-semibold">Tag people</h3>
                <button type="button" onClick={() => setMentionOpen(false)} aria-label="Close people search" className="rounded-full p-1 text-slate-500 hover:bg-slate-100"><X className="h-5 w-5" /></button>
              </div>
              <input autoFocus value={mentionQuery} onChange={(event) => setMentionQuery(event.target.value)} placeholder="Search people" aria-label="Search people to tag" className="mt-3 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm" />
              {usersLoading ? <p className="mt-3 text-sm text-slate-500" role="status">Loading people…</p> : null}
              {usersError ? <p className="mt-3 text-sm text-rose-700" role="alert">{usersError}</p> : null}
              {!usersLoading && !usersError ? <ul className="mt-2 max-h-48 divide-y divide-slate-100 overflow-y-auto">
                {filteredUsers.map((person) => (
                  <li key={person.id}>
                    <button type="button" onClick={() => insertMention(person)} className="flex w-full items-center gap-3 py-2 text-left hover:bg-slate-50">
                      <Avatar src={person.avatar} alt={person.name} size="sm" />
                      <span className="min-w-0"><span className="block truncate text-sm font-semibold">{person.name}</span><span className="block truncate text-xs text-slate-500">@{person.handle.replace(/^@/, '')}</span></span>
                    </button>
                  </li>
                ))}
                {!filteredUsers.length ? <li className="py-3 text-sm text-slate-500">No matching people found.</li> : null}
              </ul> : null}
            </div>
          ) : null}

          <details className="mb-2 text-xs text-slate-500">
            <summary className="cursor-pointer">Use a media URL instead</summary>
            <input aria-label="Media URL" type="url" value={mediaUrl} onChange={(event) => { setMediaUrl(event.target.value); setMediaFile(null); setUploadedMedia(null); setMediaPreview() }} placeholder="Optional HTTPS image or video URL" className="mt-2 w-full rounded-lg border border-slate-200 px-3 py-2 text-slate-800" />
          </details>

          {uploadProgress !== null ? <div className="mb-2" aria-live="polite">
            <div className="mb-1 flex justify-between text-xs text-slate-600"><span>Uploading {mediaFile?.name}</span><span>{uploadProgress}%</span></div>
            <progress aria-label="Upload progress" max={100} value={uploadProgress} className="h-2 w-full accent-blue-600" />
          </div> : null}
          {profileError ? <p className="mb-2 text-xs text-slate-500" role="status">{profileError}</p> : null}
          {location ? <p className="mb-1 text-xs text-slate-500">📍 {location} <button type="button" onClick={() => setLocation('')} className="ml-1 font-semibold text-blue-700">Remove</button></p> : null}
          {feeling ? <p className="mb-1 text-xs text-slate-500">Feeling/activity: {feeling} <button type="button" onClick={() => setFeeling('')} className="ml-1 font-semibold text-blue-700">Remove</button></p> : null}
          {notice ? <p className="mb-2 text-sm text-amber-800" role="status">{notice}</p> : null}
          {error ? <p className="mb-2 text-sm text-rose-700" role="alert">{error}</p> : null}
          </div>
          <button type="submit" disabled={submitting} className="mb-3 mt-2 h-[68px] w-full shrink-0 rounded-xl bg-[#0866ff] text-[29px] font-bold text-white disabled:opacity-60">
            {submitting ? uploadProgress !== null ? 'Uploading and posting…' : 'Posting…' : 'Post'}
          </button>
        </section>
      </form>
    </div>
  )
}

function ActionRow({ icon: Icon, color, label, onClick }: { icon: LucideIcon; color: string; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex h-[50px] w-full shrink-0 items-center gap-6 text-left text-xl text-slate-950 hover:bg-slate-50">
      <Icon className={`h-7 w-7 shrink-0 ${color}`} strokeWidth={2.8} aria-hidden="true" />
      <span>{label}</span>
    </button>
  )
}
