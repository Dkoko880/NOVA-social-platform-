export function isLiveReplayOwner(replay: { hostId: string }, userId: string) {
  return replay.hostId === userId;
}

export function canDeleteLiveReplayMedia(
  replayStatus: string,
  media: { contentType: string; ownerUserId: string | null } | null,
  userId: string,
) {
  if (!media) return replayStatus === 'DELETING';
  return media.ownerUserId === userId && media.contentType.startsWith('video/');
}
