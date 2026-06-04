import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom'
import { GoogleOAuthProvider } from '@react-oauth/google'
import { AuthProvider } from './lib/auth'
import PosPage from './pages/PosPage'
import DashboardPage from './pages/DashboardPage'
import IngredientsPage from './pages/IngredientsPage'
import RecipePage from './pages/RecipePage'
import PrepPage from './pages/PrepPage'
import MenuSettingsPage from './pages/MenuSettingsPage'
import './index.css'

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? ''

const NAV_ITEMS = [
  { to: '/', label: 'レジ', icon: '🛒' },
  { to: '/dashboard', label: '売上', icon: '📊' },
  { to: '/ingredients', label: '食材', icon: '🥬' },
  { to: '/recipe', label: 'レシピ', icon: '📖' },
  { to: '/prep', label: '仕込', icon: '🍳' },
  { to: '/menu', label: '設定', icon: '⚙️' },
]

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-svh md:flex">
      {/* サイドバー（タブレット・デスクトップ） */}
      <aside className="hidden md:flex md:flex-col md:w-52 lg:w-60 shrink-0 border-r border-stone-200 sticky top-0 h-svh">
        <div className="px-4 py-4 text-lg font-bold text-amber-800">
          🍛 コバタロカレー
        </div>
        <nav className="flex-1 px-2 space-y-1 overflow-y-auto">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                  isActive
                    ? 'bg-amber-100 text-amber-800 font-semibold'
                    : 'text-stone-600 hover:bg-stone-100'
                }`
              }
            >
              <span className="text-xl">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      {/* メイン */}
      <main className="flex-1 min-w-0 pb-24 md:pb-10">
        <div className="mx-auto w-full max-w-screen-sm lg:max-w-3xl">{children}</div>
      </main>

      {/* ボトムナビ（モバイル） */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-stone-200 flex z-40">
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
              <Route path="/recipe" element={<RecipePage />} />
              <Route path="/prep" element={<PrepPage />} />
              <Route path="/menu" element={<MenuSettingsPage />} />
            </Routes>
          </Layout>
        </BrowserRouter>
      </AuthProvider>
    </GoogleOAuthProvider>
  )
}
