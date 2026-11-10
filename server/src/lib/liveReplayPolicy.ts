export function isLiveReplayOwner(replay: { hostId: string }, userId: string) {
  return replay.hostId === userId;
}

export function isLiveReplayUploadRetry(
  replay: { hostId: string; status: string; mediaUrl: string },
  userId: string,
  mediaUrl: string,
) {
  return isLiveReplayOwner(replay, userId)
    && ['READY', 'PUBLISHED'].includes(replay.status)
    && replay.mediaUrl === mediaUrl;
}

export function canDeleteLiveReplayMedia(
  replayStatus: string,
  media: { contentType: string; ownerUserId: string | null } | null,
  userId: string,
) {
  if (!media) return replayStatus === 'DELETING';
  return media.ownerUserId === userId && media.contentType.startsWith('video/');
}
