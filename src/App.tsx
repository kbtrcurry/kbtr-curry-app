import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'
import { GoogleOAuthProvider } from '@react-oauth/google'
import { AuthProvider } from './lib/auth'
import PosPage from './pages/PosPage'
import DashboardPage from './pages/DashboardPage'
import IngredientsPage from './pages/IngredientsPage'
import CostPage from './pages/CostPage'
import MenuSettingsPage from './pages/MenuSettingsPage'
import './index.css'

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? ''

const NAV_ITEMS = [
  { to: '/', label: 'レジ', icon: '🛒' },
  { to: '/dashboard', label: '売上', icon: '📊' },
  { to: '/ingredients', label: '食材', icon: '🥬' },
  { to: '/cost', label: '原価', icon: '💴' },
  { to: '/menu', label: '設定', icon: '⚙️' },
]

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col min-h-svh max-w-lg mx-auto bg-white shadow-sm">
      <main className="flex-1 overflow-y-auto pb-20">{children}</main>
      <nav className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-lg bg-white border-t border-stone-200 flex">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              `flex-1 flex flex-col items-center py-2 text-xs gap-0.5 transition-colors ${
                isActive ? 'text-amber-700 font-semibold' : 'text-stone-400'
              }`
            }
          >
            <span className="text-xl">{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}

export default function App() {
  return (
    <GoogleOAuthProvider clientId={CLIENT_ID}>
      <AuthProvider>
        <BrowserRouter basename="/kbtr-curry-app">
          <Layout>
            <Routes>
              <Route path="/" element={<PosPage />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/ingredients" element={<IngredientsPage />} />
              <Route path="/cost" element={<CostPage />} />
              <Route path="/menu" element={<MenuSettingsPage />} />
            </Routes>
          </Layout>
        </BrowserRouter>
      </AuthProvider>
    </GoogleOAuthProvider>
  )
}
