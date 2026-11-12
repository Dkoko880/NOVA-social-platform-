const CACHE_NAME = 'novachat-shell-v3'
const SHELL_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.ico',
  '/favicon-32.png',
  '/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
  '/audio/voice-call-ringtone.wav',
  '/audio/video-call-ringtone.wav',
]

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
  )
  self.clients.claim()
})

self.addEventListener('push', (event) => {
  let payload
  try {
    payload = event.data?.json()
  } catch {
    return
  }
  if (!payload || payload.type !== 'incoming-call' || typeof payload.callId !== 'string') return

  const callerName = typeof payload.callerName === 'string' ? payload.callerName : 'NOVACHAT member'
  const callType = payload.callType === 'video' ? 'video' : 'voice'
  const icon = typeof payload.callerAvatar === 'string' && payload.callerAvatar.startsWith('https://')
    ? payload.callerAvatar
    : '/icons/icon-192.png'
  event.waitUntil(self.registration.showNotification(
    `Incoming ${callType} call`,
    {
      body: `${callerName} is calling you.`,
      tag: `novachat-call-${payload.callId}`,
      icon,
      data: { callId: payload.callId },
      actions: [{ action: 'accept', title: 'Accept' }, { action: 'reject', title: 'Reject' }],
    },
  ))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const callId = event.notification.data?.callId
  const action = event.action
  const target = callId && ['accept', 'reject'].includes(action)
    ? `/?call=${encodeURIComponent(callId)}&callAction=${action}`
    : '/'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
      const client = clients[0]
      if (client) {
        await client.navigate(target)
        await client.focus()
      } else {
        await self.clients.openWindow(target)
      }
    }),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) void caches.open(CACHE_NAME).then((cache) => cache.put('/index.html', response.clone()))
          return response
        })
        .catch(async () => (await caches.match(request)) || (await caches.match('/index.html')) || Response.error()),
    )
    return
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached
        return fetch(request).then((response) => {
          if (response.ok) void caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()))
          return response
        })
      }),
    )
  }
})
