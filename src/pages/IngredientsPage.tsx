import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../lib/auth'
import { readRange, updateValues, AuthExpiredError } from '../lib/sheets'

type FieldKey = 'price' | 'weight' | 'stock'

type Ingredient = {
  row: number
  name: string
  category: string
  unit: string
  price: number
  supplier: string
  count: number
  weight: number
  stock: number
}

const FIELDS: { key: FieldKey; label: string; col: string }[] = [
  { key: 'price', label: '単価', col: 'D' },
  { key: 'weight', label: '単品重量', col: 'G' },
  { key: 'stock', label: '在庫', col: 'H' },
]

const VISIBLE_LIMIT = 80

export default function IngredientsPage() {
  const { token, login, logout } = useAuth()
  const [list, setList] = useState<Ingredient[]>([])
  const [search, setSearch] = useState('')
  const [onlyUnset, setOnlyUnset] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [edits, setEdits] = useState<Record<number, Partial<Record<FieldKey, string>>>>({})
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
      const rows = await readRange(token, '食材マスタ!A2:H')
      const parsed: Ingredient[] = rows
        .map((r, i) => ({
          row: i + 2,
          name: (r[0] ?? '').trim(),
          category: (r[1] ?? '').trim(),
          unit: (r[2] ?? '').trim(),
          price: Number(r[3]) || 0,
          supplier: (r[4] ?? '').trim(),
          count: Number(r[5]) || 0,
          weight: Number(r[6]) || 0,
          stock: Number(r[7]) || 0,
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

  const clearEdit = (row: number, field: FieldKey) => {
    setEdits((p) => {
      const rowEdits = { ...p[row] }
      delete rowEdits[field]
      const n = { ...p }
      if (Object.keys(rowEdits).length === 0) delete n[row]
      else n[row] = rowEdits
      return n
    })
  }

  const saveField = async (
    ing: Ingredient,
    field: FieldKey,
    col: string,
  ) => {
    if (!token) return
    const raw = edits[ing.row]?.[field]
    if (raw === undefined) return
    const newVal = Number(raw)
    if (Number.isNaN(newVal) || newVal === ing[field]) {
      clearEdit(ing.row, field)
      return
    }
    setSavingRow(ing.row)
    setError(null)
    try {
      await updateValues(token, `食材マスタ!${col}${ing.row}`, [[newVal]])
      setList((prev) =>
        prev.map((x) => (x.row === ing.row ? { ...x, [field]: newVal } : x)),
      )
      clearEdit(ing.row, field)
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
          単価未設定のみ
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

      <div className="space-y-2">
        {shown.map((ing) => (
          <div
            key={ing.row}
            className={`border rounded-xl px-3 py-2 ${
              ing.price === 0 ? 'border-amber-200 bg-amber-50/40' : 'border-stone-200'
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <p className="font-medium text-stone-800 truncate">{ing.name}</p>
                <p className="text-xs text-stone-400">
                  {ing.category} ・ {ing.supplier || '仕入先未設定'} ・ {ing.count}回
                </p>
              </div>
              <span className="w-5 text-center shrink-0">
                {savingRow === ing.row ? (
                  <span className="text-stone-400 text-xs">…</span>
                ) : savedRow === ing.row ? (
                  <span className="text-green-500">✓</span>
                ) : null}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2 mt-2">
              {FIELDS.map((f) => {
                const editVal = edits[ing.row]?.[f.key]
                const value = editVal !== undefined ? editVal : String(ing[f.key])
                const suffix =
                  f.key === 'price' ? `円/${ing.unit || 'g'}` : 'g'
                return (
                  <div key={f.key}>
                    <label className="block text-[10px] text-stone-400 mb-0.5">
                      {f.label}
                    </label>
                    <div className="flex items-center border border-stone-300 rounded px-1.5 py-1 bg-white">
                      <input
                        type="number"
                        inputMode="decimal"
                        step="0.01"
                        value={value}
                        onChange={(e) =>
                          setEdits((p) => ({
                            ...p,
                            [ing.row]: { ...p[ing.row], [f.key]: e.target.value },
                          }))
                        }
                        onBlur={() => saveField(ing, f.key, f.col)}
                        className="w-full min-w-0 text-right text-sm outline-none"
                      />
                      <span className="text-[10px] text-stone-400 ml-0.5 shrink-0">
                        {suffix}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
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
