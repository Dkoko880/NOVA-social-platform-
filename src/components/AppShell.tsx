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
  { label: 'Live', path: '/live', icon: Radio },
  { label: 'Messages', path: '/messages', icon: MessageCircleMore },
  { label: 'Calls', path: '/calls', icon: Phone },
  { label: 'Groups', path: '/communities', icon: UsersRound },
  { label: 'AI Studio', path: '/ai', icon: Sparkles },
  { label: 'Profile', path: '/profile', icon: UserRound },
  { label: 'Settings', path: '/settings', icon: Settings },
  { label: 'Create', path: '/create', icon: PlusSquare },
  { label: 'Notifications', path: '/notifications', icon: Bell },
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
        <aside className="hidden w-[250px] shrink-0 rounded-[28px] border border-white/80 bg-white/85 p-4 shadow-[0_20px_70px_-42px_rgba(48,37,116,.32)] backdrop-blur lg:flex lg:flex-col">
          <div className="mb-8 flex items-center gap-3 px-2">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-600 via-violet-600 to-fuchsia-500 text-lg font-black text-white shadow-lg shadow-violet-200">
              N
            </div>
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.2em] text-indigo-700">NOVAKOKO</p>
              <p className="text-xs text-slate-500">Your world, closer</p>
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
                    isActive ? 'bg-indigo-50 text-indigo-700 ring-1 ring-indigo-100' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
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

          <div className="mt-auto rounded-3xl border border-indigo-100 bg-gradient-to-r from-indigo-50 to-violet-50 p-4">
            <div className="flex items-center gap-3">
              <Avatar src={userAvatar} alt={userName} size="sm" />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-900">{userName}</p>
                <p className="truncate text-xs text-slate-500">{userHandle}</p>
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              className="mt-4 w-full justify-center text-slate-700"
              icon={<LogOut className="h-4 w-4" aria-hidden="true" />}
              onClick={handleLogout}
              disabled={isLoading}
            >
              Log out
            </Button>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-[calc(100vh-2rem)] overflow-hidden rounded-[28px] border border-white/80 bg-white/90 shadow-[0_20px_70px_-42px_rgba(48,37,116,.32)] backdrop-blur">
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
    <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3 sm:px-6">
      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.24em] text-indigo-600">NOVAKOKO</p>
        <h1 className="text-xl font-semibold text-slate-900">{labels[currentPath] ?? (currentPath.startsWith('/profile/') ? 'Profile' : 'NOVAKOKO')}</h1>
      </div>
      <div className="flex items-center gap-2">
        <Link to="/explore" className="hidden rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 sm:inline-flex">Find people</Link>
        <Link to="/create" className="inline-flex items-center rounded-full bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700">+ Create</Link>
      </div>
    </header>
  )
}

function MobileNavigation() {
  const { user } = useAuth()
  const mobilePaths = ['/', '/messages', '/live', '/calls', '/communities', '/profile', '/settings', '/explore', '/ai', '/notifications']
  const mobileItems = sidebarItems.filter(({ path }) => mobilePaths.includes(path))
  if (['ADMIN', 'SUPER_ADMIN', 'MODERATOR'].includes(user?.role ?? 'USER')) {
    mobileItems.push({ label: 'Admin', path: '/admin', icon: BriefcaseBusiness })
  }

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-indigo-100/80 bg-white/95 px-2 pb-[max(0.35rem,env(safe-area-inset-bottom))] pt-1.5 backdrop-blur-xl lg:hidden">
      <div className="mx-auto grid max-w-lg grid-cols-5 gap-1">
        {mobileItems.map(({ label, path, icon: Icon }) => (
          <NavLink
            key={path}
            to={path}
            className={({ isActive }) =>
              cn(
                'flex min-h-9 flex-col items-center justify-center gap-0.5 rounded-xl px-1 py-1 text-[10px] font-medium transition-colors',
                isActive ? 'bg-indigo-50 text-indigo-700' : 'text-slate-500 hover:text-slate-900',
              )
            }
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            <span>{label}</span>
          </NavLink>
        ))}
      </div>
    </nav>
  )
}
