import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from 'react'
import { useGoogleLogin } from '@react-oauth/google'

const TOKEN_KEY = 'kbtr_access_token'
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets'

type AuthCtx = {
  token: string | null
  login: () => void
  logout: () => void
}

const Ctx = createContext<AuthCtx | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() =>
    localStorage.getItem(TOKEN_KEY),
  )

  const googleLogin = useGoogleLogin({
    scope: SCOPE,
    onSuccess: (resp) => {
      setToken(resp.access_token)
      localStorage.setItem(TOKEN_KEY, resp.access_token)
    },
    onError: () => {
      alert('ログインに失敗しました。もう一度お試しください。')
    },
  })

  const logout = useCallback(() => {
    setToken(null)
    localStorage.removeItem(TOKEN_KEY)
  }, [])

  const login = useCallback(() => googleLogin(), [googleLogin])

  return (
    <Ctx.Provider value={{ token, login, logout }}>{children}</Ctx.Provider>
  )
}

export function useAuth() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useAuth must be used within AuthProvider')
  return c
}
