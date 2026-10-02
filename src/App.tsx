import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { AuthProvider, useAuth } from './context/AuthContext'
import { CommunitiesPage } from './pages/CommunitiesPage'
import { CreatePage } from './pages/CreatePage'
import { ExplorePage } from './pages/ExplorePage'
import { HomePage } from './pages/HomePage'
import { MessagesPage } from './pages/MessagesPage'
import { NotificationsPage } from './pages/NotificationsPage'
import { ProfilePage } from './pages/ProfilePage'
import { SettingsPage } from './pages/SettingsPage'
import { AuthPage } from './pages/AuthPage'
import { AdminPage } from './pages/AdminPage'
import { DownloadPage } from './pages/DownloadPage'
import { LivePage } from './pages/LivePage'
import { CallsPage } from './pages/CallsPage'
import { AiPage } from './pages/AiPage'

function PublicRoute() {
  const { isAuthenticated, isLoading } = useAuth()

  if (isLoading) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm font-medium text-slate-600">Loading...</div>
  }

  if (isAuthenticated) {
    return <Navigate to="/" replace />
  }

  return <Outlet />
}

function ProtectedRoute() {
  const { isAuthenticated, isLoading } = useAuth()

  if (isLoading) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm font-medium text-slate-600">Loading...</div>
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  return <Outlet />
}

function AdminRoute() {
  const { isAuthenticated, isLoading, user } = useAuth()

  if (isLoading) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm font-medium text-slate-600">Loading...</div>
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />
  }

  if (!['ADMIN', 'SUPER_ADMIN', 'MODERATOR'].includes(user?.role ?? 'USER')) {
    return <Navigate to="/" replace />
  }

  return <Outlet />
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/download" element={<DownloadPage />} />
      <Route element={<PublicRoute />}>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/register" element={<AuthPage mode="register" />} />
      </Route>

      <Route element={<ProtectedRoute />}>
        <Route path="/" element={<AppShell><HomePage /></AppShell>} />
        <Route path="/explore" element={<AppShell><ExplorePage /></AppShell>} />
        <Route path="/create" element={<AppShell><CreatePage /></AppShell>} />
        <Route path="/notifications" element={<AppShell><NotificationsPage /></AppShell>} />
        <Route path="/messages" element={<AppShell><MessagesPage /></AppShell>} />
        <Route path="/live" element={<AppShell><LivePage /></AppShell>} />
        <Route path="/calls" element={<AppShell><CallsPage /></AppShell>} />
        <Route path="/ai" element={<AppShell><AiPage /></AppShell>} />
        <Route path="/communities" element={<AppShell><CommunitiesPage /></AppShell>} />
        <Route path="/profile" element={<AppShell><ProfilePage /></AppShell>} />
        <Route path="/profile/:id" element={<AppShell><ProfilePage /></AppShell>} />
        <Route path="/settings" element={<AppShell><SettingsPage /></AppShell>} />

        <Route element={<AdminRoute />}>
          <Route path="/admin" element={<AppShell><AdminPage /></AppShell>} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  )
}

export default App
