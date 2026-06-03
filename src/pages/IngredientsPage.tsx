import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../lib/auth'
import { readRange, updateValues, AuthExpiredError } from '../lib/sheets'

type Ingredient = {
  row: number
  name: string
  category: string
  unit: string
  price: number
  supplier: string
  count: number
}

const VISIBLE_LIMIT = 80

export default function IngredientsPage() {
  const { token, login, logout } = useAuth()
  const [list, setList] = useState<Ingredient[]>([])
  const [search, setSearch] = useState('')
  const [onlyUnset, setOnlyUnset] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [edits, setEdits] = useState<Record<number, string>>({})
  const [savingRow, setSavingRow] = useState<number | null>(null)
  const [savedRow, setSavedRow] = useState<number | null>(null)

  const handleAuthError = useCallback(
    (e: unknown) => {
      if (e instanceof AuthExpiredError) {
        logout()
        setError('認証の有効期限が切れました。再度ログインしてください。')
      } else {
        setError(e instanceof Error ? e.message : '処理に失敗しました')
      }
    },
    [logout],
  )

  const load = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError(null)
    try {
      const rows = await readRange(token, '食材マスタ!A2:F')
      const parsed: Ingredient[] = rows
        .map((r, i) => ({
          row: i + 2,
          name: (r[0] ?? '').trim(),
          category: (r[1] ?? '').trim(),
          unit: (r[2] ?? '').trim(),
          price: Number(r[3]) || 0,
          supplier: (r[4] ?? '').trim(),
          count: Number(r[5]) || 0,
        }))
        .filter((x) => x.name)
      parsed.sort((a, b) => b.count - a.count)
      setList(parsed)
    } catch (e) {
      handleAuthError(e)
    } finally {
      setLoading(false)
    }
  }, [token, handleAuthError])

  useEffect(() => {
    load()
  }, [load])

  const savePrice = async (ing: Ingredient) => {
    if (!token) return
    const raw = edits[ing.row]
    if (raw === undefined) return
    const newPrice = Number(raw)
    if (Number.isNaN(newPrice) || newPrice === ing.price) {
      // 変更なし → 編集状態解除
      setEdits((p) => {
        const n = { ...p }
        delete n[ing.row]
        return n
      })
      return
    }
    setSavingRow(ing.row)
    setError(null)
    try {
      await updateValues(token, `食材マスタ!D${ing.row}`, [[newPrice]])
      setList((prev) =>
        prev.map((x) => (x.row === ing.row ? { ...x, price: newPrice } : x)),
      )
      setEdits((p) => {
        const n = { ...p }
        delete n[ing.row]
        return n
      })
      setSavedRow(ing.row)
      setTimeout(() => setSavedRow(null), 1500)
    } catch (e) {
      handleAuthError(e)
    } finally {
      setSavingRow(null)
    }
  }

  const filtered = list
    .filter((x) => (search ? x.name.includes(search) : true))
    .filter((x) => (onlyUnset ? x.price === 0 : true))
  const shown = search ? filtered : filtered.slice(0, VISIBLE_LIMIT)
  const unsetCount = list.filter((x) => x.price === 0).length

  if (!token) {
    return (
      <div className="p-6 flex flex-col items-center justify-center min-h-[70svh] gap-6">
        <div className="text-6xl">🥬</div>
        <h1 className="text-xl font-bold text-amber-800">食材マスタ</h1>
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
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-xl font-bold text-amber-800">🥬 食材マスタ</h1>
        <button onClick={load} className="text-xs text-stone-400 underline">
          ↻ 更新
        </button>
      </div>

      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="食材名で検索…"
        className="w-full border border-stone-300 rounded-lg px-3 py-2 mb-2"
      />

      <div className="flex items-center justify-between mb-3 text-sm">
        <label className="flex items-center gap-2 text-stone-600">
          <input
            type="checkbox"
            checked={onlyUnset}
            onChange={(e) => setOnlyUnset(e.target.checked)}
          />
          未設定（0円）のみ
        </label>
        <span className="text-stone-400">
          未設定 {unsetCount} / 全 {list.length} 件
        </span>
      </div>

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

      <div className="space-y-1">
        {shown.map((ing) => {
          const editing = edits[ing.row] !== undefined
          const value = editing ? edits[ing.row] : String(ing.price)
          return (
            <div
              key={ing.row}
              className={`border rounded-lg px-3 py-2 flex items-center gap-2 ${
                ing.price === 0 ? 'border-amber-200 bg-amber-50/40' : 'border-stone-200'
              }`}
            >
              <div className="flex-1 min-w-0">
                <p className="font-medium text-stone-800 truncate">{ing.name}</p>
                <p className="text-xs text-stone-400">
                  {ing.category} ・ {ing.supplier || '仕入先未設定'} ・ {ing.count}回
                </p>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-xs text-stone-400">¥</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  value={value}
                  onChange={(e) =>
                    setEdits((p) => ({ ...p, [ing.row]: e.target.value }))
                  }
                  onBlur={() => savePrice(ing)}
                  className="w-20 border border-stone-300 rounded px-2 py-1 text-right"
                />
                <span className="text-xs text-stone-400 w-8">/{ing.unit}</span>
                <span className="w-5 text-center">
                  {savingRow === ing.row ? (
                    <span className="text-stone-400 text-xs">…</span>
                  ) : savedRow === ing.row ? (
                    <span className="text-green-500">✓</span>
                  ) : null}
                </span>
              </div>
            </div>
          )
        })}
      </div>

      {!search && filtered.length > VISIBLE_LIMIT && (
        <p className="text-center text-stone-400 text-sm py-4">
          上位 {VISIBLE_LIMIT} 件を表示中。検索で絞り込めます（全 {filtered.length} 件）
        </p>
      )}
      {search && shown.length === 0 && !loading && (
        <p className="text-center text-stone-400 text-sm py-8">
          「{search}」に一致する食材がありません
        </p>
      )}
    </div>
  )
}
