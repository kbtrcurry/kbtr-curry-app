import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../lib/auth'
import { readRange, updateValues, appendRows, AuthExpiredError } from '../lib/sheets'
import { loadRecipes, type DetailItem } from '../lib/recipes'

type Menu = {
  row: number
  name: string
  price: number
  recipe: string // "レシピ名×食分, レシピ名×食分"
  enabled: boolean
}
type Comp = { name: string; servings: number }

const DISABLED = ['off', 'false', '無効', 'no', '0']
const TAX = 1.08 // 軽減税率8%

export default function MenuSettingsPage() {
  const { token, login, logout } = useAuth()
  const [menus, setMenus] = useState<Menu[]>([])
  const [recipeMap, setRecipeMap] = useState<Record<string, DetailItem[]>>({})
  const [priceMap, setPriceMap] = useState<Record<string, number>>({})
  const [yieldMap, setYieldMap] = useState<Record<string, number | null>>({})
  const [swMap, setSwMap] = useState<Record<string, number | null>>({})
  const [servingsMap, setServingsMap] = useState<Record<string, number | null>>({})
  const [recipeNames, setRecipeNames] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nameVals, setNameVals] = useState<Record<number, string>>({})
  const [priceVals, setPriceVals] = useState<Record<number, string>>({})
  const [servEdit, setServEdit] = useState<Record<string, string>>({})
  const [pickerRow, setPickerRow] = useState<number | null>(null)
  const [pickerSearch, setPickerSearch] = useState('')

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
      const [rows, rd, master] = await Promise.all([
        readRange(token, 'メニュー構成!A2:D'),
        loadRecipes(token),
        readRange(token, '食材マスタ!A2:D'),
      ])
      const prices: Record<string, number> = {}
      for (const r of master) {
        const nm = (r[0] ?? '').trim()
        if (nm) prices[nm] = Number(r[3]) || 0
      }
      const parsed: Menu[] = rows
        .map((r, i) => ({
          row: i + 2,
          name: (r[0] ?? '').trim(),
          price: Number(r[1]) || 0,
          recipe: (r[2] ?? '').trim(),
          enabled: !DISABLED.includes((r[3] ?? '').trim().toLowerCase()),
        }))
        .filter((m) => m.name)
      setMenus(parsed)
      setRecipeMap(rd.recipeMap)
      setYieldMap(rd.yieldMap)
      setSwMap(rd.servingWeightMap)
      setServingsMap(rd.servingsMap)
      setRecipeNames(rd.names)
      setPriceMap(prices)
    } catch (e) {
      handleAuthError(e)
    } finally {
      setLoading(false)
    }
  }, [token, handleAuthError])

  useEffect(() => {
    load()
  }, [load])

  // ── 構成レシピのパース/整形（"名前×食分"） ──
  const parseComps = (s: string): Comp[] =>
    s
      .split(/[,、]/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map((tok) => {
        const idx = tok.lastIndexOf('×')
        if (idx > 0) {
          const nm = tok.slice(0, idx).trim()
          const n = Number(tok.slice(idx + 1))
          if (!Number.isNaN(n)) return { name: nm, servings: n }
        }
        return { name: tok, servings: 1 }
      })
  const formatComps = (arr: Comp[]) =>
    arr.map((c) => `${c.name}×${c.servings}`).join(', ')

  // ── レシピの一食原価（税込） ──
  const perServingCost = (name: string): number => {
    const items = recipeMap[name] ?? []
    const total = items.reduce(
      (s, it) => s + it.qty * (priceMap[it.name] ?? 0) * TAX,
      0,
    )
    const sv = servingsMap[name]
    const y = yieldMap[name]
    const w = swMap[name]
    const eff = sv && sv > 0 ? sv : y && w && w > 0 ? y / w : null
    return eff ? total / eff : total
  }
  const menuCost = (menu: Menu) =>
    parseComps(menu.recipe).reduce(
      (s, c) => s + perServingCost(c.name) * c.servings,
      0,
    )

  const saveField = async (
    menu: Menu,
    field: 'name' | 'price',
    col: string,
    raw: string,
  ) => {
    if (!token) return
    let newVal: string | number
    if (field === 'price') {
      const n = Number(raw)
      if (raw.trim() === '' || Number.isNaN(n)) return
      if (n === menu.price) return
      newVal = n
    } else {
      newVal = raw.trim()
      if (newVal === menu.name || newVal === '') return
    }
    setError(null)
    try {
      await updateValues(token, `メニュー構成!${col}${menu.row}`, [[newVal]])
      setMenus((prev) =>
        prev.map((m) => (m.row === menu.row ? { ...m, [field]: newVal } : m)),
      )
    } catch (e) {
      handleAuthError(e)
    }
  }

  const saveComps = async (menu: Menu, arr: Comp[]) => {
    if (!token) return
    const val = formatComps(arr)
    if (val === menu.recipe) return
    setError(null)
    try {
      await updateValues(token, `メニュー構成!C${menu.row}`, [[val]])
      setMenus((prev) =>
        prev.map((m) => (m.row === menu.row ? { ...m, recipe: val } : m)),
      )
    } catch (e) {
      handleAuthError(e)
    }
  }
  const addRecipe = (menu: Menu, name: string) => {
    const cur = parseComps(menu.recipe)
    if (cur.some((c) => c.name === name)) return
    saveComps(menu, [...cur, { name, servings: 1 }])
  }
  const removeRecipe = (menu: Menu, name: string) => {
    saveComps(menu, parseComps(menu.recipe).filter((c) => c.name !== name))
  }
  const setServings = (menu: Menu, name: string, raw: string) => {
    const n = Number(raw)
    if (Number.isNaN(n) || n <= 0) return
    const arr = parseComps(menu.recipe).map((c) =>
      c.name === name ? { ...c, servings: n } : c,
    )
    saveComps(menu, arr)
  }

  const toggleEnabled = async (menu: Menu) => {
    if (!token) return
    const next = !menu.enabled
    setMenus((prev) =>
      prev.map((m) => (m.row === menu.row ? { ...m, enabled: next } : m)),
    )
    try {
      await updateValues(token, `メニュー構成!D${menu.row}`, [[next ? 'ON' : 'OFF']])
    } catch (e) {
      handleAuthError(e)
      setMenus((prev) =>
        prev.map((m) => (m.row === menu.row ? { ...m, enabled: !next } : m)),
      )
    }
  }

  const addMenu = async () => {
    if (!token) return
    setError(null)
    try {
      await appendRows(token, 'メニュー構成!A:D', [['新しいメニュー', 0, '', 'ON']])
      await load()
    } catch (e) {
      handleAuthError(e)
    }
  }
  const deleteMenu = async (menu: Menu) => {
    if (!token) return
    if (!confirm(`「${menu.name}」を削除しますか？`)) return
    setError(null)
    try {
      await updateValues(token, `メニュー構成!A${menu.row}:D${menu.row}`, [['', '', '', '']])
      setMenus((prev) => prev.filter((m) => m.row !== menu.row))
    } catch (e) {
      handleAuthError(e)
    }
  }

  if (!token) {
    return (
      <div className="p-6 flex flex-col items-center justify-center min-h-[70svh] gap-6">
        <div className="text-6xl">⚙️</div>
        <h1 className="text-xl font-bold text-amber-800">メニュー設定</h1>
        <button
          onClick={login}
          className="bg-amber-700 text-[#faf9f5] px-6 py-3 rounded-xl font-semibold shadow active:scale-95 transition-transform"
        >
          Googleでログイン
        </button>
      </div>
    )
  }

  const activeCount = menus.filter((m) => m.enabled).length

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-bold text-amber-800">⚙️ メニュー設定</h1>
        <button onClick={load} className="text-sm text-stone-500 underline">
          ↻ 更新
        </button>
      </div>
      <p className="text-xs text-stone-500 mb-3">
        <span className="font-semibold">有効(ON)</span>がレジに表示／原価は税込（{activeCount}件 有効）
      </p>

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

      <div className="space-y-3">
        {menus.map((m) => {
          const comps = parseComps(m.recipe)
          const cost = menuCost(m)
          const rate = m.price > 0 ? (cost / m.price) * 100 : null
          return (
            <div
              key={m.row}
              className={`border rounded-xl p-3 ${
                m.enabled ? 'border-stone-300' : 'border-stone-200 bg-stone-50 opacity-70'
              }`}
            >
              <div className="flex items-center gap-2 mb-2">
                <input
                  type="text"
                  value={nameVals[m.row] !== undefined ? nameVals[m.row] : m.name}
                  onChange={(e) => setNameVals((p) => ({ ...p, [m.row]: e.target.value }))}
                  onBlur={(e) => saveField(m, 'name', 'A', e.target.value)}
                  className="flex-1 min-w-0 border border-stone-300 rounded px-2 py-2 text-base font-semibold text-stone-900 outline-none focus:border-amber-400"
                />
                <button
                  onClick={() => toggleEnabled(m)}
                  className={`shrink-0 px-3 py-2 rounded-lg text-sm font-bold ${
                    m.enabled ? 'bg-green-600 text-[#faf9f5]' : 'bg-stone-300 text-stone-600'
                  }`}
                >
                  {m.enabled ? 'ON' : 'OFF'}
                </button>
                <button
                  onClick={() => deleteMenu(m)}
                  className="text-stone-300 text-xl px-1 shrink-0"
                  aria-label="削除"
                >
                  ×
                </button>
              </div>

              {/* 構成レシピ（名前＋食分） */}
              <div className="space-y-1.5 mb-2">
                {comps.map((c) => {
                  const key = `${m.row}|${c.name}`
                  const cval =
                    servEdit[key] !== undefined ? servEdit[key] : String(c.servings)
                  const cCost = perServingCost(c.name) * c.servings
                  const known = (recipeMap[c.name] ?? []).length > 0
                  return (
                    <div key={c.name} className="flex items-center gap-2 text-sm">
                      <span className="flex-1 min-w-0 truncate text-stone-800">
                        {c.name}
                        {!known && (
                          <span className="text-amber-600 text-xs ml-1">(レシピ未登録)</span>
                        )}
                      </span>
                      <input
                        type="number"
                        inputMode="decimal"
                        step="0.5"
                        value={cval}
                        onChange={(e) =>
                          setServEdit((p) => ({ ...p, [key]: e.target.value }))
                        }
                        onBlur={(e) => setServings(m, c.name, e.target.value)}
                        className="w-14 border border-stone-300 rounded px-1.5 py-1 text-right"
                      />
                      <span className="text-xs text-stone-400 w-4">食</span>
                      <span className="w-16 text-right text-stone-600">
                        ¥{Math.round(cCost).toLocaleString()}
                      </span>
                      <button
                        onClick={() => removeRecipe(m, c.name)}
                        className="text-stone-300 text-lg px-1 shrink-0"
                        aria-label="外す"
                      >
                        ×
                      </button>
                    </div>
                  )
                })}
                <button
                  onClick={() => {
                    setPickerRow(pickerRow === m.row ? null : m.row)
                    setPickerSearch('')
                  }}
                  className="text-xs text-amber-700 font-semibold border border-dashed border-amber-300 rounded-full px-2.5 py-1"
                >
                  ＋ レシピを追加
                </button>

                {pickerRow === m.row && (
                  <div className="mt-1 border border-stone-200 rounded-lg p-2 bg-stone-50">
                    <input
                      type="text"
                      autoFocus
                      value={pickerSearch}
                      onChange={(e) => setPickerSearch(e.target.value)}
                      placeholder="レシピ名で検索…"
                      className="w-full border border-stone-300 rounded px-2 py-1.5 text-sm mb-2"
                    />
                    <div className="max-h-44 overflow-y-auto divide-y divide-stone-100 bg-white rounded border border-stone-200">
                      {recipeNames
                        .filter((n) => (pickerSearch ? n.includes(pickerSearch) : true))
                        .filter((n) => !comps.some((c) => c.name === n))
                        .slice(0, 30)
                        .map((n) => (
                          <button
                            key={n}
                            onClick={() => addRecipe(m, n)}
                            className="w-full text-left px-2 py-1.5 text-sm active:bg-amber-50 flex justify-between"
                          >
                            <span className="truncate">{n}</span>
                            <span className="text-amber-700 ml-2 shrink-0">＋</span>
                          </button>
                        ))}
                    </div>
                    <button
                      onClick={() => setPickerRow(null)}
                      className="w-full text-center text-xs text-stone-500 mt-2 py-1"
                    >
                      閉じる
                    </button>
                  </div>
                )}
              </div>

              {/* 価格・原価・原価率 */}
              <div className="flex items-center gap-2 border-t border-stone-100 pt-2">
                <div className="flex items-center border border-stone-300 rounded px-2 py-1.5 w-28">
                  <span className="text-sm text-stone-400 mr-1">¥</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    value={priceVals[m.row] !== undefined ? priceVals[m.row] : String(m.price)}
                    onChange={(e) => setPriceVals((p) => ({ ...p, [m.row]: e.target.value }))}
                    onBlur={(e) => saveField(m, 'price', 'B', e.target.value)}
                    className="w-full min-w-0 text-right text-base outline-none"
                  />
                </div>
                <span className="text-sm text-stone-600">
                  原価 ¥{Math.round(cost).toLocaleString()}
                </span>
                {rate != null && (
                  <span
                    className={`ml-auto text-sm font-bold px-2 py-0.5 rounded ${
                      rate > 35 ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'
                    }`}
                  >
                    原価率 {rate.toFixed(0)}%
                  </span>
                )}
              </div>
            </div>
          )
        })}

        {!loading && menus.length === 0 && (
          <p className="text-center text-stone-400 text-sm py-6">
            メニューがありません。下のボタンで追加してください。
          </p>
        )}

        <button
          onClick={addMenu}
          className="w-full border border-dashed border-stone-300 rounded-xl py-3 text-sm text-amber-700 font-semibold active:bg-stone-50"
        >
          ＋ メニューを追加
        </button>
      </div>
    </div>
  )
}
