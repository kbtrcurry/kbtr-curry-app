import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../lib/auth'
import { readRange, appendRows, AuthExpiredError } from '../lib/sheets'

type Menu = { name: string; price: number; recipe: string }

const DISABLED_FLAGS = ['off', 'false', '無効', 'no', '0']

function todayStr(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export default function PosPage() {
  const { token, login, logout } = useAuth()
  const [menus, setMenus] = useState<Menu[]>([])
  const [qty, setQty] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 締めモーダル
  const [closing, setClosing] = useState(false)
  const [locationFee, setLocationFee] = useState('')
  const [memo, setMemo] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)

  const handleAuthError = useCallback(
    (e: unknown) => {
      if (e instanceof AuthExpiredError) {
        logout()
        setError('認証の有効期限が切れました。再度ログインしてください。')
      } else {
        setError(e instanceof Error ? e.message : '読み込みに失敗しました')
      }
    },
    [logout],
  )

  const loadMenus = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError(null)
    try {
      const rows = await readRange(token, 'メニュー構成!A2:D')
      const parsed: Menu[] = rows
        .filter((r) => r[0]?.trim())
        .filter((r) => !DISABLED_FLAGS.includes((r[3] ?? '').trim().toLowerCase()))
        .map((r) => ({
          name: r[0].trim(),
          price: Number(r[1]) || 0,
          recipe: (r[2] ?? '').trim(),
        }))
      setMenus(parsed)
    } catch (e) {
      handleAuthError(e)
    } finally {
      setLoading(false)
    }
  }, [token, handleAuthError])

  useEffect(() => {
    loadMenus()
  }, [loadMenus])

  const setCount = (name: string, delta: number) => {
    setQty((prev) => {
      const next = Math.max(0, (prev[name] ?? 0) + delta)
      return { ...prev, [name]: next }
    })
  }

  const total = menus.reduce((s, m) => s + m.price * (qty[m.name] ?? 0), 0)
  const itemCount = menus.reduce((s, m) => s + (qty[m.name] ?? 0), 0)

  const handleClose = async () => {
    if (!token) return
    const orders = menus.filter((m) => (qty[m.name] ?? 0) > 0)
    if (orders.length === 0) return
    setSubmitting(true)
    setError(null)
    try {
      const date = todayStr()
      const fee = Number(locationFee) || 0
      const salesRows = orders.map((m) => [
        date,
        m.name,
        qty[m.name],
        m.price,
        m.price * qty[m.name],
      ])
      await appendRows(token, '営業記録!A:E', salesRows)
      await appendRows(token, '営業サマリー!A:G', [
        [date, total, 0, fee, total - fee, '', memo],
      ])
      // リセット
      setQty({})
      setLocationFee('')
      setMemo('')
      setClosing(false)
      setDone(true)
      setTimeout(() => setDone(false), 3000)
    } catch (e) {
      handleAuthError(e)
      setClosing(false)
    } finally {
      setSubmitting(false)
    }
  }

  // ── 未ログイン ──────────────────────────────────
  if (!token) {
    return (
      <div className="p-6 flex flex-col items-center justify-center min-h-[70svh] gap-6">
        <div className="text-6xl">🍛</div>
        <h1 className="text-xl font-bold text-amber-800">コバタロカレー レジ</h1>
        <p className="text-stone-500 text-sm text-center">
          Googleアカウントでログインすると
          <br />
          メニューの読み込み・売上記録ができます
        </p>
        <button
          onClick={login}
          className="bg-amber-700 text-white px-6 py-3 rounded-xl font-semibold shadow active:scale-95 transition-transform"
        >
          Googleでログイン
        </button>
      </div>
    )
  }

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold text-amber-800">🛒 レジ</h1>
        <button
          onClick={loadMenus}
          className="text-xs text-stone-400 underline"
        >
          ↻ 更新
        </button>
      </div>

      {done && (
        <div className="mb-4 bg-green-50 border border-green-200 text-green-700 rounded-lg px-4 py-3 text-sm font-semibold text-center">
          ✓ 売上を記録しました
        </div>
      )}

      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">
          {error}
          {error.includes('ログイン') && (
            <button onClick={login} className="ml-2 underline font-semibold">
              再ログイン
            </button>
          )}
        </div>
      )}

      {loading && <p className="text-stone-400 text-center py-8">読み込み中...</p>}

      {!loading && menus.length === 0 && !error && (
        <div className="text-center py-8 text-stone-500 text-sm">
          <p>有効なメニューがありません。</p>
          <p className="mt-2">
            「メニュー設定」または
            <br />
            スプレッドシートの「メニュー構成」シートに登録してください。
          </p>
        </div>
      )}

      <div className="space-y-2">
        {menus.map((m) => {
          const count = qty[m.name] ?? 0
          return (
            <div
              key={m.name}
              className="border border-stone-200 rounded-xl p-3 flex items-center justify-between"
            >
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-stone-800 truncate">{m.name}</p>
                <p className="text-sm text-stone-400">¥{m.price.toLocaleString()}</p>
              </div>
              <div className="flex items-center gap-3 ml-2">
                <button
                  onClick={() => setCount(m.name, -1)}
                  disabled={count === 0}
                  className="w-9 h-9 rounded-full bg-stone-100 text-stone-600 text-xl font-bold disabled:opacity-30 active:scale-90 transition-transform"
                >
                  −
                </button>
                <span className="w-6 text-center font-bold text-lg">{count}</span>
                <button
                  onClick={() => setCount(m.name, 1)}
                  className="w-9 h-9 rounded-full bg-amber-600 text-white text-xl font-bold active:scale-90 transition-transform"
                >
                  ＋
                </button>
              </div>
              <div className="w-20 text-right font-semibold text-stone-700 ml-2">
                {count > 0 ? `¥${(m.price * count).toLocaleString()}` : ''}
              </div>
            </div>
          )
        })}
      </div>

      {/* 合計バー */}
      {menus.length > 0 && (
        <div className="fixed bottom-16 left-1/2 -translate-x-1/2 w-full max-w-lg bg-white border-t border-stone-200 p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-stone-500">合計（{itemCount}点）</span>
            <span className="text-2xl font-bold text-stone-800">
              ¥{total.toLocaleString()}
            </span>
          </div>
          <button
            onClick={() => setClosing(true)}
            disabled={itemCount === 0}
            className="w-full bg-amber-700 text-white py-3 rounded-xl font-bold text-lg disabled:opacity-30 active:scale-95 transition-transform"
          >
            締める
          </button>
        </div>
      )}

      {/* 締めモーダル */}
      {closing && (
        <div className="fixed inset-0 bg-black/40 flex items-end justify-center z-50">
          <div className="bg-white w-full max-w-lg rounded-t-2xl p-5 space-y-4">
            <h2 className="text-lg font-bold text-stone-800">締め</h2>
            <div className="flex justify-between text-stone-600">
              <span>売上合計</span>
              <span className="font-bold">¥{total.toLocaleString()}</span>
            </div>
            <div>
              <label className="block text-sm text-stone-500 mb-1">場所代（円）</label>
              <input
                type="number"
                inputMode="numeric"
                value={locationFee}
                onChange={(e) => setLocationFee(e.target.value)}
                placeholder="0"
                className="w-full border border-stone-300 rounded-lg px-3 py-2 text-lg"
              />
            </div>
            <div>
              <label className="block text-sm text-stone-500 mb-1">メモ（任意）</label>
              <input
                type="text"
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                placeholder="天気・客層など"
                className="w-full border border-stone-300 rounded-lg px-3 py-2"
              />
            </div>
            <div className="flex justify-between text-stone-700 pt-2 border-t border-stone-100">
              <span>利益（売上 − 場所代）</span>
              <span className="font-bold">
                ¥{(total - (Number(locationFee) || 0)).toLocaleString()}
              </span>
            </div>
            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setClosing(false)}
                disabled={submitting}
                className="flex-1 py-3 rounded-xl border border-stone-300 text-stone-600 font-semibold"
              >
                キャンセル
              </button>
              <button
                onClick={handleClose}
                disabled={submitting}
                className="flex-1 py-3 rounded-xl bg-amber-700 text-white font-bold disabled:opacity-50"
              >
                {submitting ? '保存中...' : '保存する'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
