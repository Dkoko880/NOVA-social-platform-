import { clearStoredAccessToken, getStoredAccessToken } from './session'

const productionApiBaseUrl = 'https://nova-social-platform-api.onrender.com'
const configuredApiBaseUrl = import.meta.env.PROD
  ? ''
  : import.meta.env.VITE_API_BASE_URL?.trim() || productionApiBaseUrl

export const API_BASE_URL = configuredApiBaseUrl.replace(/\/$/, '')

export function resolveMediaUrl(url: string | null | undefined) {
  if (!url) return '';
  return url.startsWith('/api/media/') ? `${API_BASE_URL}${url}` : url;
}

export async function uploadMedia(file: File) {
  const body = new FormData();
  body.append('file', file);
  return apiRequest<{ mediaUrl: string; contentType: string }>('/api/media/uploads', {
    method: 'POST',
    body,
  });
}

export class ApiError extends Error {
  status: number | null
  details?: unknown
  code: ApiErrorCode

  constructor(status: number | null, message: string, details?: unknown, code?: ApiErrorCode) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.details = details
    this.code = code ?? (
      status === 401 || status === 403
        ? 'AUTH_ERROR'
        : status === 429
          ? 'RATE_LIMITED'
          : status !== null && status >= 500
            ? 'SERVER_ERROR'
            : 'API_ERROR'
    )
  }
}

export type ApiErrorCode = 'NETWORK_ERROR' | 'TIMEOUT' | 'AUTH_ERROR' | 'RATE_LIMITED' | 'SERVER_ERROR' | 'API_ERROR'

function isAbortError(error: unknown) {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function createTransportError(code: 'NETWORK_ERROR' | 'TIMEOUT') {
  const message = code === 'TIMEOUT'
    ? 'The NOVAKOKO API request timed out. Please try again shortly.'
    : 'Unable to reach the NOVAKOKO API. Check your connection and try again shortly.'
  return new ApiError(null, message, undefined, code)
}

function extractErrorMessage(payload: unknown, fallback: string) {
  if (typeof payload !== 'object' || payload === null) {
    return fallback
  }

  const data = payload as { message?: unknown; error?: unknown; detail?: unknown; errors?: unknown }

  for (const message of [data.message, data.error, data.detail]) {
    if (typeof message === 'string' && message.trim()) {
      return message
    }
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
  const isSafeRead = (options.method ?? 'GET').toUpperCase() === 'GET'
  const maxAttempts = isSafeRead ? 3 : 1
  const isCredentialSubmission = path === '/api/auth/login' || path === '/api/auth/register'
  const accessToken = isCredentialSubmission ? null : getStoredAccessToken()

  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`)
  } else {
    headers.delete('Authorization')
  }

  let response: Response | undefined
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController()
    let timedOut = false
    const timeoutId = setTimeout(() => {
      timedOut = true
      controller.abort(new DOMException('The request timed out.', 'TimeoutError'))
    }, 15000)
    const abortFromRequest = () => controller.abort(options.signal?.reason)

    if (options.signal?.aborted) {
      abortFromRequest()
    } else {
      options.signal?.addEventListener('abort', abortFromRequest, { once: true })
    }

    try {
      response = await fetch(`${API_BASE_URL}${path}`, {
        ...options,
        credentials: 'include',
        headers,
        signal: controller.signal,
      })
    } catch (error) {
      const callerAborted = options.signal?.aborted ?? false
      const isTimeout = timedOut || (!callerAborted && isAbortError(error))
      const isNetworkError = error instanceof TypeError
      const shouldRetry = isSafeRead
        && !callerAborted
        && attempt < maxAttempts - 1
        && (isTimeout || isNetworkError)

      if (shouldRetry) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
        continue
      }

      if (isTimeout) {
        throw createTransportError('TIMEOUT')
      }
      if (callerAborted) {
        throw error
      }
      if (isNetworkError) {
        throw createTransportError('NETWORK_ERROR')
      }
      throw error
    } finally {
      clearTimeout(timeoutId)
      options.signal?.removeEventListener('abort', abortFromRequest)
    }

    if (isSafeRead && [502, 503, 504].includes(response.status) && attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)))
      continue
    }

    break
  }

  if (!response) {
    throw createTransportError('NETWORK_ERROR')
  }

  const rawText = await response.text()
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? ''
  const hasJsonContentType = contentType === 'application/json' || contentType.endsWith('+json')
  let payload: unknown
  try {
    payload = rawText ? JSON.parse(rawText) : undefined
  } catch {
    if (response.ok) {
      throw new ApiError(response.status, 'The NOVAKOKO API returned an invalid response.')
    }
    payload = { contentType: contentType || null, body: rawText }
  }

  if (!response.ok) {
    if (response.status === 401) {
      clearStoredAccessToken()
    }
    const fallback = !hasJsonContentType
      ? `The NOVAKOKO API returned HTTP ${response.status} with ${contentType || 'an unlabelled'} content instead of JSON.`
      : response.status === 429
        ? 'The NOVAKOKO API is rate limiting requests (HTTP 429). Please wait and try again.'
        : response.status >= 500
          ? `The NOVAKOKO API is temporarily unavailable (HTTP ${response.status}). Please try again shortly.`
          : `The NOVAKOKO API request failed with HTTP ${response.status}.`
    throw new ApiError(response.status, extractErrorMessage(payload, fallback), payload)
  }

  return payload as T
}
