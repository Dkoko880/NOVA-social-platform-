import { useState } from 'react'
import type { ReactNode } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import {
  Bell,
  Compass,
  House,
  LogOut,
  MessageCircleMore,
  PlusSquare,
  Settings,
  UserRound,
  BriefcaseBusiness,
  Radio,
  Phone,
  Sparkles,
  UsersRound,
} from 'lucide-react'
import { Avatar } from './ui/Avatar'
import { cn } from '../utils/cn'
import { Button } from './ui/Button'
import { useAuth } from '../context/AuthContext'

type AppShellProps = {
  children: ReactNode
}

export const sidebarItems = [
  { label: 'Home', path: '/', icon: House },
  { label: 'Explore', path: '/explore', icon: Compass },
  { label: 'Messages', path: '/messages', icon: MessageCircleMore },
  { label: 'Calls', path: '/calls', icon: Phone },
  { label: 'Groups', path: '/communities', icon: UsersRound },
  { label: 'Live', path: '/live', icon: Radio },
  { label: 'Create', path: '/create', icon: PlusSquare },
  { label: 'Notifications', path: '/notifications', icon: Bell },
  { label: 'Profile', path: '/profile', icon: UserRound },
  { label: 'Settings', path: '/settings', icon: Settings },
  { label: 'AI Studio', path: '/ai', icon: Sparkles },
]

export function AppShell({ children }: AppShellProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const { user, logout, isLoading } = useAuth()
  const canAccessAdmin = ['ADMIN', 'SUPER_ADMIN', 'MODERATOR'].includes(user?.role ?? 'USER')
  const navItems = canAccessAdmin
    ? [...sidebarItems, { label: 'Admin', path: '/admin', icon: BriefcaseBusiness }]
    : sidebarItems

  const handleLogout = async () => {
    try {
      await logout()
      navigate('/login', { replace: true })
    } catch {
      navigate('/login', { replace: true })
    }
  }

  const userName = user?.name ?? 'NOVAKOKO User'
  const userHandle = user?.email ?? 'member@novakoko.com'
  const userAvatar = `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(userName)}`

  return (
    <div className="min-h-screen text-slate-900">
      <div className="mx-auto flex min-h-screen max-w-[1600px] gap-4 p-3 pb-32 sm:p-4 lg:gap-6 lg:pb-4">
        <aside className="hidden w-[250px] shrink-0 rounded-[28px] border border-blue-950 bg-gradient-to-b from-[#101d46] via-[#15285d] to-[#1b2862] p-4 text-white shadow-[0_24px_70px_-32px_rgba(18,35,87,.65)] lg:flex lg:flex-col">
          <div className="mb-8 flex items-center gap-3 px-2">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-400 via-blue-500 to-violet-500 text-lg font-black text-white shadow-lg shadow-blue-950/40">
              N
            </div>
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.2em] text-sky-200">NOVAKOKO</p>
              <p className="text-xs text-blue-100/65">Your world, closer</p>
            </div>
          </div>

          <nav className="space-y-1">
            {navItems.map(({ label, path, icon: Icon }) => (
              <NavLink
                key={path}
                to={path}
                className={({ isActive }) =>
                  cn(
                    'group flex items-center justify-between rounded-2xl px-3 py-3 text-sm font-medium transition-colors',
                    isActive ? 'bg-white/15 text-white ring-1 ring-white/15' : 'text-blue-100/75 hover:bg-white/10 hover:text-white',
                  )
                }
              >
                <span className="flex items-center gap-3">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {label}
                </span>
              </NavLink>
            ))}
          </nav>

          <div className="mt-auto rounded-3xl border border-white/10 bg-white/10 p-4">
            <div className="flex items-center gap-3">
              <Avatar src={userAvatar} alt={userName} size="sm" />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-white">{userName}</p>
                <p className="truncate text-xs text-blue-100/65">{userHandle}</p>
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              className="mt-4 w-full justify-center text-blue-50 hover:bg-white/10"
              icon={<LogOut className="h-4 w-4" aria-hidden="true" />}
              onClick={handleLogout}
              disabled={isLoading}
            >
              Log out
            </Button>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-[calc(100vh-2rem)] overflow-hidden rounded-[28px] border border-white/80 bg-white/95 shadow-[0_20px_70px_-42px_rgba(18,35,87,.38)] backdrop-blur">
            <TopBar currentPath={location.pathname} />
            <div>{children}</div>
          </div>
        </main>

      </div>

      <MobileNavigation />
    </div>
  )
}

