import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../lib/auth'
import { ConfirmModal } from '../components/ConfirmModal'
import { Spinner } from '../components/Spinner'
import {
  readRange,
  updateValues,
  appendRows,
  deleteRow,
  deleteRows,
  getSheetId,
  AuthExpiredError,
} from '../lib/sheets'
import { usePersistedState } from '../lib/persistState'
import { useRegisterBack } from '../lib/backHandler'
import { getCached, setCached, clearCache } from '../lib/dataCache'
import { getEventData } from '../lib/eventData'
import { useKeyboardOffset } from '../lib/useKeyboardOffset'
import { perServingCost, type CostCtx } from '../lib/cost'
import type { DetailItem } from '../lib/recipes'

const TORIOKI_RECIPE_KEY = 'kbtr_torioki_recipe'

// PosPage と同じ recipe_data キャッシュの形（必要分のみ）
type RecipeDataCache = {
  priceMap: Record<string, number>
  recipeMap: Record<string, DetailItem[]>
  yieldMap: Record<string, number | null>
  swMap: Record<string, number | null>
  servingsMap: Record<string, number | null>
  names: string[]
}
function getRecipeCtx(): { ctx: CostCtx | null; names: string[] } {
  const c = getCached<RecipeDataCache>('recipe_data')
  if (!c) return { ctx: null, names: [] }
  return {
    ctx: {
      recipeMap: c.recipeMap,
      priceMap: c.priceMap,
      yieldMap: c.yieldMap,
      servingWeightMap: c.swMap,
      servingsMap: c.servingsMap,
    },
    names: c.names ?? [],
  }
}
// レジのメニュー（名前→価格・レシピ）
type PosMenu = { name: string; price: number; recipe: string }
function getPosMenus(): PosMenu[] {
  return getCached<PosMenu[]>('pos_menus') ?? []
}

type Summary = {
  idx: number
  date: string
  sales: number
  foodCost: number
  locationFee: number
  otherCost: number
  uzuraCost: number
  profit: number
  memo: string
  groups: number // J列：組数
  people: number // K列：客数
  actualCost: number // L列：実仕入れ
}
type SaleRec = { date: string; menu: string; qty: number; subtotal: number }

const yen = (n: number) => `¥${Math.round(n).toLocaleString()}`
type DashTab = 'summary' | 'products' | 'prep'
type Period = 'all' | 'last4' | 'last8'
const monthOf = (d: string) => d.slice(0, 7) // YYYY-MM
const thisMonth = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
const todayStr = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// 旧データ（localStorage）をフォールバック参照
const actualCostOf = (s: Summary) =>
  s.actualCost > 0 ? s.actualCost : getEventData(s.date).cost ?? 0
const groupsOf = (s: Summary) =>
  s.groups > 0 ? s.groups : getEventData(s.date).groups ?? 0
const peopleOf = (s: Summary) => {
  if (s.people > 0) return s.people
  const ev = getEventData(s.date)
  if (ev.people != null && ev.people > 0) return ev.people
  return groupsOf(s) // 客数が無ければ組数で代用
}

// メニューエンジニアリング4象限のランク表示
type Rank = 'star' | 'plow' | 'puzzle' | 'dog'
const RANK_META: Record<Rank, { label: string; cls: string }> = {
  star: { label: '看板', cls: 'bg-green-100 text-green-700' },
  plow: { label: '集客', cls: 'bg-amber-100 text-amber-800' },
  puzzle: { label: '隠れ', cls: 'bg-stone-200 text-stone-700' },
  dog: { label: '見直し', cls: 'bg-red-100 text-red-600' },
}

