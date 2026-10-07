import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { getCurrentUser, loginUser, logoutUser, registerUser, type AuthUser, type RegisterInput } from '../lib/auth'

type AuthContextValue = {
  user: AuthUser | null
  isLoading: boolean
  isAuthenticated: boolean
  authError: string | null
  login: (identifier: string, password: string) => Promise<AuthUser>
  register: (input: RegisterInput) => Promise<AuthUser>
  logout: () => Promise<void>
  refreshCurrentUser: () => Promise<AuthUser | null>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [authError, setAuthError] = useState<string | null>(null)

  const refreshCurrentUser = useCallback(async () => {
    setIsLoading(true)
    setAuthError(null)

    try {
      const nextUser = await getCurrentUser()
      setUser(nextUser)
      return nextUser
    } catch (error) {
      setUser(null)
      setAuthError(error instanceof Error ? error.message : 'Unable to verify your session.')
      throw error
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshCurrentUser().catch((error: unknown) => {
      setAuthError(error instanceof Error ? error.message : 'Unable to verify your session.')
    })
  }, [refreshCurrentUser])

  const login = useCallback(async (identifier: string, password: string) => {
    setAuthError(null)
    const response = await loginUser({ identifier, password })
    setUser(response.user)
    setIsLoading(false)
    return response.user
  }, [])

  const register = useCallback(async (input: RegisterInput) => {
    setAuthError(null)
    const response = await registerUser(input)
    setUser(response.user)
    setIsLoading(false)
    return response.user
  }, [])

  const logout = useCallback(async () => {
    await logoutUser()
    setUser(null)
    setAuthError(null)
    setIsLoading(false)
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isLoading,
      isAuthenticated: Boolean(user),
      authError,
      login,
      register,
      logout,
      refreshCurrentUser,
    }),
    [user, isLoading, authError, login, register, logout, refreshCurrentUser],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)

  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }

  return context
}
