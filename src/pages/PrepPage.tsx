import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../lib/auth'
import { readRange, AuthExpiredError } from '../lib/sheets'
import { loadRecipes, type DetailItem } from '../lib/recipes'
import { getRecent, pushRecent, RECENT_KEYS, RECENT_LABEL } from '../lib/recent'
import { usePersistedState } from '../lib/persistState'
import { getCached, setCached } from '../lib/dataCache'

type Prep = { name: string; mult: string }

const PREP_KEY = 'kbtr_prep'

function fmt(x: number): string {
  return (Math.round(x * 10) / 10).toLocaleString()
}

type PrepCache = {
  recipeMap: Record<string, DetailItem[]>
  typeMap: Record<string, string>
  names: string[]
  types: string[]
  stockMap: Record<string, number | null>
}

export default function PrepPage() {
  const { token, login, logout } = useAuth()
  const initCache = getCached<PrepCache>('prep_data')
  const [recipeMap, setRecipeMap] = useState<Record<string, DetailItem[]>>(initCache?.recipeMap ?? {})
  const [typeMap, setTypeMap] = useState<Record<string, string>>(initCache?.typeMap ?? {})
  const [names, setNames] = useState<string[]>(initCache?.names ?? [])
  const [types, setTypes] = useState<string[]>(initCache?.types ?? [])
  const [stockMap, setStockMap] = useState<Record<string, number | null>>(initCache?.stockMap ?? {})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [search, setSearch] = usePersistedState('kbtr_view_prep_search', '')
  const [cat, setCat] = usePersistedState<string>('kbtr_view_prep_cat', RECENT_LABEL)
  const [recent, setRecent] = useState<string[]>(() => getRecent(RECENT_KEYS.prep))
  const [subTab, setSubTab] = usePersistedState<'shopping' | 'recipes'>(
    'kbtr_view_prep_subtab',
    'shopping',
  )
  const [selected, setSelected] = useState<Prep[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(PREP_KEY) ?? '[]')
    } catch {
      return []
    }
  })

  const persist = useCallback((next: Prep[]) => {
    setSelected(next)
    localStorage.setItem(PREP_KEY, JSON.stringify(next))
  }, [])

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

  const load = useCallback(async (silent = false) => {
    if (!token) return
    if (!silent) setLoading(true)
    setError(null)
    try {
      const [rd, master] = await Promise.all([
        loadRecipes(token),
        readRange(token, '食材マスタ!A2:J'),
      ])
      const stocks: Record<string, number | null> = {}
      for (const r of master) {
        const name = (r[0] ?? '').trim()
        if (!name) continue
        const s = (r[7] ?? '').trim()
        stocks[name] = s === '' ? null : Number(s)
      }
      setStockMap(stocks)
      setRecipeMap(rd.recipeMap)
      setTypeMap(rd.typeMap)
      setNames(rd.names)
      setTypes(rd.types)
      setCached('prep_data', {
        recipeMap: rd.recipeMap, typeMap: rd.typeMap,
        names: rd.names, types: rd.types, stockMap: stocks,
      })
    } catch (e) {
      if (!silent) handleAuthError(e)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [token, handleAuthError])

  useEffect(() => {
    load(!!getCached('prep_data'))
  }, [load])

  const addRecipe = (name: string) => {
    setRecent(pushRecent(RECENT_KEYS.prep, name))
    if (selected.some((s) => s.name === name)) return
    persist([...selected, { name, mult: '1' }])
    setSearch('')
  }
  const removeRecipe = (name: string) => {
    persist(selected.filter((s) => s.name !== name))
  }
  const setMult = (name: string, mult: string) => {
    persist(selected.map((s) => (s.name === name ? { ...s, mult } : s)))
  }

  // 買い出し集計
  const agg: Record<string, { qty: number; unit: string }> = {}
  for (const s of selected) {
    const m = Number(s.mult) || 0
    for (const it of recipeMap[s.name] ?? []) {
      if (!agg[it.name]) agg[it.name] = { qty: 0, unit: it.unit }
      agg[it.name].qty += it.qty * m
    }
  }
  const shoppingRows = Object.entries(agg)
    .map(([name, v]) => {
      const stock = stockMap[name] ?? null
      const short = v.qty - (stock ?? 0)
      return { name, need: v.qty, unit: v.unit, stock, short }
    })
    .sort((a, b) => b.short - a.short)

  const selectedNames = new Set(selected.map((s) => s.name))
  const listed = (
    search
      ? names.filter((n) => n.includes(search)).slice(0, 50)
      : cat === RECENT_LABEL
        ? recent.filter((n) => names.includes(n))
        : names.filter((n) => typeMap[n] === cat)
  ).filter((n) => !selectedNames.has(n))

  if (!token) {
    return (
      <div className="p-6 flex flex-col items-center justify-center min-h-[70svh] gap-6">
        <div className="text-6xl">🍳</div>
        <h1 className="text-xl font-bold text-amber-800">仕込み計画</h1>
        <button
          onClick={login}
          className="bg-amber-700 text-[#faf9f5] px-6 py-3 rounded-xl font-semibold shadow active:scale-95 transition-transform"
        >
          Googleでログイン
        </button>
      </div>
    )
  }

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-xl font-bold text-amber-800">🍳 仕込み計画</h1>
        <button onClick={() => load()} className="text-xs text-stone-400 underline">
          ↻ 更新
        </button>
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

      {/* 選択中レシピ＋倍率 */}
      {selected.length > 0 && (
        <div className="space-y-1.5 mb-4">
          <p className="text-xs text-stone-400">本日の仕込み（{selected.length}品）</p>
          {selected.map((s) => (
            <div
              key={s.name}
              className="flex items-center gap-2 border border-stone-200 rounded-lg px-3 py-2"
            >
              <span className="flex-1 min-w-0 truncate text-sm text-stone-800">
                {s.name}
              </span>
              <div className="flex items-center gap-1 shrink-0">
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.5"
                  value={s.mult}
                  onChange={(e) => setMult(s.name, e.target.value)}
                  className="w-14 border border-stone-300 rounded px-2 py-1 text-right text-sm"
                />
                <span className="text-xs text-stone-400">倍</span>
              </div>
              <button
                onClick={() => removeRecipe(s.name)}
                className="text-stone-300 text-lg shrink-0 px-1"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* サブタブ（選択あり時） */}
      {selected.length > 0 && (
        <div className="flex border border-stone-200 rounded-lg overflow-hidden mb-3">
          <button
            onClick={() => setSubTab('shopping')}
            className={`flex-1 py-2 text-sm font-semibold ${
              subTab === 'shopping' ? 'bg-amber-700 text-[#faf9f5]' : 'text-stone-500'
            }`}
          >
            🛒 買い出し
          </button>
          <button
            onClick={() => setSubTab('recipes')}
            className={`flex-1 py-2 text-sm font-semibold ${
              subTab === 'recipes' ? 'bg-amber-700 text-[#faf9f5]' : 'text-stone-500'
            }`}
          >
            🍳 仕込みレシピ
          </button>
        </div>
      )}

      {selected.length > 0 && subTab === 'shopping' && (
        <div className="border border-stone-200 rounded-lg overflow-hidden mb-5">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 text-stone-500">
              <tr>
                <th className="text-left px-3 py-2 font-medium">食材</th>
                <th className="text-right px-2 py-2 font-medium">必要量</th>
                <th className="text-right px-2 py-2 font-medium">在庫</th>
                <th className="text-right px-3 py-2 font-medium">買う量</th>
              </tr>
            </thead>
            <tbody>
              {shoppingRows.map((r) => (
                <tr
                  key={r.name}
                  className={`border-t border-stone-100 ${
                    r.short > 0 ? '' : 'text-stone-400'
                  }`}
                >
                  <td className="px-3 py-2 text-stone-800">{r.name}</td>
                  <td className="px-2 py-2 text-right">
                    {fmt(r.need)}
                    {r.unit}
                  </td>
                  <td className="px-2 py-2 text-right text-stone-400">
                    {r.stock === null ? 'N/A' : fmt(r.stock)}
                  </td>
                  <td
                    className={`px-3 py-2 text-right font-semibold ${
                      r.short > 0 ? 'text-red-600' : 'text-stone-400'
                    }`}
                  >
                    {r.short > 0 ? `${fmt(r.short)}${r.unit}` : '足りる'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected.length > 0 && subTab === 'recipes' && (
        <div className="space-y-4 mb-5">
          {selected.map((s) => {
            const m = Number(s.mult) || 0
            const items = recipeMap[s.name] ?? []
            return (
              <div key={s.name}>
                <h3 className="font-semibold text-stone-800 mb-1">
                  {s.name} <span className="text-sm text-amber-700">×{s.mult}</span>
                </h3>
                <div className="border border-stone-200 rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <tbody>
                      {items.map((it, i) => (
                        <tr key={i} className="border-t border-stone-100 first:border-t-0">
                          <td className="px-3 py-1.5 text-stone-700">{it.name}</td>
                          <td className="px-3 py-1.5 text-right font-medium text-stone-800">
                            {fmt(it.qty * m)}
                            {it.unit}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* レシピ追加 */}
      {!loading && (
        <div className="border-t border-stone-200 pt-3">
          <p className="text-xs text-stone-400 mb-2">レシピを追加</p>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="レシピを検索…"
            className="w-full border border-stone-300 rounded-lg px-3 py-2 mb-2"
          />
          {!search && (
            <div className="flex gap-1.5 overflow-x-auto pb-2 mb-2 -mx-1 px-1">
              {[RECENT_LABEL, ...types].map((t) => (
                <button
                  key={t}
                  onClick={() => setCat(t)}
                  className={`shrink-0 px-3 py-1.5 rounded-full text-sm font-semibold ${
                    cat === t ? 'bg-amber-700 text-[#faf9f5]' : 'bg-stone-100 text-stone-600'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
          <div className="border border-stone-200 rounded-lg divide-y divide-stone-100 max-h-64 overflow-y-auto">
            {listed.map((name) => (
              <button
                key={name}
                onClick={() => addRecipe(name)}
                className="w-full text-left px-3 py-2 text-sm active:bg-stone-50 flex justify-between"
              >
                <span className="truncate">{name}</span>
                <span className="text-amber-700 ml-2 shrink-0">＋追加</span>
              </button>
            ))}
            {listed.length === 0 && (
              <p className="text-center text-stone-400 text-sm py-6">
                該当するレシピがありません
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