type TopBarProps = {
  currentPath: string
}

function TopBar({ currentPath }: TopBarProps) {
  const labels: Record<string, string> = {
    '/': 'Home',
    '/explore': 'Explore',
    '/create': 'Create',
    '/notifications': 'Notifications',
    '/messages': 'Messages',
    '/live': 'Live rooms',
    '/calls': 'Calls',
    '/ai': 'AI Studio',
    '/communities': 'Communities',
    '/profile': 'Profile',
    '/settings': 'Settings',
    '/admin': 'Admin Dashboard',
    '/login': 'Login',
    '/register': 'Register',
  }

  return (
    <header className="sticky top-0 z-20 flex items-center justify-between border-b border-blue-100 bg-white/95 px-4 py-3 backdrop-blur sm:px-6">
      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-blue-700">NOVAKOKO</p>
        <h1 className="text-xl font-semibold text-slate-900">{labels[currentPath] ?? (currentPath.startsWith('/profile/') ? 'Profile' : 'NOVAKOKO')}</h1>
      </div>
      <div className="flex items-center gap-2">
        <Link to="/explore" className="hidden rounded-xl border border-blue-100 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-blue-50 sm:inline-flex">Find people</Link>
        <Link to="/create" className="inline-flex items-center rounded-full bg-gradient-to-r from-blue-600 to-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:from-blue-700 hover:to-indigo-700">+ Create</Link>
      </div>
    </header>
  )
}

function MobileNavigation() {
  const { user, logout, isLoading } = useAuth()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)

  const mobilePaths = ['/', '/explore', '/create', '/messages', '/profile']
  const mobileItems = sidebarItems.filter(({ path }) => mobilePaths.includes(path))

  if (['ADMIN', 'SUPER_ADMIN', 'MODERATOR'].includes(user?.role ?? 'USER')) {
    mobileItems.push({ label: 'Admin', path: '/admin', icon: BriefcaseBusiness })
  }

  const handleMobileLogout = async () => {
    try {
      await logout()
    } finally {
      navigate('/login', { replace: true })
    }
  }

  return (
    <>
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-indigo-100/80 bg-white/95 px-2 pb-[max(0.35rem,env(safe-area-inset-bottom))] pt-1.5 backdrop-blur-xl lg:hidden">
        <div className="mx-auto grid max-w-lg grid-cols-5 gap-1">
          {mobileItems.map(({ label, path, icon: Icon }) => (
            <NavLink
              key={path}
              to={path}
              className={({ isActive }) =>
                cn(
                  'flex min-h-9 flex-col items-center justify-center gap-0.5 rounded-xl px-1 py-1 text-[10px] font-medium transition-colors',
                  isActive ? 'bg-blue-50 text-blue-700' : 'text-slate-500 hover:text-slate-900',
                )
              }
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              <span>{label}</span>
            </NavLink>
          ))}
        </div>

        <div className="mx-auto mt-2 flex max-w-lg items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            className="rounded-xl px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-blue-50"
          >
            Settings & Account
          </button>
        </div>
      </nav>

      {menuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true">
          <button
            type="button"
            className="absolute inset-0 bg-slate-950/40"
            aria-label="Close account menu"
            onClick={() => setMenuOpen(false)}
          />
          <div className="absolute inset-x-3 bottom-24 rounded-3xl bg-white p-4 shadow-2xl">
            <NavLink
              to="/settings"
              onClick={() => setMenuOpen(false)}
              className="flex items-center gap-3 rounded-2xl px-4 py-3 font-semibold text-slate-700 hover:bg-blue-50"
            >
              <Settings className="h-5 w-5" aria-hidden="true" />
              Settings
            </NavLink>

            <button
              type="button"
              onClick={handleMobileLogout}
              disabled={isLoading}
              className="mt-1 flex w-full items-center gap-3 rounded-2xl px-4 py-3 font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              <LogOut className="h-5 w-5" aria-hidden="true" />
              Log out
            </button>
          </div>
        </div>
      )}
    </>
  )
}
