const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? 'https://nova-social-platform-api.onrender.com'

if (import.meta.env.PROD && !configuredApiBaseUrl) {
  throw new Error('VITE_API_BASE_URL must be configured for production frontend builds.')
}

export const API_BASE_URL = configuredApiBaseUrl.replace(/\/$/, '')

export class ApiError extends Error {
  status: number
  details?: unknown

  constructor(status: number, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.details = details
  }
}

function extractErrorMessage(payload: unknown, fallback: string) {
  if (typeof payload !== 'object' || payload === null) {
    return fallback
  }

  const data = payload as { message?: unknown; errors?: unknown }

  if (typeof data.message === 'string' && data.message.trim()) {
    return data.message
  }

  if (data.errors && typeof data.errors === 'object') {
    const errorEntries = Object.values(data.errors as Record<string, unknown>)
    const flattened = errorEntries.find((value) => {
      if (Array.isArray(value)) {
        return value.some((item) => typeof item === 'string' && item.trim())
      }

      return typeof value === 'string' && value.trim()
    })

    if (Array.isArray(flattened)) {
      const message = flattened.find((item) => typeof item === 'string' && item.trim())
      if (typeof message === 'string') {
        return message
      }
    }

    if (typeof flattened === 'string' && flattened.trim()) {
      return flattened
    }
  }

  return fallback
}

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)

  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
      signal: AbortSignal.timeout(15000),
    ...options,
    credentials: 'include',
    headers,
  })

  const rawText = await response.text()
  let payload: unknown = {}
  try {
    payload = rawText ? JSON.parse(rawText) : {}
  } catch {
    payload = {}
  }

  if (!response.ok) {
    throw new ApiError(response.status, extractErrorMessage(payload, 'Something went wrong. Please try again.'), payload)
  }

  return payload as T
}