export default function DashboardPage() {
  const { token, login, logout } = useAuth()
  const [summaries, setSummaries] = useState<Summary[]>(
    () => getCached<Summary[]>('dash_summaries') ?? [],
  )
  const [records, setRecords] = useState<SaleRec[]>(
    () => getCached<SaleRec[]>('dash_records') ?? [],
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = usePersistedState<string | null>(
    'kbtr_view_dash_open',
    null,
  )
  const [editId, setEditId] = useState<string | null>(null)
  const [edit, setEdit] = useState({
    date: '',
    sales: '',
    foodCost: '',
    locationFee: '',
    otherCost: '',
    memo: '',
    toriokiN: '',
    toriokiRecipe: '',
    groups: '',
    people: '',
    actualCost: '',
  })
  const [recipeNames, setRecipeNames] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [confirmTarget, setConfirmTarget] = useState<Summary | null>(null)
  const migratedRef = useRef(false)

  // メニュー別（営業記録）の編集
  const [menuEditId, setMenuEditId] = useState<string | null>(null)
  const [menuEdit, setMenuEdit] = useState<{ menu: string; qty: string; price: number }[]>([])

  const [dashTab, setDashTab] = usePersistedState<DashTab>('kbtr_view_dash_tab', 'summary')
  const [period, setPeriod] = usePersistedState<Period>('kbtr_view_dash_period', 'all')
  const [targetInput, setTargetInput] = useState('')
  useKeyboardOffset()

  // スワイプ戻し：メニュー編集→詳細、編集→詳細、詳細→閉じる
  useRegisterBack(() => {
    if (menuEditId) { setMenuEditId(null); return true }
    if (editId) { setEditId(null); return true }
    if (openId) { setOpenId(null); return true }
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

  // 旧localStorageの組数/客数/実仕入れを、空のJ/K/L列へ自動移行（1回のみ・冪等）
  const migrateLocal = useCallback(
    async (rawRows: string[][]) => {
      if (!token || migratedRef.current) return
      const writes: { row: number; vals: (number | string)[] }[] = []
      rawRows.forEach((r, i) => {
        const date = (r[0] ?? '').trim()
        if (!date) return
        const gBlank = (r[9] ?? '').trim() === ''
        const pBlank = (r[10] ?? '').trim() === ''
        const cBlank = (r[11] ?? '').trim() === ''
        if (!gBlank && !pBlank && !cBlank) return
        const ev = getEventData(date)
        const fills =
          (gBlank && ev.groups != null) ||
          (pBlank && ev.people != null) ||
          (cBlank && ev.cost != null)
        if (!fills) return
        writes.push({
          row: i + 2,
          vals: [
            gBlank ? ev.groups ?? '' : Number(r[9]) || 0,
            pBlank ? ev.people ?? '' : Number(r[10]) || 0,
            cBlank ? ev.cost ?? '' : Number(r[11]) || 0,
          ],
        })
      })
      if (writes.length === 0) return
      migratedRef.current = true
      try {
        for (const w of writes) {
          await updateValues(token, `営業サマリー!J${w.row}:L${w.row}`, [w.vals])
        }
        clearCache('dash_summaries')
        await load(true)
      } catch {
        /* 移行失敗は致命的でない（次回再試行） */
        migratedRef.current = false
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token],
  )

  const load = useCallback(async (silent = false) => {
    if (!token) return
    if (!silent) setLoading(true)
    setError(null)
    try {
      const [sum, rec] = await Promise.all([
        readRange(token, '営業サマリー!A2:L'),
        readRange(token, '営業記録!A2:E'),
      ])
      const newSummaries: Summary[] = sum
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => (r[0] ?? '').trim())
        .map(({ r, i }) => ({
          idx: i,
          date: (r[0] ?? '').trim(),
          sales: Number(r[1]) || 0,
          foodCost: Number(r[2]) || 0,
          locationFee: Number(r[3]) || 0,
          profit: Number(r[4]) || 0,
          memo: (r[6] ?? '').trim(),
          otherCost: Number(r[7]) || 0,
          uzuraCost: Number(r[8]) || 0,
          groups: Number(r[9]) || 0,
          people: Number(r[10]) || 0,
          actualCost: Number(r[11]) || 0,
        }))
      // 営業履歴（営業サマリー）に存在する日付のものだけを商品別集計の対象にする
      const validDates = new Set(newSummaries.map((s) => s.date))
      // 締めを複数回行った等で生じる「同一日・同一メニュー・同一数量・同一金額」の
      // 重複行は二重計上になるため除外する
      const seenRec = new Set<string>()
      const newRecords = rec
        .filter((r) => (r[0] ?? '').trim() && (r[1] ?? '').trim())
        .map((r) => ({
          date: (r[0] ?? '').trim(),
          menu: (r[1] ?? '').trim(),
          qty: Number(r[2]) || 0,
          subtotal: Number(r[4]) || 0,
        }))
        .filter((r) => validDates.has(r.date))
        .filter((r) => {
          const k = `${r.date}|${r.menu}|${r.qty}|${r.subtotal}`
          if (seenRec.has(k)) return false
          seenRec.add(k)
          return true
        })
      setSummaries(newSummaries)
      setRecords(newRecords)
      setCached('dash_summaries', newSummaries)
      setCached('dash_records', newRecords)
      // 初回のみ：ローカルデータをシートへ自動移行（内部で1回ガード）
      migrateLocal(sum)
    } catch (e) {
      if (!silent) handleAuthError(e)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [token, handleAuthError, migrateLocal])

  useEffect(() => {
    const hasCached =
      getCached('dash_summaries') !== null && getCached('dash_records') !== null
    load(hasCached)
  }, [load])

  // 取り置き原価（人数×1食原価）を計算
  const calcUzuraCost = (countStr: string, recipe: string): number => {
    const count = Number(countStr) || 0
    if (count <= 0 || !recipe) return 0
    const { ctx } = getRecipeCtx()
    if (!ctx) return 0
    return Math.round(count * perServingCost(recipe, ctx))
  }

  const startEdit = (s: Summary, sid: string) => {
    const { names } = getRecipeCtx()
    setRecipeNames(names)
    // 既存のうずら原価から人数を逆算（レシピは前回保存値を既定に）
    const savedRecipe = localStorage.getItem(TORIOKI_RECIPE_KEY) ?? ''
    let countGuess = ''
    if (s.uzuraCost > 0 && savedRecipe) {
      const { ctx } = getRecipeCtx()
      const per = ctx ? perServingCost(savedRecipe, ctx) : 0
      if (per > 0) countGuess = String(Math.round(s.uzuraCost / per))
    }
    setEditId(sid)
    setEdit({
      date: s.date,
      sales: String(s.sales),
      foodCost: String(s.foodCost),
      locationFee: String(s.locationFee),
      otherCost: String(s.otherCost),
      memo: s.memo,
      toriokiN: countGuess,
      toriokiRecipe: s.uzuraCost > 0 ? savedRecipe : '',
      groups: groupsOf(s) > 0 ? String(groupsOf(s)) : '',
      people: peopleOf(s) > 0 ? String(peopleOf(s)) : '',
      actualCost: actualCostOf(s) > 0 ? String(actualCostOf(s)) : '',
    })
  }

  const startNew = () => {
    const { names } = getRecipeCtx()
    setRecipeNames(names)
    setEditId('new')
    setEdit({
      date: todayStr(), sales: '', foodCost: '', locationFee: '5000',
      otherCost: '', memo: '', toriokiN: '', toriokiRecipe: '',
      groups: '', people: '', actualCost: '',
    })
  }

  const saveEdit = async (s?: Summary) => {
    if (!token) return
    setBusy(true)
    setError(null)
    try {
      const sales = Number(edit.sales) || 0
      const foodCost = Number(edit.foodCost) || 0
      const fee = Number(edit.locationFee) || 0
      const other = Number(edit.otherCost) || 0
      const uzura = calcUzuraCost(edit.toriokiN, edit.toriokiRecipe)
      const profit = sales - foodCost - fee - other - uzura
      const rate = sales > 0 ? Math.round((foodCost / sales) * 1000) / 10 : 0
      const groups = Number(edit.groups) || 0
      const people = Number(edit.people) || 0
      const actual = Number(edit.actualCost) || 0
      const rowVals = [
        edit.date, sales, foodCost, fee, profit, rate, edit.memo, other, uzura,
        groups, people, actual,
      ]
      if (s) {
        const row = s.idx + 2 // A2 が先頭データ行
        await updateValues(token, `営業サマリー!A${row}:L${row}`, [rowVals])
      } else {
        await appendRows(token, '営業サマリー!A:L', [rowVals])
      }
      setEditId(null)
      clearCache('dash_summaries')
      clearCache('dash_records')
      await load()
    } catch (e) {
      handleAuthError(e)
    } finally {
      setBusy(false)
    }
  }

  // メニュー別（営業記録）の編集を開始
  const startMenuEdit = (date: string, sid: string) => {
    const rows = Object.entries(recByDate[date] ?? {})
      .sort((a, b) => b[1].amount - a[1].amount)
      .map(([menu, v]) => ({
        menu,
        qty: String(v.qty),
        price: v.qty > 0 ? Math.round(v.amount / v.qty) : 0,
      }))
    setMenuEdit(rows)
    setMenuEditId(sid)
  }

  // メニュー別の数を保存（当日分を入れ替え）
  const saveMenuEdit = async (date: string) => {
    if (!token) return
    setBusy(true)
    setError(null)
    try {
      const existing = await readRange(token, '営業記録!A2:E')
      const delRows = existing
        .map((r, i) => ({ d: (r[0] ?? '').trim(), rowIdx: i + 1 }))
        .filter((x) => x.d === date)
        .map((x) => x.rowIdx)
      const sheetId = await getSheetId(token, '営業記録')
      if (delRows.length) await deleteRows(token, sheetId, delRows)
      const rows = menuEdit
        .map((m) => ({ menu: m.menu.trim(), qty: Number(m.qty) || 0, price: m.price }))
        .filter((m) => m.menu && m.qty > 0)
        .map((m) => [date, m.menu, m.qty, m.price, m.qty * m.price])
      if (rows.length) await appendRows(token, '営業記録!A:E', rows)
      setMenuEditId(null)
      clearCache('dash_records')
      clearCache('dash_summaries')
      await load()
    } catch (e) {
      handleAuthError(e)
    } finally {
      setBusy(false)
    }
  }

  const removeSession = async (s: Summary) => {
    if (!token) return
    setBusy(true)
    setError(null)
    try {
      const sheetId = await getSheetId(token, '営業サマリー')
      await deleteRow(token, sheetId, s.idx + 1) // 0始まり行（ヘッダー=0）
      // 同じ日付の商品別記録（営業記録）も削除する
      try {
        const recRows = await readRange(token, '営業記録!A2:A')
        const targetRows = recRows
          .map((r, i) => ({ date: (r[0] ?? '').trim(), rowIdx: i + 1 })) // ヘッダー=0、A2=1
          .filter((x) => x.date === s.date)
          .map((x) => x.rowIdx)
        if (targetRows.length > 0) {
          const recSheetId = await getSheetId(token, '営業記録')
          await deleteRows(token, recSheetId, targetRows)
        }
      } catch {
        /* 営業記録の削除に失敗しても営業履歴の削除は成立させる */
      }
      setOpenId(null)
      setEditId(null)
      clearCache('dash_summaries')
      clearCache('dash_records')
      await load()
    } catch (e) {
      handleAuthError(e)
    } finally {
      setBusy(false)
    }
  }

  // ── 集計（今月） ──
  const tm = thisMonth()
  const tmSummaries = summaries.filter((s) => monthOf(s.date) === tm)
  const tmSales = tmSummaries.reduce((a, s) => a + s.sales, 0)
  const tmProfit = tmSummaries.reduce((a, s) => a + s.profit, 0)
  const tmFoodCost = tmSummaries.reduce((a, s) => a + s.foodCost, 0)
  const tmRate = tmSales > 0 ? (tmFoodCost / tmSales) * 100 : null
  const tmPeople = tmSummaries.reduce((a, s) => a + peopleOf(s), 0)
  const avgTicket = tmPeople > 0 ? tmSales / tmPeople : null
  const totalSales = summaries.reduce((a, s) => a + s.sales, 0)

  // 月次 原価チェック（理論 vs 実仕入れ）
  const tmActual = tmSummaries.reduce((a, s) => a + actualCostOf(s), 0)
  const tmMissingActual = tmSummaries.some((s) => actualCostOf(s) <= 0)
  const costDiff = tmActual - tmFoodCost
  const costDiffRate = tmFoodCost > 0 ? (costDiff / tmFoodCost) * 100 : null

  // 営業（新しい順：日付の降順、同日は入力が新しいものを上に）
  const sessions = [...summaries].sort(
    (a, b) => b.date.localeCompare(a.date) || b.idx - a.idx,
  )
  const recentMax = Math.max(1, ...sessions.map((s) => s.sales))
  // 折れ線用: 直近8回を時系列（古い→新しい）に
  const last8 = sessions.slice(0, 8).reverse()

  // 日付ごとのメニュー別内訳
  const recByDate: Record<string, Record<string, { qty: number; amount: number }>> = {}
  for (const r of records) {
    if (!recByDate[r.date]) recByDate[r.date] = {}
    const d = recByDate[r.date]
    if (!d[r.menu]) d[r.menu] = { qty: 0, amount: 0 }
    d[r.menu].qty += r.qty
    d[r.menu].amount += r.subtotal
  }

  // ── 商品別タブ用 ──
  const eventDates = [...new Set(sessions.map((s) => s.date))] // unique dates, desc
  const periodRecords = (() => {
    if (period === 'all') return records
    const n = period === 'last4' ? 4 : 8
    const dates = new Set(eventDates.slice(0, n))
    return records.filter((r) => dates.has(r.date))
  })()
  const productStats = (() => {
    const map: Record<string, { name: string; qty: number; amount: number }> = {}
    for (const r of periodRecords) {
      if (!map[r.menu]) map[r.menu] = { name: r.menu, qty: 0, amount: 0 }
      map[r.menu].qty += r.qty
      map[r.menu].amount += r.subtotal
    }
    return Object.values(map).sort((a, b) => b.amount - a.amount)
  })()
  const totalQty = productStats.reduce((s, p) => s + p.qty, 0)
  const totalAmount = productStats.reduce((s, p) => s + p.amount, 0)

  // メニューエンジニアリング（人気度＝販売数 × 収益性＝1食利益率）で4象限分類
  const productRanked = (() => {
    const { ctx } = getRecipeCtx()
    const pos = getPosMenus()
    const priceOf: Record<string, number> = {}
    const recipeOf: Record<string, string> = {}
    for (const m of pos) { priceOf[m.name] = m.price; recipeOf[m.name] = m.recipe }
    const items = productStats.map((p) => {
      const price = priceOf[p.name] ?? (p.qty > 0 ? Math.round(p.amount / p.qty) : 0)
      const cost = ctx ? perServingCost(recipeOf[p.name] ?? '', ctx) : 0
      const margin = price > 0 ? (price - cost) / price : 0
      const costRate = price > 0 ? (cost / price) * 100 : null
      return { ...p, price, cost, margin, costRate }
    })
    const avgQty = items.length ? items.reduce((s, x) => s + x.qty, 0) / items.length : 0
    const avgMargin = items.length ? items.reduce((s, x) => s + x.margin, 0) / items.length : 0
    return items.map((x) => {
      const pop = x.qty >= avgQty
      const prof = x.margin >= avgMargin
      const rank: Rank = pop && prof ? 'star' : pop && !prof ? 'plow' : !pop && prof ? 'puzzle' : 'dog'
      return { ...x, rank }
    })
  })()
  const hasCostData = productRanked.some((p) => p.costRate != null)

  // ── 仕込み計算タブ用 ──
  const target = Math.max(0, parseInt(targetInput) || 0)
  const prepCalc = (() => {
    if (eventDates.length === 0) return null
    const evts = eventDates.map((date) => ({
      date,
      groups: getEventData(date).groups ?? null,
      menuQty: records
        .filter((r) => r.date === date)
        .reduce((m, r) => { m[r.menu] = (m[r.menu] ?? 0) + r.qty; return m }, {} as Record<string, number>),
    }))
    const withGroups = evts.filter((e) => e.groups != null && e.groups > 0)
    const usePerGroup = withGroups.length >= 3
    const allMenuNames = [...new Set(records.map((r) => r.menu))]
    const sufficient = evts.length >= 3

    if (usePerGroup) {
      const totalGroups = withGroups.reduce((s, e) => s + e.groups!, 0)
      return {
        unit: '人',
        sufficient,
        items: allMenuNames.map((name) => {
          const totalQtyM = withGroups.reduce((s, e) => s + (e.menuQty[name] ?? 0), 0)
          return { name, avg: totalGroups > 0 ? totalQtyM / totalGroups : 0 }
        }).filter((x) => x.avg > 0).sort((a, b) => b.avg - a.avg),
      }
    } else {
      const n = evts.length
      return {
        unit: '回平均',
        sufficient,
        items: allMenuNames.map((name) => {
          const totalQtyM = evts.reduce((s, e) => s + (e.menuQty[name] ?? 0), 0)
          return { name, avg: n > 0 ? totalQtyM / n : 0 }
        }).filter((x) => x.avg > 0).sort((a, b) => b.avg - a.avg),
      }
    }
  })()

  if (!token) {
    return (
      <div className="p-6 flex flex-col items-center justify-center min-h-[70svh] gap-6">
        <div className="text-6xl">📊</div>
        <h1 className="text-xl font-bold text-amber-800">ダッシュボード</h1>
        <button
          onClick={login}
          className="bg-amber-700 text-[#faf9f5] px-6 py-3 rounded-xl font-semibold shadow active:scale-95 transition-transform"
        >
          Googleでログイン
        </button>
      </div>
    )
  }

  const hasData = summaries.length > 0 || records.length > 0

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-xl font-bold text-amber-800">📊 ダッシュボード</h1>
        <button onClick={() => load()} className="text-sm text-stone-500 border border-stone-200 rounded-lg px-2 py-1 active:bg-stone-50">
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

      {loading && <Spinner />}

      {!loading && !hasData && (
        <div className="text-center text-stone-500 text-sm py-12">
          <p>営業データがありません。</p>
          <p className="mt-2">レジで会計・締めをすると、ここに売上が表示されます。</p>
        </div>
      )}

      {hasData && (
        <>
          {/* タブバー */}
          <div className="flex border-b border-stone-200 mb-4">
            {(['summary', 'products', 'prep'] as DashTab[]).map((t) => (
              <button
                key={t}
                onClick={() => setDashTab(t)}
                className={`flex-1 py-2 text-sm font-semibold transition-colors ${
                  dashTab === t
                    ? 'border-b-2 border-amber-600 text-amber-700'
                    : 'text-stone-500'
                }`}
              >
                {t === 'summary' ? 'サマリー' : t === 'products' ? '商品別' : '仕込み計算'}
              </button>
            ))}
          </div>

          {dashTab === 'summary' && <>
          {/* ① 今月ヒーロー */}
          <div className="rounded-2xl border border-stone-200 bg-gradient-to-b from-stone-50 to-white p-5 mb-4">
            <p className="text-xs text-stone-500 mb-0.5">{tm.replace('-', '年')}月の利益</p>
            <p className="text-4xl font-extrabold text-green-700 leading-tight">{yen(tmProfit)}</p>
            <div className="grid grid-cols-3 gap-3 mt-4">
              <HeroStat label="売上" value={yen(tmSales)} />
              <HeroStat label="原価率" value={tmRate != null ? `${tmRate.toFixed(1)}%` : '—'} accent />
              <HeroStat label="客単価" value={avgTicket != null ? yen(avgTicket) : '—'} />
            </div>
            <p className="text-xs text-stone-400 mt-3">累計売上 {yen(totalSales)}</p>
          </div>

          {/* ② 月次 原価チェック（理論 vs 実仕入れ） */}
          {(tmFoodCost > 0 || tmActual > 0) && (
            <Section title="今月の原価チェック">
              <div className="rounded-2xl border border-stone-200 p-4">
                <div className="grid grid-cols-2 gap-3 mb-2">
                  <div>
                    <p className="text-xs text-stone-500">理論原価（レシピ）</p>
                    <p className="text-lg font-bold text-stone-900">{yen(tmFoodCost)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-stone-500">実仕入れ（実費）</p>
                    <p className="text-lg font-bold text-stone-900">
                      {tmActual > 0 ? yen(tmActual) : '—'}
                    </p>
                  </div>
                </div>
                {tmActual > 0 && (
                  <div className="flex items-center justify-between border-t border-stone-100 pt-2">
                    <span className="text-sm text-stone-500">差額（実仕入れ − 理論）</span>
                    <span className={`font-bold ${costDiff > 0 ? 'text-red-600' : 'text-green-700'}`}>
                      {costDiff >= 0 ? '+' : '−'}{yen(Math.abs(costDiff))}
                      {costDiffRate != null && (
                        <span className="text-xs ml-1 text-stone-400">
                          ({costDiff >= 0 ? '+' : '−'}{Math.abs(costDiffRate).toFixed(0)}%)
                        </span>
                      )}
                    </span>
                  </div>
                )}
                <p className="text-xs text-stone-400 mt-2 leading-relaxed">
                  {tmActual <= 0
                    ? 'レジの締めで「仕入れ実費」を入力すると、理論原価との差を確認できます。'
                    : costDiff > 0
                      ? 'プラス＝ロス・廃棄・まとめ買いの在庫増の可能性。米のまとめ買いはここで吸収されます。'
                      : 'マイナス＝在庫の取り崩し（前回までの仕入れを今月消費）。'}
                  {tmMissingActual && tmActual > 0 && ' ※実費未入力の営業があります。'}
                </p>
              </div>
            </Section>
          )}

          {/* ③ 売上・利益の推移（折れ線1枚） */}
          {last8.length > 0 && (
            <Section title="売上・利益の推移（直近8回）">
              <LineChart
                data={last8.map((s) => ({
                  label: s.date.slice(5).replace('-', '/'),
                  sales: s.sales,
                  profit: s.profit,
                }))}
              />
              <div className="flex gap-4 justify-center text-xs mt-1">
                <span className="text-stone-500">
                  <span style={{ color: '#d9824f' }}>●</span> 売上
                </span>
                <span className="text-stone-500">
                  <span style={{ color: '#6bcf8c' }}>●</span> 利益
                </span>
              </div>
            </Section>
          )}

          {/* ④ 営業履歴（カード一覧／タップで詳細） */}
          <Section title="営業履歴" extra={
            <button
              onClick={startNew}
              className="text-xs bg-amber-700 text-[#faf9f5] px-2.5 py-1 rounded-lg font-semibold active:opacity-80"
            >
              ＋ 新規追加
            </button>
          }>
            <div className="space-y-2">
              {editId === 'new' && (
                <div className="border border-amber-300 rounded-xl px-3 pb-3 pt-2 text-sm space-y-2 bg-amber-50/40">
                  <p className="font-semibold text-amber-800 text-xs">新規追加</p>
                  <div>
                    <label className="block text-xs text-stone-500 mb-1">日付</label>
                    <input
                      type="date"
                      value={edit.date}
                      onChange={(e) => setEdit((p) => ({ ...p, date: e.target.value }))}
                      className="w-full border border-stone-300 rounded-lg px-3 py-2 bg-white"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <EditField label="売上" value={edit.sales} onChange={(v) => setEdit((e) => ({ ...e, sales: v }))} />
                    <EditField label="食材原価" value={edit.foodCost} onChange={(v) => setEdit((e) => ({ ...e, foodCost: v }))} />
                    <EditField label="場所代" value={edit.locationFee} onChange={(v) => setEdit((e) => ({ ...e, locationFee: v }))} />
                    <EditField label="その他経費" value={edit.otherCost} onChange={(v) => setEdit((e) => ({ ...e, otherCost: v }))} />
                  </div>
                  <SalesExtraFields
                    groups={edit.groups} people={edit.people} actualCost={edit.actualCost}
                    onG={(v) => setEdit((e) => ({ ...e, groups: v }))}
                    onP={(v) => setEdit((e) => ({ ...e, people: v }))}
                    onC={(v) => setEdit((e) => ({ ...e, actualCost: v }))}
                  />
                  <ToriokiEditFields
                    countStr={edit.toriokiN}
                    recipe={edit.toriokiRecipe}
                    names={recipeNames}
                    onCount={(v) => setEdit((e) => ({ ...e, toriokiN: v }))}
                    onRecipe={(v) => setEdit((e) => ({ ...e, toriokiRecipe: v }))}
                  />
                  {calcUzuraCost(edit.toriokiN, edit.toriokiRecipe) > 0 && (
                    <p className="text-xs text-stone-500">
                      取り置き原価 −{yen(calcUzuraCost(edit.toriokiN, edit.toriokiRecipe))}（利益から差引）
                    </p>
                  )}
                  <div>
                    <label className="block text-xs text-stone-500 mb-1">メモ</label>
                    <input
                      type="text"
                      value={edit.memo}
                      onChange={(e) => setEdit((p) => ({ ...p, memo: e.target.value }))}
                      className="w-full border border-stone-300 rounded-lg px-3 py-2 bg-white"
                    />
                  </div>
                  <div className="flex gap-2 pt-1">
                    <button onClick={() => setEditId(null)} disabled={busy} className="flex-1 py-2 rounded-lg border border-stone-300 text-stone-600 font-semibold">
                      キャンセル
                    </button>
                    <button onClick={() => saveEdit()} disabled={busy || !edit.date} className="flex-1 py-2 rounded-lg bg-amber-700 text-[#faf9f5] font-bold disabled:opacity-50">
                      {busy ? '保存中...' : '追加'}
                    </button>
                  </div>
                </div>
              )}
              {sessions.map((s) => {
                const sid = `${s.date}#${s.idx}`
                const open = openId === sid
                const rate = s.sales > 0 ? (s.foodCost / s.sales) * 100 : null
                const ppl = peopleOf(s)
                const menus = Object.entries(recByDate[s.date] ?? {}).sort(
                  (a, b) => b[1].amount - a[1].amount,
                )
                return (
                  <div key={sid} className="border border-stone-200 rounded-xl overflow-hidden bg-white">
                    <button
                      onClick={() => setOpenId(open ? null : sid)}
                      className="w-full text-left px-3.5 py-3"
                    >
                      <div className="flex items-center gap-3">
                        <span className="font-bold text-stone-800 w-16 shrink-0">
                          {s.date.slice(5).replace('-', '/')}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="flex justify-between text-xs text-stone-500 mb-1">
                            <span>売上 <b className="text-stone-900">{yen(s.sales)}</b></span>
                            <span>利益 <b className="text-green-700">{yen(s.profit)}</b></span>
                          </div>
                          <div className="h-1.5 bg-stone-100 rounded overflow-hidden">
                            <div
                              className="h-full bg-amber-500"
                              style={{ width: `${(s.sales / recentMax) * 100}%` }}
                            />
                          </div>
                        </div>
                        <span className="text-stone-400 shrink-0">{open ? '▾' : '▸'}</span>
                      </div>
                    </button>

                    {open && editId === sid && (
                      <div className="px-3 pb-3 pt-2 border-t border-stone-100 text-sm space-y-2">
                        <div>
                          <label className="block text-xs text-stone-500 mb-1">日付</label>
                          <input
                            type="date"
                            value={edit.date}
                            onChange={(e) => setEdit((p) => ({ ...p, date: e.target.value }))}
                            className="w-full border border-stone-300 rounded-lg px-3 py-2"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <EditField label="売上" value={edit.sales} onChange={(v) => setEdit((e) => ({ ...e, sales: v }))} />
                          <EditField label="食材原価" value={edit.foodCost} onChange={(v) => setEdit((e) => ({ ...e, foodCost: v }))} />
                          <EditField label="場所代" value={edit.locationFee} onChange={(v) => setEdit((e) => ({ ...e, locationFee: v }))} />
                          <EditField label="その他経費" value={edit.otherCost} onChange={(v) => setEdit((e) => ({ ...e, otherCost: v }))} />
                        </div>
                        <SalesExtraFields
                          groups={edit.groups} people={edit.people} actualCost={edit.actualCost}
                          onG={(v) => setEdit((e) => ({ ...e, groups: v }))}
                          onP={(v) => setEdit((e) => ({ ...e, people: v }))}
                          onC={(v) => setEdit((e) => ({ ...e, actualCost: v }))}
                        />
                        <ToriokiEditFields
                          countStr={edit.toriokiN}
                          recipe={edit.toriokiRecipe}
                          names={recipeNames}
                          onCount={(v) => setEdit((e) => ({ ...e, toriokiN: v }))}
                          onRecipe={(v) => setEdit((e) => ({ ...e, toriokiRecipe: v }))}
                        />
                        <div>
                          <label className="block text-xs text-stone-500 mb-1">メモ</label>
                          <input
                            type="text"
                            value={edit.memo}
                            onChange={(e) => setEdit((p) => ({ ...p, memo: e.target.value }))}
                            className="w-full border border-stone-300 rounded-lg px-3 py-2"
                          />
                        </div>
                        <p className="text-xs text-stone-400">
                          利益 = 売上 − 食材原価 − 場所代 − その他経費 − 取り置き原価
                          {calcUzuraCost(edit.toriokiN, edit.toriokiRecipe) > 0 &&
                            `（取り置き −${yen(calcUzuraCost(edit.toriokiN, edit.toriokiRecipe))}）`}
                        </p>
                        <div className="flex gap-2 pt-1">
                          <button onClick={() => setEditId(null)} disabled={busy} className="flex-1 py-2 rounded-lg border border-stone-300 text-stone-600 font-semibold">
                            キャンセル
                          </button>
                          <button onClick={() => saveEdit(s)} disabled={busy} className="flex-1 py-2 rounded-lg bg-amber-700 text-[#faf9f5] font-bold disabled:opacity-50">
                            {busy ? '保存中...' : '保存'}
                          </button>
                        </div>
                      </div>
                    )}

                    {open && editId !== sid && (
                      <div className="px-3 pb-3 pt-1 border-t border-stone-100 text-sm">
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 my-2">
                          <Row label="売上" value={yen(s.sales)} />
                          <Row label="食材原価" value={yen(s.foodCost)} />
                          <Row label="場所代" value={yen(s.locationFee)} />
                          {s.otherCost > 0 && <Row label="その他経費" value={yen(s.otherCost)} />}
                          {s.uzuraCost > 0 && <Row label="取り置き原価" value={yen(s.uzuraCost)} />}
                          <Row label="利益" value={yen(s.profit)} accent />
                          <Row label="原価率" value={rate != null ? `${rate.toFixed(1)}%` : '—'} />
                          {groupsOf(s) > 0 && <Row label="組数 / 客数" value={`${groupsOf(s)}組 / ${ppl}人`} />}
                          {ppl > 0 && <Row label="客単価" value={yen(s.sales / ppl)} />}
                          {actualCostOf(s) > 0 && <Row label="実仕入れ" value={yen(actualCostOf(s))} />}
                        </div>
                        {s.memo && <p className="text-stone-500 mb-2">メモ: {s.memo}</p>}
                        {menuEditId === sid ? (
                          <div className="bg-stone-50 rounded-lg p-2 mb-2 space-y-1.5">
                            <p className="text-xs text-stone-400">メニュー別の数を編集</p>
                            {menuEdit.map((m, i) => (
                              <div key={i} className="flex items-center gap-2">
                                <span className="flex-1 truncate text-stone-700">{m.menu}</span>
                                <input
                                  type="number"
                                  inputMode="numeric"
                                  value={m.qty}
                                  onChange={(e) =>
                                    setMenuEdit((arr) =>
                                      arr.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)),
                                    )
                                  }
                                  className="w-16 border border-stone-300 rounded-lg px-2 py-1 text-right bg-white"
                                />
                                <span className="text-xs text-stone-400">食</span>
                                <button
                                  onClick={() => setMenuEdit((arr) => arr.filter((_, j) => j !== i))}
                                  className="text-red-400 px-1"
                                  title="削除"
                                >
                                  🗑️
                                </button>
                              </div>
                            ))}
                            {menuEdit.length === 0 && (
                              <p className="text-xs text-stone-400 py-1">記録がありません</p>
                            )}
                            <div className="flex gap-2 pt-1">
                              <button onClick={() => setMenuEditId(null)} disabled={busy} className="flex-1 py-2 rounded-lg border border-stone-300 text-stone-600 font-semibold text-sm">
                                キャンセル
                              </button>
                              <button onClick={() => saveMenuEdit(s.date)} disabled={busy} className="flex-1 py-2 rounded-lg bg-amber-700 text-[#faf9f5] font-bold disabled:opacity-50 text-sm">
                                {busy ? '保存中...' : '保存'}
                              </button>
                            </div>
                          </div>
                        ) : (
                          menus.length > 0 && (
                            <div className="bg-stone-50 rounded-lg p-2 mb-2">
                              <div className="flex items-center justify-between mb-1">
                                <p className="text-xs text-stone-400">メニュー別</p>
                                <button
                                  onClick={() => startMenuEdit(s.date, sid)}
                                  className="text-xs text-amber-700 font-semibold active:opacity-70"
                                >
                                  ✏️ 数を編集
                                </button>
                              </div>
                              {menus.map(([mn, v]) => (
                                <div key={mn} className="flex justify-between py-0.5 text-stone-700">
                                  <span className="truncate">
                                    {mn} <span className="text-stone-400">×{v.qty}</span>
                                  </span>
                                  <span className="font-medium text-stone-800 shrink-0 ml-2">
                                    {yen(v.amount)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )
                        )}
                        <div className="flex gap-2">
                          <button onClick={() => startEdit(s, sid)} disabled={busy} className="flex-1 py-2 rounded-lg border border-stone-300 text-stone-700 font-semibold active:bg-stone-50">
                            ✏️ 編集
                          </button>
                          <button onClick={() => setConfirmTarget(s)} disabled={busy} className="flex-1 py-2 rounded-lg border border-red-200 text-red-600 font-semibold active:bg-red-50 disabled:opacity-50">
                            🗑️ 削除
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </Section>
          </> /* end summary tab */}

          {/* ── 商品別タブ ── */}
          {dashTab === 'products' && (
            <div>
              {/* 期間フィルター */}
              <div className="flex gap-1.5 mb-4">
                {(['all', 'last4', 'last8'] as Period[]).map((p) => (
                  <button
                    key={p}
                    onClick={() => setPeriod(p)}
                    className={`px-3 py-1.5 rounded-full text-sm font-semibold ${
                      period === p ? 'bg-amber-700 text-[#faf9f5]' : 'bg-stone-100 text-stone-600'
                    }`}
                  >
                    {p === 'all' ? '全期間' : p === 'last4' ? '直近4回' : '直近8回'}
                  </button>
                ))}
              </div>

              {productRanked.length === 0 ? (
                <p className="text-center text-stone-400 text-sm py-8">データがありません</p>
              ) : (
                <>
                  {/* ランク凡例（メニューエンジニアリング） */}
                  {hasCostData && (
                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {(['star', 'plow', 'puzzle', 'dog'] as Rank[]).map((r) => (
                        <span key={r} className={`text-xs px-2 py-0.5 rounded-full font-semibold ${RANK_META[r].cls}`}>
                          {RANK_META[r].label}
                        </span>
                      ))}
                      <span className="text-xs text-stone-400 self-center ml-1">売れ筋×利益で分類</span>
                    </div>
                  )}
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-stone-200 text-stone-500 text-xs">
                          <th className="text-left pb-2">商品名</th>
                          <th className="text-right pb-2 pr-2">販売数</th>
                          <th className="text-right pb-2 pr-2">売上</th>
                          {hasCostData && <th className="text-right pb-2 pr-2">原価率</th>}
                          <th className="text-right pb-2">構成比</th>
                        </tr>
                      </thead>
                      <tbody>
                        {productRanked.map((p) => (
                          <tr key={p.name} className="border-b border-stone-100">
                            <td className="py-2 pr-2 font-medium text-stone-800">
                              <div className="flex items-center gap-1.5">
                                {hasCostData && (
                                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold shrink-0 ${RANK_META[p.rank].cls}`}>
                                    {RANK_META[p.rank].label}
                                  </span>
                                )}
                                <span className="truncate">{p.name}</span>
                              </div>
                            </td>
                            <td className="py-2 pr-2 text-right text-stone-700">{p.qty}</td>
                            <td className="py-2 pr-2 text-right text-stone-700">{yen(p.amount)}</td>
                            {hasCostData && (
                              <td className="py-2 pr-2 text-right text-stone-600">
                                {p.costRate != null ? `${p.costRate.toFixed(0)}%` : '—'}
                              </td>
                            )}
                            <td className="py-2 text-right">
                              <span className="text-stone-500">
                                {totalAmount > 0 ? Math.round((p.amount / totalAmount) * 100) : 0}%
                              </span>
                              <div className="h-1.5 bg-stone-100 rounded mt-0.5">
                                <div
                                  className="h-full bg-amber-500 rounded"
                                  style={{ width: `${totalAmount > 0 ? (p.amount / totalAmount) * 100 : 0}%` }}
                                />
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t-2 border-stone-300 font-semibold text-stone-800">
                          <td className="pt-2">合計</td>
                          <td className="pt-2 text-right pr-2">{totalQty}</td>
                          <td className="pt-2 text-right pr-2">{yen(totalAmount)}</td>
                          {hasCostData && <td />}
                          <td className="pt-2 text-right">100%</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── 仕込み計算タブ ── */}
          {dashTab === 'prep' && (
            <div>
              <div className="flex items-center gap-3 mb-4">
                <label className="text-sm text-stone-700 shrink-0">目標人数</label>
                <input
                  type="number"
                  inputMode="numeric"
                  value={targetInput}
                  onChange={(e) => setTargetInput(e.target.value)}
                  placeholder="20"
                  className="w-24 border border-stone-300 rounded-lg px-3 py-2 text-lg text-right"
                />
                <span className="text-stone-500">人</span>
              </div>

              {prepCalc == null ? (
                <p className="text-center text-stone-400 text-sm py-8">営業データがありません</p>
              ) : (
                <>
                  {!prepCalc.sufficient && (
                    <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
                      ※ データが少ないため参考値です（3回以上の営業データが必要）
                    </p>
                  )}
                  {prepCalc.unit === '回平均' && prepCalc.sufficient && (
                    <p className="text-xs text-stone-500 mb-3">
                      ※ 組数データが3回分以上揃うと1人あたり計算に切り替わります
                    </p>
                  )}
                  <p className="text-xs text-stone-500 mb-2">
                    過去 {eventDates.length} 回の 1{prepCalc.unit} あたり平均より推定
                  </p>

                  {target > 0 ? (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-stone-200 text-stone-500 text-xs">
                            <th className="text-left pb-2">商品名</th>
                            <th className="text-right pb-2 pr-2">平均（1{prepCalc.unit}）</th>
                            <th className="text-right pb-2">目標 {target} 人分</th>
                          </tr>
                        </thead>
                        <tbody>
                          {prepCalc.items.map((item) => (
                            <tr key={item.name} className="border-b border-stone-100">
                              <td className="py-2 pr-2 font-medium text-stone-800 truncate max-w-36">{item.name}</td>
                              <td className="py-2 pr-2 text-right text-stone-600">
                                {item.avg.toFixed(2)} 食
                              </td>
                              <td className="py-2 text-right font-bold text-amber-800 text-base">
                                {Math.ceil(item.avg * target)} 食
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-stone-200 text-stone-500 text-xs">
                            <th className="text-left pb-2">商品名</th>
                            <th className="text-right pb-2">平均（1{prepCalc.unit}）</th>
                          </tr>
                        </thead>
                        <tbody>
                          {prepCalc.items.map((item) => (
                            <tr key={item.name} className="border-b border-stone-100">
                              <td className="py-2 pr-2 font-medium text-stone-800">{item.name}</td>
                              <td className="py-2 text-right text-stone-700">{item.avg.toFixed(2)} 食</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <p className="text-xs text-stone-400 mt-3 text-center">目標人数を入力すると推定量を表示します</p>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}

      {confirmTarget && (
        <ConfirmModal
          message={`${confirmTarget.date} の営業記録を削除しますか？\n（元に戻せません）`}
          onConfirm={() => {
            const s = confirmTarget
            setConfirmTarget(null)
            removeSession(s)
          }}
          onCancel={() => setConfirmTarget(null)}
        />
      )}
    </div>
  )
}

function HeroStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <p className="text-xs text-stone-500">{label}</p>
      <p className={`text-lg font-bold ${accent ? 'text-amber-800' : 'text-stone-900'}`}>{value}</p>
    </div>
  )
}

function LineChart({
  data,
}: {
  data: { label: string; sales: number; profit: number }[]
}) {
  const W = 320
  const H = 170
  const padL = 10
  const padR = 10
  const padT = 14
  const padB = 26
  const n = data.length
  const plotW = W - padL - padR
  const plotH = H - padT - padB
  const sales = data.map((d) => d.sales)
  const profit = data.map((d) => d.profit)
  const maxV = Math.max(1, ...sales, ...profit, 0)
  const minV = Math.min(0, ...profit)
  const range = maxV - minV || 1
  const x = (i: number) => (n <= 1 ? padL + plotW / 2 : padL + (i * plotW) / (n - 1))
  const y = (v: number) => padT + (1 - (v - minV) / range) * plotH
  const poly = (arr: number[]) => arr.map((v, i) => `${x(i)},${y(v)}`).join(' ')
  const zeroY = y(0)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto">
      <line x1={padL} x2={W - padR} y1={zeroY} y2={zeroY} stroke="#3a3733" strokeWidth="1" />
      <polyline fill="none" stroke="#d9824f" strokeWidth="2" points={poly(sales)} />
      <polyline fill="none" stroke="#6bcf8c" strokeWidth="2" points={poly(profit)} />
      {data.map((d, i) => (
        <g key={i}>
          <circle cx={x(i)} cy={y(d.sales)} r="2.5" fill="#d9824f" />
          <circle cx={x(i)} cy={y(d.profit)} r="2.5" fill="#6bcf8c" />
          <text x={x(i)} y={H - 8} fontSize="10" textAnchor="middle" fill="#918b81">
            {d.label}
          </text>
        </g>
      ))}
    </svg>
  )
}

function ToriokiEditFields({
  countStr,
  recipe,
  names,
  onCount,
  onRecipe,
}: {
  countStr: string
  recipe: string
  names: string[]
  onCount: (v: string) => void
  onRecipe: (v: string) => void
}) {
  return (
    <div className="bg-amber-50/60 border border-amber-200 rounded-lg p-2 space-y-2">
      <p className="text-xs font-semibold text-stone-600">取り置き特典</p>
      <div>
        <label className="block text-xs text-stone-500 mb-1">対象レシピ</label>
        <select
          value={recipe}
          onChange={(e) => onRecipe(e.target.value)}
          className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm bg-white"
        >
          <option value="">（なし）</option>
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-xs text-stone-500 mb-1">取り置き人数（人）</label>
        <input
          type="number"
          inputMode="numeric"
          value={countStr}
          onChange={(e) => onCount(e.target.value)}
          className="w-full border border-stone-300 rounded-lg px-3 py-2 text-right"
        />
      </div>
    </div>
  )
}

function SalesExtraFields({
  groups,
  people,
  actualCost,
  onG,
  onP,
  onC,
}: {
  groups: string
  people: string
  actualCost: string
  onG: (v: string) => void
  onP: (v: string) => void
  onC: (v: string) => void
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      <NumField label="組数" value={groups} onChange={onG} />
      <NumField label="客数" value={people} onChange={onP} />
      <NumField label="実仕入れ(円)" value={actualCost} onChange={onC} />
    </div>
  )
}

function NumField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div>
      <label className="block text-xs text-stone-500 mb-1">{label}</label>
      <input
        type="number"
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border border-stone-300 rounded-lg px-2 py-2 text-right"
      />
    </div>
  )
}

function EditField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div>
      <label className="block text-xs text-stone-500 mb-1">{label}（円）</label>
      <input
        type="number"
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border border-stone-300 rounded-lg px-3 py-2 text-right"
      />
    </div>
  )
}

function Row({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-stone-500">{label}</span>
      <span className={`font-semibold ${accent ? 'text-green-700' : 'text-stone-800'}`}>
        {value}
      </span>
    </div>
  )
}

function Section({ title, children, extra }: { title: string; children: React.ReactNode; extra?: React.ReactNode }) {
  return (
    <div className="mb-5">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-sm font-bold text-stone-700">{title}</h2>
        {extra}
      </div>
      {children}
    </div>
  )
}
