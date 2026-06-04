import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../lib/auth'
import { readRange, updateValues, appendRows, AuthExpiredError } from '../lib/sheets'
import {
  loadRecipes,
  SALE_COL,
  YIELD_COL,
  SERVING_WEIGHT_COL,
  SERVINGS_COL,
  DETAIL_MEMO_COL,
  type DetailItem,
} from '../lib/recipes'
import { getRecent, pushRecent, RECENT_KEYS, RECENT_LABEL } from '../lib/recent'

const TAX = 1.08 // 軽減税率8%（食材単価は税抜→原価は税込表示）
const RECIPE_TYPES = [
  'カレー', 'ビリヤニ', 'キーマ', 'ダル', 'サブジ・野菜', 'アチャール',
  'チャトニ', 'ライタ', '揚げ物', 'ご飯もの', 'パン・麺', 'ドリンク', 'その他',
]

type NumMap = Record<string, number | null>

export default function RecipePage() {
  const { token, login, logout } = useAuth()
  const [recipeMap, setRecipeMap] = useState<Record<string, DetailItem[]>>({})
  const [typeMap, setTypeMap] = useState<Record<string, string>>({})
  const [saleMap, setSaleMap] = useState<NumMap>({})
  const [yieldMap, setYieldMap] = useState<NumMap>({})
  const [swMap, setSwMap] = useState<NumMap>({}) // 一食重量
  const [servingsMap, setServingsMap] = useState<NumMap>({})
  const [rowMap, setRowMap] = useState<Record<string, number>>({})
  const [names, setNames] = useState<string[]>([])
  const [types, setTypes] = useState<string[]>([])
  const [priceMap, setPriceMap] = useState<Record<string, number>>({})
  const [search, setSearch] = useState('')
  const [cat, setCat] = useState<string>(RECENT_LABEL)
  const [recent, setRecent] = useState<string[]>(() => getRecent(RECENT_KEYS.recipe))
  const [selected, setSelected] = useState<string | null>(null)

  // 編集中の値（選択レシピ）
  const [salePrice, setSalePrice] = useState('')
  const [totalWeight, setTotalWeight] = useState('')
  const [servingWeight, setServingWeight] = useState('')
  const [servings, setServings] = useState('')
  const [savingField, setSavingField] = useState<string | null>(null)
  const [memoVals, setMemoVals] = useState<Record<number, string>>({})
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState('カレー')
  const [nameVals, setNameVals] = useState<Record<number, string>>({})
  const [qtyVals, setQtyVals] = useState<Record<number, string>>({})
  const [unitVals, setUnitVals] = useState<Record<number, string>>({})

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
      const [rd, master] = await Promise.all([
        loadRecipes(token),
        readRange(token, '食材マスタ!A2:D'),
      ])
      const prices: Record<string, number> = {}
      for (const r of master) {
        const name = (r[0] ?? '').trim()
        if (name) prices[name] = Number(r[3]) || 0
      }
      setPriceMap(prices)
      setRecipeMap(rd.recipeMap)
      setTypeMap(rd.typeMap)
      setSaleMap(rd.saleMap)
      setYieldMap(rd.yieldMap)
      setSwMap(rd.servingWeightMap)
      setServingsMap(rd.servingsMap)
      setRowMap(rd.rowMap)
      setNames(rd.names)
      setTypes(rd.types)
    } catch (e) {
      handleAuthError(e)
    } finally {
      setLoading(false)
    }
  }, [token, handleAuthError])

  useEffect(() => {
    load()
  }, [load])

  const str = (v: number | null | undefined) => (v != null ? String(v) : '')

  const openRecipe = (name: string) => {
    setSelected(name)
    setRecent(pushRecent(RECENT_KEYS.recipe, name))
    setSearch('')
    setSalePrice(str(saleMap[name]))
    setTotalWeight(str(yieldMap[name]))
    setServingWeight(str(swMap[name]))
    setServings(str(servingsMap[name]))
  }

  // セル保存（汎用）
  const saveCell = async (
    col: string,
    raw: string,
    current: number | null | undefined,
    applyLocal: (v: number | null) => void,
  ) => {
    if (!token || !selected) return
    const t = raw.trim()
    const v = t === '' ? null : Number(t)
    if (v !== null && Number.isNaN(v)) return
    if (v === (current ?? null)) return
    const row = rowMap[selected]
    if (!row) return
    setSavingField(col)
    setError(null)
    try {
      await updateValues(token, `レシピ一覧!${col}${row}`, [[v === null ? '' : v]])
      applyLocal(v)
    } catch (e) {
      handleAuthError(e)
    } finally {
      setSavingField(null)
    }
  }

  // 新規レシピ作成（レシピ一覧に追加 → 開く）
  const createRecipe = async () => {
    if (!token) return
    const nm = newName.trim()
    if (!nm) return
    if (names.includes(nm)) {
      setError('同名のレシピが既にあります')
      return
    }
    setError(null)
    try {
      await appendRows(token, 'レシピ一覧!A:B', [[nm, newType]])
      setCreating(false)
      setNewName('')
      await load()
      openRecipe(nm)
    } catch (e) {
      handleAuthError(e)
    }
  }

  // 料理タイプ変更
  const saveType = async (t: string) => {
    if (!token || !selected) return
    if (t === typeMap[selected]) return
    const row = rowMap[selected]
    if (!row) return
    try {
      await updateValues(token, `レシピ一覧!B${row}`, [[t]])
      setTypeMap((p) => ({ ...p, [selected]: t }))
    } catch (e) {
      handleAuthError(e)
    }
  }

  // 食材名・分量・単位の編集保存
  const saveDetail = async (
    item: DetailItem,
    field: 'name' | 'qty' | 'unit',
    col: string,
    raw: string,
  ) => {
    if (!token || !selected) return
    let newVal: string | number
    if (field === 'qty') {
      const n = Number(raw)
      if (raw.trim() === '' || Number.isNaN(n)) return
      if (n === item.qty) return
      newVal = n
    } else {
      newVal = raw.trim()
      if (newVal === item[field]) return
      if (field === 'name' && newVal === '') return
    }
    setError(null)
    try {
      await updateValues(token, `レシピ食材明細!${col}${item.row}`, [[newVal]])
      setRecipeMap((prev) => {
        const arr = prev[selected]?.map((it) =>
          it.row === item.row ? { ...it, [field]: newVal } : it,
        )
        return arr ? { ...prev, [selected]: arr } : prev
      })
    } catch (e) {
      handleAuthError(e)
    }
  }

  // 食材行の削除（B〜Dを空にして非表示化）
  const deleteRow = async (item: DetailItem) => {
    if (!token || !selected) return
    if (!confirm(`「${item.name}」を削除しますか？`)) return
    setError(null)
    try {
      await updateValues(token, `レシピ食材明細!B${item.row}:D${item.row}`, [['', '', '']])
      setRecipeMap((prev) => {
        const arr = prev[selected]?.filter((it) => it.row !== item.row)
        return arr ? { ...prev, [selected]: arr } : prev
      })
    } catch (e) {
      handleAuthError(e)
    }
  }

  // 食材行の追加（末尾に空行を足して再読込）
  const addRow = async () => {
    if (!token || !selected) return
    setError(null)
    try {
      await appendRows(token, 'レシピ食材明細!A:H', [
        [selected, '新しい食材', 0, 'g', '', '', 0, ''],
      ])
      await load()
    } catch (e) {
      handleAuthError(e)
    }
  }

  // 食材メモ保存
  const saveMemo = async (item: DetailItem) => {
    if (!token || !selected) return
    const raw = memoVals[item.row]
    if (raw === undefined || raw === item.memo) return
    setError(null)
    try {
      await updateValues(token, `レシピ食材明細!${DETAIL_MEMO_COL}${item.row}`, [[raw]])
      setRecipeMap((prev) => {
        const arr = prev[selected]?.map((it) =>
          it.row === item.row ? { ...it, memo: raw } : it,
        )
        return arr ? { ...prev, [selected]: arr } : prev
      })
    } catch (e) {
      handleAuthError(e)
    }
  }

  // 食数の実効値（食数入力 → 総重量/一食重量 → なし）
  const effServings = (sv: number | null, total: number | null, sw: number | null) => {
    if (sv && sv > 0) return sv
    if (total && sw && sw > 0) return total / sw
    return null
  }

  // ── 選択レシピの計算 ──
  const items = selected ? (recipeMap[selected] ?? []) : []
  const rows = items.map((it) => {
    const price = priceMap[it.name] ?? 0 // 税抜単価
    return { ...it, price, cost: it.qty * price * TAX } // 原価は税込
  })
  const totalCost = rows.reduce((s, r) => s + r.cost, 0) // レシピ全体（税込）
  const unknownCount = rows.filter((r) => r.price === 0).length

  const swNum = Number(servingWeight) || 0
  const twNum = Number(totalWeight) || 0
  const svNum = Number(servings) || 0
  const eff = effServings(svNum || null, twNum || null, swNum || null)
  const perServingCost = eff ? totalCost / eff : totalCost
  const sale = Number(salePrice) || 0
  const costRate = sale > 0 ? (perServingCost / sale) * 100 : 0
  const profit = sale - perServingCost

  const listed = search
    ? names.filter((n) => n.includes(search)).slice(0, 50)
    : cat === RECENT_LABEL
      ? recent.filter((n) => names.includes(n))
      : names.filter((n) => typeMap[n] === cat)

  if (!token) {
    return (
      <div className="p-6 flex flex-col items-center justify-center min-h-[70svh] gap-6">
        <div className="text-6xl">📖</div>
        <h1 className="text-xl font-bold text-amber-800">レシピ参照</h1>
        <button
          onClick={login}
          className="bg-amber-700 text-[#faf9f5] px-6 py-3 rounded-xl font-semibold shadow active:scale-95 transition-transform"
        >
          Googleでログイン
        </button>
      </div>
    )
  }

  const numField = (
    label: string,
    value: string,
    setValue: (s: string) => void,
    col: string,
    current: number | null | undefined,
    applyLocal: (v: number | null) => void,
    suffix: string,
    placeholder = '',
  ) => (
    <div>
      <label className="block text-xs text-stone-600 mb-1">{label}</label>
      <div className="flex items-center border border-stone-400 rounded-lg px-2 py-2 bg-white focus-within:border-amber-500">
        <input
          type="number"
          inputMode="decimal"
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => saveCell(col, value, current, applyLocal)}
          className="w-full min-w-0 text-right text-base text-stone-900 outline-none"
        />
        <span className="text-xs text-stone-500 ml-1 shrink-0">{suffix}</span>
      </div>
    </div>
  )

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-bold text-amber-800">📖 レシピ参照</h1>
        <button onClick={load} className="text-sm text-stone-500 underline">
          ↻ 更新
        </button>
      </div>
      <p className="text-xs text-stone-500 mb-3">
        金額はすべて<span className="font-semibold">税込み（8%）</span>表示
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

      {/* レシピ一覧 */}
      {!selected && !loading && (
        <>
          <div className="flex gap-2 mb-3">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="レシピ名で検索…"
              className="flex-1 border border-stone-300 rounded-lg px-3 py-2.5 text-base"
            />
            <button
              onClick={() => {
                setCreating((c) => !c)
                setNewName('')
              }}
              className="shrink-0 bg-amber-700 text-[#faf9f5] rounded-lg px-3 font-semibold text-sm"
            >
              ＋新規
            </button>
          </div>

          {creating && (
            <div className="border border-amber-200 bg-amber-50/50 rounded-lg p-3 mb-3 space-y-2">
              <p className="text-sm font-semibold text-stone-700">新しいレシピを作成</p>
              <input
                type="text"
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="レシピ名"
                className="w-full border border-stone-300 rounded-lg px-3 py-2 text-base"
              />
              <select
                value={newType}
                onChange={(e) => setNewType(e.target.value)}
                className="w-full border border-stone-300 rounded-lg px-3 py-2 text-base bg-white"
              >
                {RECIPE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <div className="flex gap-2">
                <button
                  onClick={() => setCreating(false)}
                  className="flex-1 py-2 rounded-lg border border-stone-300 text-stone-600 font-semibold text-sm"
                >
                  キャンセル
                </button>
                <button
                  onClick={createRecipe}
                  disabled={!newName.trim()}
                  className="flex-1 py-2 rounded-lg bg-amber-700 text-[#faf9f5] font-bold text-sm disabled:opacity-40"
                >
                  作成して開く
                </button>
              </div>
            </div>
          )}

          {!search && (
            <div className="flex gap-1.5 overflow-x-auto pb-2 mb-2 -mx-1 px-1">
              {[RECENT_LABEL, ...types].map((t) => (
                <button
                  key={t}
                  onClick={() => setCat(t)}
                  className={`shrink-0 px-4 py-2 rounded-full text-sm font-semibold ${
                    cat === t ? 'bg-amber-700 text-[#faf9f5]' : 'bg-stone-200 text-stone-700'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          )}

          <p className="text-sm text-stone-500 mb-2">
            {search ? `「${search}」の検索結果` : cat} ・ {listed.length} 件
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {listed.map((name) => {
              const s = saleMap[name]
              const total = (recipeMap[name] ?? []).reduce(
                (sum, it) => sum + it.qty * (priceMap[it.name] ?? 0) * TAX,
                0,
              )
              const e = effServings(servingsMap[name], yieldMap[name], swMap[name])
              const perCost = e ? total / e : total
              const rate = s && s > 0 ? (perCost / s) * 100 : null
              return (
                <button
                  key={name}
                  onClick={() => openRecipe(name)}
                  className="w-full text-left border border-stone-300 rounded-xl px-3 py-3 active:bg-stone-50"
                >
                  <p className="text-base font-semibold text-stone-900 truncate">{name}</p>
                  <div className="mt-1.5 flex gap-3 flex-wrap text-sm">
                    <span className="text-stone-600">
                      一食原価{' '}
                      <span className="font-semibold text-stone-900">
                        ¥{Math.round(perCost).toLocaleString()}
                      </span>
                    </span>
                    <span className="text-stone-600">
                      売価{' '}
                      <span className="font-semibold text-stone-900">
                        {s != null ? `¥${s.toLocaleString()}` : '—'}
                      </span>
                    </span>
                    {rate != null && (
                      <span
                        className={`font-bold px-1.5 rounded ${
                          rate > 35 ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'
                        }`}
                      >
                        原価率 {rate.toFixed(0)}%
                      </span>
                    )}
                  </div>
                </button>
              )
            })}
            {listed.length === 0 && (
              <p className="text-center text-stone-400 text-sm py-8">
                該当するレシピがありません
              </p>
            )}
          </div>
        </>
      )}

      {/* レシピ詳細 */}
      {selected && (
        <>
          <button onClick={() => setSelected(null)} className="text-stone-500 text-sm mb-3">
            ← レシピ一覧へ
          </button>
          <div className="flex items-center justify-between gap-2 mb-3">
            <h2 className="text-lg font-bold text-stone-900 min-w-0 truncate">{selected}</h2>
            <select
              value={typeMap[selected] ?? 'その他'}
              onChange={(e) => saveType(e.target.value)}
              className="shrink-0 border border-stone-300 rounded-lg px-2 py-1 text-sm text-amber-700 bg-white"
            >
              {RECIPE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2 mb-3">
            {rows.map((r) => (
              <div
                key={r.row}
                className={`border rounded-lg p-2.5 ${
                  r.price === 0 ? 'border-amber-200 bg-amber-50/40' : 'border-stone-200'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={nameVals[r.row] !== undefined ? nameVals[r.row] : r.name}
                    onChange={(e) =>
                      setNameVals((p) => ({ ...p, [r.row]: e.target.value }))
                    }
                    onBlur={(e) => saveDetail(r, 'name', 'B', e.target.value)}
                    className="flex-1 min-w-0 border border-stone-300 rounded px-2 py-1.5 text-base font-medium text-stone-900 outline-none focus:border-amber-400"
                  />
                  <input
                    type="number"
                    inputMode="decimal"
                    value={qtyVals[r.row] !== undefined ? qtyVals[r.row] : String(r.qty)}
                    onChange={(e) =>
                      setQtyVals((p) => ({ ...p, [r.row]: e.target.value }))
                    }
                    onBlur={(e) => saveDetail(r, 'qty', 'C', e.target.value)}
                    className="w-16 border border-stone-300 rounded px-1.5 py-1.5 text-right text-base outline-none focus:border-amber-400"
                  />
                  <input
                    type="text"
                    value={unitVals[r.row] !== undefined ? unitVals[r.row] : r.unit}
                    onChange={(e) =>
                      setUnitVals((p) => ({ ...p, [r.row]: e.target.value }))
                    }
                    onBlur={(e) => saveDetail(r, 'unit', 'D', e.target.value)}
                    className="w-10 border border-stone-300 rounded px-1 py-1.5 text-center text-sm outline-none focus:border-amber-400"
                  />
                  <button
                    onClick={() => deleteRow(r)}
                    className="text-stone-300 text-xl px-1 shrink-0"
                    aria-label="削除"
                  >
                    ×
                  </button>
                </div>
                <div className="flex items-center justify-between mt-1">
                  <input
                    type="text"
                    value={memoVals[r.row] !== undefined ? memoVals[r.row] : r.memo}
                    onChange={(e) =>
                      setMemoVals((p) => ({ ...p, [r.row]: e.target.value }))
                    }
                    onBlur={() => saveMemo(r)}
                    placeholder="メモ（切り方・タイミングなど）"
                    className="flex-1 min-w-0 border border-stone-200 rounded px-2 py-1 text-sm bg-stone-50 focus:bg-white focus:border-amber-400 outline-none"
                  />
                  <span className="text-xs text-stone-500 shrink-0 ml-2">
                    原価 ¥{Math.round(r.cost).toLocaleString()}
                    {r.price === 0 && <span className="text-amber-600">(未設定)</span>}
                  </span>
                </div>
              </div>
            ))}
            {rows.length === 0 && (
              <p className="text-center text-stone-400 text-sm py-4">
                食材明細がありません
              </p>
            )}
            <button
              onClick={addRow}
              className="w-full border border-dashed border-stone-300 rounded-lg py-2 text-sm text-amber-700 font-semibold active:bg-stone-50"
            >
              ＋ 食材を追加
            </button>
          </div>

          {unknownCount > 0 && (
            <p className="text-xs text-amber-600 mb-3">
              ※ {unknownCount} 件の食材が単価未設定です。「食材」タブで設定すると正確になります。
            </p>
          )}

          {/* 出来高（総重量・一食重量・食数） */}
          <div className="grid grid-cols-3 gap-2 mb-3">
            {numField('総重量', totalWeight, setTotalWeight, YIELD_COL, yieldMap[selected], (v) =>
              setYieldMap((p) => ({ ...p, [selected]: v })), 'g')}
            {numField('一食重量', servingWeight, setServingWeight, SERVING_WEIGHT_COL, swMap[selected], (v) =>
              setSwMap((p) => ({ ...p, [selected]: v })), 'g')}
            {numField('食数', servings, setServings, SERVINGS_COL, servingsMap[selected], (v) =>
              setServingsMap((p) => ({ ...p, [selected]: v })), '食', eff ? String(Math.round(eff * 10) / 10) : '')}
          </div>
          {savingField && <p className="text-xs text-stone-400 mb-2">保存中…</p>}

          <div className="bg-stone-50 rounded-xl p-4 space-y-2.5">
            <div className="flex justify-between text-sm">
              <span className="text-stone-500">合計原価（税込・全体）</span>
              <span className="font-semibold text-stone-800">
                ¥{Math.round(totalCost).toLocaleString()}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-stone-500">食数</span>
              <span className="font-semibold text-stone-800">
                {eff ? `${Math.round(eff * 10) / 10} 食` : '未設定'}
              </span>
            </div>
            <div className="flex justify-between items-center border-t border-stone-200 pt-2">
              <span className="text-stone-600">一食あたり原価（税込）</span>
              <span className="text-xl font-bold text-stone-900">
                ¥{Math.round(perServingCost).toLocaleString()}
              </span>
            </div>
            <div className="pt-1">
              <label className="flex justify-between text-sm text-stone-500 mb-1">
                <span>販売価格（税込・一食）</span>
              </label>
              <input
                type="number"
                inputMode="numeric"
                value={salePrice}
                onChange={(e) => setSalePrice(e.target.value)}
                onBlur={() =>
                  saveCell(SALE_COL, salePrice, saleMap[selected], (v) =>
                    setSaleMap((p) => ({ ...p, [selected]: v })),
                  )
                }
                placeholder="例: 1500"
                className="w-full border border-stone-300 rounded-lg px-3 py-2.5 text-lg"
              />
            </div>
            {sale > 0 && (
              <div className="grid grid-cols-2 gap-3 pt-1">
                <div className="bg-white rounded-lg p-3 text-center">
                  <p className="text-xs text-stone-400">原価率（一食）</p>
                  <p
                    className={`text-xl font-bold ${
                      costRate > 35 ? 'text-red-500' : 'text-green-600'
                    }`}
                  >
                    {costRate.toFixed(1)}%
                  </p>
                </div>
                <div className="bg-white rounded-lg p-3 text-center">
                  <p className="text-xs text-stone-400">粗利（一食）</p>
                  <p className="text-xl font-bold text-stone-800">
                    ¥{Math.round(profit).toLocaleString()}
                  </p>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
