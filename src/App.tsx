// build:20260605-v4
import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, NavLink, Link } from 'react-router-dom'
import { GoogleOAuthProvider } from '@react-oauth/google'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { AuthProvider, useAuth } from './lib/auth'
import { SwipeNav } from './components/SwipeNav'
import { BackHandlerProvider } from './lib/backHandler'
import { preloadAll } from './lib/preload'
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
  { to: '/prep', label: '仕込み', icon: '🍳' },
  { to: '/menu', label: '設定', icon: '⚙️' },
]
const BOTTOM_NAV = NAV_ITEMS.slice(0, 5)

function UpdateButton() {
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW()

  return (
    <button
      onClick={() => needRefresh ? updateServiceWorker(true) : window.location.reload()}
      title={needRefresh ? '新しいバージョンがあります。タップして更新' : `v${__APP_VERSION__} — タップで再読み込み`}
      className={`text-xl leading-none transition-transform active:scale-90 ${needRefresh ? 'animate-bounce' : ''}`}
    >
      🍛
    </button>
  )
}

// ログイン後、全画面ぶんのデータを先読みしてキャッシュを温める
function Preloader() {
  const { token } = useAuth()
  useEffect(() => {
    if (token) preloadAll(token)
  }, [token])
  return null
}

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-svh md:flex">
      {/* モバイルヘッダー */}
      <header className="md:hidden flex items-center gap-2 px-4 py-3 border-b border-stone-200 bg-stone-900">
        <UpdateButton />
        <span className="text-base font-bold text-amber-800">コバタロカレー</span>
        <span className="text-xs text-stone-400">v{__APP_VERSION__}.{__BUILD_DATE__}</span>
        <Link to="/menu" className="ml-auto text-xl text-stone-400">⚙️</Link>
      </header>

      {/* サイドバー（タブレット・デスクトップ） */}
      <aside className="hidden md:flex md:flex-col md:w-52 lg:w-60 shrink-0 border-r border-stone-200 sticky top-0 h-svh">
        <div className="px-4 py-4 text-lg font-bold text-amber-800 flex items-center gap-2">
          <UpdateButton />
          コバタロカレー
          <span className="text-xs font-normal text-stone-400">v{__APP_VERSION__}</span>
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
      <main className="flex-1 min-w-0 pb-24 md:pb-10">{children}</main>

      {/* ボトムナビ（モバイル） */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-stone-200 flex z-40">
        {BOTTOM_NAV.map((item) => (
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
          <Preloader />
          <BackHandlerProvider>
          <Layout>
            <SwipeNav>
              <div className="mx-auto w-full max-w-screen-sm lg:max-w-3xl">
                <Routes>
                  <Route path="/" element={<PosPage />} />
                  <Route path="/dashboard" element={<DashboardPage />} />
                  <Route path="/ingredients" element={<IngredientsPage />} />
                  <Route path="/recipe" element={<RecipePage />} />
                  <Route path="/prep" element={<PrepPage />} />
                  <Route path="/menu" element={<MenuSettingsPage />} />
                </Routes>
              </div>
            </SwipeNav>
          </Layout>
          </BackHandlerProvider>
        </BrowserRouter>
      </AuthProvider>
    </GoogleOAuthProvider>
  )
}
