import { useState } from 'react'
import { Link } from 'react-router-dom'
import { MessageCircle, Share2, ShieldAlert, ThumbsUp, Trash2 } from 'lucide-react'
import { Avatar } from './ui/Avatar'
import { Button } from './ui/Button'
import { useAuth } from '../context/AuthContext'
import { apiRequest } from '../lib/api'
import type { Post } from '../types'

type CommentRecord = {
  id: string
  content: string
  createdAt: string
  author: { id: string; name: string; avatar?: string }
}

type PostCardProps = {
  post: Post
  onDeleted?: (postId: string) => void
}

export function PostCard({ post, onDeleted }: PostCardProps) {
  const { user } = useAuth()
  const [likes, setLikes] = useState(post.likes)
  const [liked, setLiked] = useState(post.currentUserReaction === 'LIKE')
  const [comments, setComments] = useState<CommentRecord[]>([])
  const [commentCount, setCommentCount] = useState(post.comments)
  const [commentDraft, setCommentDraft] = useState('')
  const [commentsOpen, setCommentsOpen] = useState(false)
  const [commentsLoading, setCommentsLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const isOwnPost = user?.id === post.author.id

  const toggleLike = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const response = liked
        ? await apiRequest<{ reactionCounts: Record<string, number> }>(`/api/posts/${post.id}/react`, { method: 'DELETE' })
        : await apiRequest<{ reactionCounts: Record<string, number> }>(`/api/posts/${post.id}/react`, {
            method: 'POST',
            body: JSON.stringify({ type: 'LIKE' }),
          })
      setLiked(!liked)
      setLikes(response.reactionCounts.LIKE ?? 0)
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Unable to update reaction.')
    } finally {
      setBusy(false)
    }
  }

  const loadComments = async () => {
    setCommentsLoading(true)
    setError('')
    try {
      const response = await apiRequest<{ comments: CommentRecord[] }>(`/api/posts/${post.id}/comments`)
      setComments(response.comments)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load comments.')
    } finally {
      setCommentsLoading(false)
    }
  }

  const toggleComments = async () => {
    const nextOpen = !commentsOpen
    setCommentsOpen(nextOpen)
    if (nextOpen) await loadComments()
  }

  const submitComment = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!commentDraft.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      const response = await apiRequest<{ comment: CommentRecord }>(`/api/posts/${post.id}/comments`, {
        method: 'POST',
        body: JSON.stringify({ content: commentDraft.trim() }),
      })
      setComments((current) => [response.comment, ...current])
      setCommentCount((count) => count + 1)
      setCommentDraft('')
    } catch (commentError) {
      setError(commentError instanceof Error ? commentError.message : 'Unable to publish comment.')
    } finally {
      setBusy(false)
    }
  }

  const sharePost = async () => {
    const url = `${window.location.origin}/#post-${encodeURIComponent(post.id)}`
    setError('')
    try {
      if (navigator.share) await navigator.share({ title: `Post by ${post.author.name}`, text: post.content, url })
      else {
        await navigator.clipboard.writeText(url)
        setNotice('Post link copied.')
      }
    } catch (shareError) {
      if (shareError instanceof Error && shareError.name !== 'AbortError') {
        setError('Unable to share this post from this browser.')
      }
    }
  }

  const reportPost = async () => {
    const reason = window.prompt('Why are you reporting this post?')
    if (!reason || reason.trim().length < 4) return
    setError('')
    try {
      await apiRequest('/api/reports', {
        method: 'POST',
        body: JSON.stringify({ targetType: 'post', targetId: post.id, category: 'OTHER', reason: reason.trim() }),
      })
      setNotice('Report submitted for review.')
    } catch (reportError) {
      setError(reportError instanceof Error ? reportError.message : 'Unable to report this post.')
    }
  }

  const deletePost = async () => {
    if (!window.confirm('Delete this post? This cannot be undone.')) return
    setError('')
    try {
      await apiRequest(`/api/posts/${post.id}`, { method: 'DELETE' })
      onDeleted?.(post.id)
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Unable to delete this post.')
    }
  }

  return (
    <article id={`post-${post.id}`} className="rounded-[28px] border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex items-start justify-between gap-4">
        <Link to={`/profile/${encodeURIComponent(post.author.id)}`} className="flex min-w-0 items-center gap-3">
          <Avatar src={post.author.avatar} alt={post.author.name} size="md" />
          <div className="min-w-0">
            <p className="truncate font-semibold text-slate-900">{post.author.name}</p>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span>@{post.author.handle}</span>
              <span aria-hidden="true">·</span>
              <span>{post.time}</span>
            </div>
          </div>
        </Link>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => void sharePost()} aria-label="Share post" title="Share post" className="rounded-full p-2 text-slate-500 hover:bg-slate-100">
            <Share2 className="h-4 w-4" aria-hidden="true" />
          </button>
          <button type="button" onClick={() => void (isOwnPost ? deletePost() : reportPost())} aria-label={isOwnPost ? 'Delete post' : 'Report post'} title={isOwnPost ? 'Delete post' : 'Report post'} className="rounded-full p-2 text-slate-500 hover:bg-slate-100">
            {isOwnPost ? <Trash2 className="h-4 w-4" aria-hidden="true" /> : <ShieldAlert className="h-4 w-4" aria-hidden="true" />}
          </button>
        </div>
      </div>

      {post.category ? <div className="mt-3 inline-flex rounded-full bg-violet-50 px-2.5 py-1 text-[10px] font-semibold uppercase text-violet-700">{post.category}</div> : null}
      {post.content ? <p className="mt-4 whitespace-pre-wrap text-[15px] leading-7 text-slate-700">{post.content}</p> : null}
      {post.image ? <img src={post.image} alt="Post attachment" className="mt-4 max-h-[32rem] w-full rounded-[24px] object-cover" /> : null}

      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
        <Button variant="ghost" size="sm" className={`px-2 ${liked ? 'text-indigo-700' : 'text-slate-600'}`} onClick={() => void toggleLike()} disabled={busy} icon={<ThumbsUp className="h-4 w-4" aria-hidden="true" />}>
          {likes}
        </Button>
        <Button variant="ghost" size="sm" className="px-2 text-slate-600" onClick={() => void toggleComments()} icon={<MessageCircle className="h-4 w-4" aria-hidden="true" />}>
          {commentCount}
        </Button>
      </div>

      {notice ? <p className="mt-2 text-sm text-emerald-700" role="status">{notice}</p> : null}
      {error ? <p className="mt-2 text-sm text-rose-700" role="alert">{error}</p> : null}

      {commentsOpen ? (
        <section className="mt-4 border-t border-slate-100 pt-4" aria-label="Post comments">
          <form onSubmit={(event) => void submitComment(event)} className="flex gap-2">
            <input aria-label="Write a comment" value={commentDraft} onChange={(event) => setCommentDraft(event.target.value)} maxLength={1200} placeholder="Write a comment…" className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none" />
            <Button type="submit" variant="primary" size="sm" disabled={busy || !commentDraft.trim()}>{busy ? 'Posting…' : 'Comment'}</Button>
          </form>
          {commentsLoading ? <p className="mt-4 text-sm text-slate-500">Loading comments…</p> : comments.length === 0 ? <p className="mt-4 text-sm text-slate-500">No comments yet.</p> : (
            <ul className="mt-4 space-y-3">
              {comments.map((comment) => (
                <li key={comment.id} className="flex gap-2">
                  <Avatar src={comment.author.avatar ?? ''} alt={comment.author.name} size="sm" />
                  <div className="min-w-0 rounded-2xl bg-slate-50 px-3 py-2">
                    <p className="text-xs font-semibold text-slate-800">{comment.author.name}</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{comment.content}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </article>
  )
}