import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../lib/auth'
import { readRange, updateValues, appendRows, AuthExpiredError } from '../lib/sheets'
import { getRecent, pushRecent, RECENT_KEYS, RECENT_LABEL } from '../lib/recent'
import { usePersistedState } from '../lib/persistState'
import { getCached, setCached } from '../lib/dataCache'
import { useRegisterBack } from '../lib/backHandler'

type FieldKey = 'weight' | 'unitPrice' | 'stock' | 'threshold'

type Ingredient = {
  row: number
  name: string
  category: string
  unit: string
  pricePerG: number | null // D 単価(円/g)
  supplier: string
  count: number
  weight: number | null // G 単品重量
  stock: number | null // H 在庫
  unitPrice: number | null // I 単品価格
  threshold: number | null // J アラート閾値
}

const COLS: Record<FieldKey, string> = {
  weight: 'G',
  unitPrice: 'I',
  stock: 'H',
  threshold: 'J',
}

const VISIBLE_LIMIT = 80

function num(s: string | undefined): number | null {
  const t = (s ?? '').trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isNaN(n) ? null : n
}

function fmtPerG(x: number): string {
  return parseFloat(x.toFixed(4)).toString()
}

export default function IngredientsPage() {
  const { token, login, logout } = useAuth()
  const [list, setList] = useState<Ingredient[]>(
    () => getCached<Ingredient[]>('ing_list') ?? [],
  )
  const [search, setSearch] = usePersistedState('kbtr_view_ing_search', '')
  const [cat, setCat] = usePersistedState<string | null>('kbtr_view_ing_cat', RECENT_LABEL)
  const [recent, setRecent] = useState<string[]>(() => getRecent(RECENT_KEYS.ingredient))
  const [onlyUnset, setOnlyUnset] = useState(false)
  const [onlyAlert, setOnlyAlert] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [edits, setEdits] = useState<Record<number, Partial<Record<FieldKey, string>>>>({})
  const [savingRow, setSavingRow] = useState<number | null>(null)
  const [savedRow, setSavedRow] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
  const [newIng, setNewIng] = useState({ name: '', category: '', unit: 'g', supplier: '' })
  const [addBusy, setAddBusy] = useState(false)

  // スワイプ戻し：新規追加フォームを閉じる
  useRegisterBack(() => {
    if (adding) { setAdding(false); return true }
    return false
  })

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
      const rows = await readRange(token, '食材マスタ!A2:J')
      const parsed: Ingredient[] = rows
        .map((r, i) => ({
          row: i + 2,
          name: (r[0] ?? '').trim(),
          category: (r[1] ?? '').trim(),
          unit: (r[2] ?? '').trim(),
          pricePerG: num(r[3]),
          supplier: (r[4] ?? '').trim(),
          count: Number(r[5]) || 0,
          weight: num(r[6]),
          stock: num(r[7]),
          unitPrice: num(r[8]),
          threshold: num(r[9]),
        }))
        .filter((x) => x.name)
      parsed.sort((a, b) => b.count - a.count)
      setList(parsed)
      setCached('ing_list', parsed)
    } catch (e) {
      if (!silent) handleAuthError(e)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [token, handleAuthError])

  useEffect(() => {
    load(!!getCached('ing_list'))
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

  const saveField = async (ing: Ingredient, field: FieldKey) => {
    if (!token) return
    const raw = edits[ing.row]?.[field]
    if (raw === undefined) return
    const newVal = num(raw)
    // 入力が数値でない（空でもない）→ 無効。空ならnull(=クリア)として許可
    if (raw.trim() !== '' && newVal === null) {
      clearEdit(ing.row, field)
      return
    }
    if (newVal === ing[field]) {
      clearEdit(ing.row, field)
      return
    }
    setSavingRow(ing.row)
    setError(null)
    try {
      await updateValues(token, `食材マスタ!${COLS[field]}${ing.row}`, [
        [newVal === null ? '' : newVal],
      ])
      const updated: Ingredient = { ...ing, [field]: newVal }
      // 重量・単品価格の変更時は単価(D)を再計算して保存
      if (field === 'weight' || field === 'unitPrice') {
        const w = field === 'weight' ? newVal : ing.weight
        const p = field === 'unitPrice' ? newVal : ing.unitPrice
        if (w && w > 0 && p !== null) {
          const per = Math.round((p / w) * 10000) / 10000
          await updateValues(token, `食材マスタ!D${ing.row}`, [[per]])
          updated.pricePerG = per
        }
      }
      setList((prev) => prev.map((x) => (x.row === ing.row ? updated : x)))
      setRecent(pushRecent(RECENT_KEYS.ingredient, ing.name))
      clearEdit(ing.row, field)
      setSavedRow(ing.row)
      setTimeout(() => setSavedRow(null), 1500)
    } catch (e) {
      handleAuthError(e)
    } finally {
      setSavingRow(null)
    }
  }

  const addIngredient = async () => {
    if (!token) return
    const name = newIng.name.trim()
    if (!name) return
    if (list.some((x) => x.name === name)) {
      setError('同名の食材が既にあります')
      return
    }
    setAddBusy(true)
    setError(null)
    try {
      await appendRows(token, '食材マスタ!A:E', [
        [name, newIng.category.trim(), newIng.unit.trim() || 'g', '', newIng.supplier.trim()],
      ])
      setAdding(false)
      setNewIng({ name: '', category: '', unit: 'g', supplier: '' })
      setCached('ing_list', null as unknown as Ingredient[])
      await load()
    } catch (e) {
      handleAuthError(e)
    } finally {
      setAddBusy(false)
    }
  }

  const isAlert = (x: Ingredient) =>
    x.stock !== null && x.threshold !== null && x.stock < x.threshold

  // 分類リスト（出現数の多い順）
  const categories = (() => {
    const c: Record<string, number> = {}
    for (const x of list) c[x.category || 'その他'] = (c[x.category || 'その他'] ?? 0) + 1
    return Object.entries(c)
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k)
  })()

  const base = list
    .filter((x) => (search ? x.name.includes(search) : true))
    .filter((x) => (onlyUnset ? x.pricePerG === null || x.pricePerG === 0 : true))
    .filter((x) => (onlyAlert ? isAlert(x) : true))

  let filtered: Ingredient[]
  if (search) {
    filtered = base
  } else if (cat === RECENT_LABEL) {
    const order = new Map(recent.map((n, i) => [n, i]))
    filtered = base
      .filter((x) => order.has(x.name))
      .sort((a, b) => order.get(a.name)! - order.get(b.name)!)
  } else if (cat === null) {
    filtered = base // 全て
  } else {
    filtered = base.filter((x) => (x.category || 'その他') === cat)
  }
  const shown =
    search || cat === RECENT_LABEL ? filtered : filtered.slice(0, VISIBLE_LIMIT)
  const unsetCount = list.filter((x) => x.pricePerG === null || x.pricePerG === 0).length
  const alertCount = list.filter(isAlert).length

  if (!token) {
    return (
      <div className="p-6 flex flex-col items-center justify-center min-h-[70svh] gap-6">
        <div className="text-6xl">🥬</div>
        <h1 className="text-xl font-bold text-amber-800">食材マスタ</h1>
        <button
          onClick={login}
          className="bg-amber-700 text-[#faf9f5] px-6 py-3 rounded-xl font-semibold shadow active:scale-95 transition-transform"
        >
          Googleでログイン
        </button>
      </div>
    )
  }

  const renderField = (
    ing: Ingredient,
    field: FieldKey,
    label: string,
    suffix: string,
    placeholder: string,
  ) => {
    const editVal = edits[ing.row]?.[field]
    const stored = ing[field]
    const value = editVal !== undefined ? editVal : stored === null ? '' : String(stored)
    return (
      <div>
        <label className="block text-xs text-stone-600 mb-1">{label}</label>
        <div className="flex items-center border border-stone-400 rounded-lg px-2 py-2 bg-white focus-within:border-amber-500">
          <input
            type="number"
            inputMode="decimal"
            step="0.01"
            value={value}
            placeholder={placeholder}
            onChange={(e) =>
              setEdits((p) => ({
                ...p,
                [ing.row]: { ...p[ing.row], [field]: e.target.value },
              }))
            }
            onBlur={() => saveField(ing, field)}
            className="w-full min-w-0 text-right text-base text-stone-900 outline-none"
          />
          <span className="text-xs text-stone-500 ml-1 shrink-0">{suffix}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-bold text-amber-800">🥬 食材マスタ</h1>
        <div className="flex gap-2">
          <button
            onClick={() => { setAdding((v) => !v); setNewIng({ name: '', category: '', unit: 'g', supplier: '' }) }}
            className="text-sm bg-amber-700 text-[#faf9f5] px-3 py-1 rounded-lg font-semibold"
          >
            ＋新規
          </button>
          <button onClick={() => load()} className="text-sm text-stone-500 border border-stone-200 rounded-lg px-2 py-1">
            ↻
          </button>
        </div>
      </div>
      <p className="text-xs text-stone-500 mb-3">
        単価・単品価格は<span className="font-semibold">税抜き</span>で入力
      </p>

      {adding && (
        <div className="border border-amber-200 bg-amber-50/50 rounded-xl p-3 mb-4 space-y-2">
          <p className="text-sm font-semibold text-stone-700">新しい食材を追加</p>
          <input
            type="text"
            autoFocus
            value={newIng.name}
            onChange={(e) => setNewIng((p) => ({ ...p, name: e.target.value }))}
            placeholder="食材名（必須）"
            className="w-full border border-stone-300 rounded-lg px-3 py-2 text-base"
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              value={newIng.category}
              onChange={(e) => setNewIng((p) => ({ ...p, category: e.target.value }))}
              placeholder="分類（例：スパイス）"
              className="border border-stone-300 rounded-lg px-3 py-2 text-sm"
            />
            <input
              type="text"
              value={newIng.unit}
              onChange={(e) => setNewIng((p) => ({ ...p, unit: e.target.value }))}
              placeholder="単位（例：g）"
              className="border border-stone-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <input
            type="text"
            value={newIng.supplier}
            onChange={(e) => setNewIng((p) => ({ ...p, supplier: e.target.value }))}
            placeholder="仕入先（任意）"
            className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm"
          />
          <div className="flex gap-2">
            <button
              onClick={() => setAdding(false)}
              className="flex-1 py-2 rounded-lg border border-stone-300 text-stone-600 font-semibold text-sm"
            >
              キャンセル
            </button>
            <button
              onClick={addIngredient}
              disabled={addBusy || !newIng.name.trim()}
              className="flex-1 py-2 rounded-lg bg-amber-700 text-[#faf9f5] font-bold text-sm disabled:opacity-40"
            >
              {addBusy ? '追加中...' : '追加'}
            </button>
          </div>
        </div>
      )}

      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="食材名で検索…"
        className="w-full border border-stone-300 rounded-lg px-3 py-2.5 text-base mb-2"
      />

      {!search && (
        <div className="flex gap-1.5 overflow-x-auto pb-2 mb-1 -mx-1 px-1">
          <button
            onClick={() => setCat(RECENT_LABEL)}
            className={`shrink-0 px-4 py-2 rounded-full text-sm font-semibold ${
              cat === RECENT_LABEL ? 'bg-amber-700 text-[#faf9f5]' : 'bg-stone-200 text-stone-700'
            }`}
          >
            {RECENT_LABEL}
          </button>
          <button
            onClick={() => setCat(null)}
            className={`shrink-0 px-4 py-2 rounded-full text-sm font-semibold ${
              cat === null ? 'bg-amber-700 text-[#faf9f5]' : 'bg-stone-200 text-stone-700'
            }`}
          >
            全て
          </button>
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setCat(c)}
              className={`shrink-0 px-4 py-2 rounded-full text-sm font-semibold ${
                cat === c ? 'bg-amber-700 text-[#faf9f5]' : 'bg-stone-200 text-stone-700'
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3 mb-3 text-sm flex-wrap">
        <label className="flex items-center gap-1.5 text-stone-600">
          <input
            type="checkbox"
            checked={onlyUnset}
            onChange={(e) => setOnlyUnset(e.target.checked)}
          />
          単価未設定 ({unsetCount})
        </label>
        <label className="flex items-center gap-1.5 text-stone-600">
          <input
            type="checkbox"
            checked={onlyAlert}
            onChange={(e) => setOnlyAlert(e.target.checked)}
          />
          在庫アラート ({alertCount})
        </label>
        <span className="text-stone-400 ml-auto">全 {list.length} 件</span>
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

      <div className="grid gap-2 sm:grid-cols-2">
        {shown.map((ing) => {
          const alert = isAlert(ing)
          // 単価のライブ計算（編集中の値を反映）
          const liveW =
            edits[ing.row]?.weight !== undefined
              ? num(edits[ing.row]!.weight)
              : ing.weight
          const liveP =
            edits[ing.row]?.unitPrice !== undefined
              ? num(edits[ing.row]!.unitPrice)
              : ing.unitPrice
          const perG =
            liveW && liveW > 0 && liveP !== null ? liveP / liveW : ing.pricePerG
          return (
            <div
              key={ing.row}
              className={`border rounded-xl px-3 py-2 ${
                alert
                  ? 'border-red-300 bg-red-50/50'
                  : ing.pricePerG === null || ing.pricePerG === 0
                    ? 'border-amber-200 bg-amber-50/40'
                    : 'border-stone-200'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-base font-semibold text-stone-900 truncate">
                    {ing.name}
                  </p>
                  <p className="text-xs text-stone-500">
                    {ing.category} ・ {ing.supplier || '仕入先未設定'} ・ {ing.count}回
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {alert && (
                    <span className="text-xs bg-red-100 text-red-700 font-bold px-2 py-0.5 rounded">
                      ⚠️在庫少
                    </span>
                  )}
                  <span className="w-4 text-center">
                    {savingRow === ing.row ? (
                      <span className="text-stone-400 text-xs">…</span>
                    ) : savedRow === ing.row ? (
                      <span className="text-green-500">✓</span>
                    ) : null}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 mt-2">
                {renderField(ing, 'weight', '単品重量', 'g', '')}
                {renderField(ing, 'unitPrice', '単品価格（税抜）', '円', '')}
              </div>

              <div className="mt-2 bg-stone-100 rounded-lg px-3 py-1.5 flex items-center justify-between">
                <span className="text-sm text-stone-500">単価（税抜・自動）</span>
                <span className="text-base font-bold text-stone-900">
                  {perG !== null ? `¥${fmtPerG(perG)} / ${ing.unit || 'g'}` : '—'}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 mt-2">
                {renderField(ing, 'stock', '在庫', 'g', 'N/A')}
                {renderField(ing, 'threshold', 'アラート閾値', 'g', 'N/A')}
              </div>
            </div>
          )
        })}
      </div>

      {!search && cat !== RECENT_LABEL && filtered.length > VISIBLE_LIMIT && (
        <p className="text-center text-stone-400 text-sm py-4">
          上位 {VISIBLE_LIMIT} 件を表示中。検索で絞り込めます（全 {filtered.length} 件）
        </p>
      )}
      {shown.length === 0 && !loading && (
        <p className="text-center text-stone-400 text-sm py-8">
          {!search && cat === RECENT_LABEL
            ? 'まだ編集した食材がありません。分類から選ぶか検索してください。'
            : '条件に一致する食材がありません'}
        </p>
      )}
    </div>
  )
}
