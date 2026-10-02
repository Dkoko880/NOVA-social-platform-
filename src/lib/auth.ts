import { apiRequest, ApiError } from './api'

export type AuthUser = {
  id: string
  email: string | null
  phoneE164?: string | null
  username?: string | null
  name: string
  role?: string
  status?: string
  createdAt?: string
  updatedAt?: string
}

export type AuthResponse = {
  user: AuthUser
  token?: string
  message?: string
}

export type RegisterInput = {
  name: string
  email: string
  password: string
  communityRulesAccepted: boolean
}

export type LoginInput = {
  email: string
  password: string
}

export async function registerUser(input: RegisterInput) {
  return apiRequest<AuthResponse>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function loginUser(input: LoginInput) {
  return apiRequest<AuthResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export async function logoutUser() {
  return apiRequest<{ message: string }>('/api/auth/logout', {
    method: 'POST',
  })
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  try {
    const response = await apiRequest<{ user: AuthUser }>('/api/auth/me')
    return response.user ?? null
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      return null
    }

    throw error
  }
}
