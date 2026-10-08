import type { AuthUser } from './auth'

export type AuthSessionState = {
  user: AuthUser | null
  isLoading: boolean
  authError: string | null
}

export type AuthSessionAction =
  | { type: 'verification-started' }
  | { type: 'verification-succeeded'; user: AuthUser | null }
  | { type: 'verification-failed'; message: string }
  | { type: 'authenticated'; user: AuthUser }
  | { type: 'logged-out' }
  | { type: 'clear-error' }

export const initialAuthSessionState: AuthSessionState = {
  user: null,
  isLoading: true,
  authError: null,
}

export function authSessionReducer(state: AuthSessionState, action: AuthSessionAction): AuthSessionState {
  switch (action.type) {
    case 'verification-started':
      return { ...state, isLoading: true, authError: null }
    case 'verification-succeeded':
      return { user: action.user, isLoading: false, authError: null }
    case 'verification-failed':
      return {
        ...state,
        isLoading: false,
        authError: action.message,
      }
    case 'authenticated':
      return { user: action.user, isLoading: false, authError: null }
    case 'logged-out':
      return { user: null, isLoading: false, authError: null }
    case 'clear-error':
      return { ...state, authError: null }
  }
}
