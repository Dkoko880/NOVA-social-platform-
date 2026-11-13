type StoryReplyConversation = {
  id: string
  isGroup?: boolean
  participants: { userId: string }[]
}

type StoryReplyApiRequest = <T>(path: string, options?: RequestInit) => Promise<T>
export type TimedUpdateKind = 'STORY' | 'STATUS'
export type TimedUpdateReaction = '👍' | '❤️' | '😂' | '😮' | '😢' | '🙏'

export function isVideoStoryMedia(mediaUrl: string | null | undefined) {
  return Boolean(mediaUrl && /\.(mp4|webm|ogv|mov)(?:[?#]|$)/i.test(mediaUrl))
}

export async function sendStoryReply(
  ownerId: string,
  text: string,
  request: StoryReplyApiRequest,
) {
  const reply = text.trim()
  if (!reply) throw new Error('Write a reply before sending.')
  const { conversations } = await request<{ conversations: StoryReplyConversation[] }>('/api/conversations')
  let conversation = conversations.find((entry) => !entry.isGroup && entry.participants.some((participant) => participant.userId === ownerId))
  if (!conversation) {
    const response = await request<{ conversation: { id: string } }>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ participantId: ownerId }),
    })
    conversation = { id: response.conversation.id, participants: [{ userId: ownerId }] }
  }
  await request(`/api/conversations/${encodeURIComponent(conversation.id)}/messages`, {
    method: 'POST',
    body: JSON.stringify({ text: `Reply to your story: ${reply}` }),
  })
}

export async function sendTimedUpdateReply(
  input: {
    kind: TimedUpdateKind
    updateId: string
    ownerId: string
    text?: string
    reaction?: TimedUpdateReaction
  },
  request: StoryReplyApiRequest,
) {
  const text = input.text?.trim() ?? ''
  if (!text && !input.reaction) throw new Error('Write a reply or choose a reaction before sending.')
  const { conversation } = await request<{ conversation: { id: string } }>('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ participantId: input.ownerId }),
  })
  const messageText = text || `Reacted ${input.reaction} to your ${input.kind === 'STORY' ? 'Story' : 'Status'}`
  await request(`/api/conversations/${encodeURIComponent(conversation.id)}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      text: messageText,
      metadata: {
        timedUpdateReply: {
          kind: input.kind,
          id: input.updateId,
          ...(input.reaction ? { reaction: input.reaction } : {}),
        },
      },
    }),
  })
  return conversation.id
}
