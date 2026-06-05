import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../lib/auth'
import { Spinner } from '../components/Spinner'
import { readRange, appendRows, AuthExpiredError } from '../lib/sheets'
import { loadRecipes } from '../lib/recipes'
import { menuUnitCost, perServingCost, type CostCtx } from '../lib/cost'
import { usePersistedState } from '../lib/persistState'
import { getCached, setCached } from '../lib/dataCache'
import { getEventData, patchEventData } from '../lib/eventData'
import { useKeyboardOffset } from '../lib/useKeyboardOffset'
import { useRegisterBack } from '../lib/backHandler'

type Menu = { name: string; price: number; recipe: string }
type CartItem = { name: string; price: number; qty: number }
type ManualItem = { id: number; price: number }
type Receipt = {
  id: number
  time: string
  items: CartItem[]
  total: number
  received: number
  change: number
}

const DISABLED_FLAGS = ['off', 'false', '無効', 'no', '0']
const QUICK_AMOUNTS = [1000, 5000, 10000]
const MANUAL_LABEL = '金額入力'
const TORIOKI_RECIPE_KEY = 'kbtr_torioki_recipe'

function todayStr(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
function nowTime(): string {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const salesKey = (date: string) => `kbtr_sales_${date}`

// Airレジ風テンキー。fill=true で利用可能な高さいっぱいに広がる
function Numpad({ onKey, fill = false }: { onKey: (k: string) => void; fill?: boolean }) {
  const keys = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '00', '0', '⌫']
  return (
    <div className={`grid grid-cols-3 gap-px bg-stone-200 rounded-2xl overflow-hidden ${fill ? 'flex-1 min-h-0' : ''}`}>
      {keys.map((k) => (
        <button
          key={k}
          onClick={() => onKey(k)}
          className={`bg-white text-stone-900 text-3xl md:text-4xl font-medium tracking-tight flex items-center justify-center active:bg-stone-100 transition-colors ${
            fill ? 'min-h-[3.25rem]' : 'py-5'
          }`}
        >
          {k === '⌫' ? <span className="text-2xl md:text-3xl text-stone-500">⌫</span> : k}
        </button>
      ))}
    </div>
  )
}

export default function PosPage() {
  const { token, login, logout } = useAuth()
  const [menus, setMenus] = useState<Menu[]>(() => getCached<Menu[]>('pos_menus') ?? [])
  const [qty, setQty] = usePersistedState<Record<string, number>>('kbtr_view_pos_qty', {})
  const [manualItems, setManualItems] = usePersistedState<ManualItem[]>(
    'kbtr_view_pos_manual',
    [],
  )
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [step, setStep] = usePersistedState<'select' | 'pay' | 'change'>(
    'kbtr_view_pos_step',
    'select',
  )
  const [received, setReceived] = usePersistedState('kbtr_view_pos_received', '')

  // 手動金額モーダル
  const [manualOpen, setManualOpen] = useState(false)
  const [manualVal, setManualVal] = useState('')

  const [sales, setSales] = useState<Receipt[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(salesKey(todayStr())) ?? '[]')
    } catch {
      return []
    }
  })

  const [showHistory, setShowHistory] = useState(false)
  const [closing, setClosing] = useState(false)
  const [closeError, setCloseError] = useState<string | null>(null)
  const [locationFee, setLocationFee] = useState('5000')
  const [otherCost, setOtherCost] = useState('')
  const [torioki, setTorioki] = useState('')
  const [toriokiRecipe, setToriokiRecipe] = useState<string>(
    () => localStorage.getItem(TORIOKI_RECIPE_KEY) ?? '',
  )
  const [recipeNames, setRecipeNames] = useState<string[]>([])
  const [acharCost, setAcharCost] = useState<number | null>(null)
  const [acharLoading, setAcharLoading] = useState(false)
  const costCtxRef = useRef<import('../lib/cost').CostCtx | null>(null)
  const [memo, setMemo] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)

  // 仕入れ実費（今日分・localStorageから初期化）
  const [costStr, setCostStr] = useState(() => {
    const c = getEventData(todayStr()).cost
    return c != null && c > 0 ? String(c) : ''
  })

  const kbOffset = useKeyboardOffset()

  const persistSales = useCallback((next: Receipt[]) => {
    setSales(next)
    localStorage.setItem(salesKey(todayStr()), JSON.stringify(next))
  }, [])

  // スワイプ戻し：レジ内で一段階だけ戻る（タブ移動はしない）
  useRegisterBack(() => {
    if (manualOpen) { setManualOpen(false); return true }
    if (closing) { setClosing(false); setCloseError(null); return true }
    if (step === 'change') { setStep('pay'); return true }
    if (step === 'pay') { setStep('select'); return true }
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

  const loadMenus = useCallback(async (silent = false) => {
    if (!token) return
    if (!silent) setLoading(true)
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
      setCached('pos_menus', parsed)
    } catch (e) {
      if (!silent) handleAuthError(e)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [token, handleAuthError])

  useEffect(() => {
    const cached = getCached<Menu[]>('pos_menus')
    loadMenus(!!cached)
  }, [loadMenus])

  const setCount = (name: string, delta: number) => {
    setQty((prev) => {
      const next = Math.max(0, (prev[name] ?? 0) + delta)
      return { ...prev, [name]: next }
    })
  }

  // カート（メニュー＋手動金額）
  const cart: CartItem[] = [
    ...menus
      .filter((m) => (qty[m.name] ?? 0) > 0)
      .map((m) => ({ name: m.name, price: m.price, qty: qty[m.name] })),
    ...manualItems.map((mi) => ({ name: MANUAL_LABEL, price: mi.price, qty: 1 })),
  ]
  const cartTotal = cart.reduce((s, it) => s + it.price * it.qty, 0)
  const cartCount = cart.reduce((s, it) => s + it.qty, 0)

  const receivedNum = Number(received) || 0
  const change = receivedNum - cartTotal
  const dayTotal = sales.reduce((s, r) => s + r.total, 0)

  const pressReceived = (k: string) =>
    setReceived((v) => (k === '⌫' ? v.slice(0, -1) : v + (k === '00' ? '00' : k)))
  // Airレジ風：紙幣ボタンは預り金に「加算」する
  const addReceived = (amt: number) =>
    setReceived((v) => String((Number(v) || 0) + amt))
  const pressManual = (k: string) =>
    setManualVal((v) => (k === '⌫' ? v.slice(0, -1) : v + (k === '00' ? '00' : k)))

  const addManual = () => {
    const p = Number(manualVal) || 0
    if (p <= 0) return
    setManualItems((prev) => [...prev, { id: Date.now(), price: p }])
    setManualOpen(false)
    setManualVal('')
  }

  const handleNextAccount = () => {
    const receipt: Receipt = {
      id: Date.now(),
      time: nowTime(),
      items: cart,
      total: cartTotal,
      received: receivedNum,
      change,
    }
    persistSales([...sales, receipt])
    setQty({})
    setManualItems([])
    setReceived('')
    setStep('select')
  }

  // 原価計算用コンテキスト（レシピ＋食材単価）を読み込む
  const buildCtx = useCallback(async (): Promise<CostCtx> => {
    if (!token) throw new Error('未ログイン')
    const [rd, master] = await Promise.all([
      loadRecipes(token),
      readRange(token, '食材マスタ!A2:I'),
    ])
    const priceMap: Record<string, number> = {}
    for (const r of master) {
      const nm = (r[0] ?? '').trim()
      if (!nm) continue
      const pricePerG = Number(r[3]) || 0
      if (pricePerG > 0) {
        priceMap[nm] = pricePerG
      } else {
        const weight = Number(r[6]) || 0
        const unitPrice = Number(r[8]) || 0
        priceMap[nm] = weight > 0 && unitPrice > 0 ? unitPrice / weight : 0
      }
    }
    return {
      recipeMap: rd.recipeMap,
      priceMap,
      yieldMap: rd.yieldMap,
      servingWeightMap: rd.servingWeightMap,
      servingsMap: rd.servingsMap,
    }
  }, [token])

  // 締め画面を開く（レシピ一覧と原価コンテキストを取得）
  const openClosing = async () => {
    setClosing(true)
    setAcharLoading(true)
    try {
      const ctx = await buildCtx()
      costCtxRef.current = ctx
      const names = Object.keys(ctx.recipeMap).sort()
      setRecipeNames(names)
      const saved = localStorage.getItem(TORIOKI_RECIPE_KEY) ?? ''
      if (saved && names.includes(saved)) {
        setAcharCost(Math.round(perServingCost(saved, ctx)))
      } else {
        setAcharCost(null)
      }
    } catch {
      setAcharCost(null)
    } finally {
      setAcharLoading(false)
    }
  }

  const handleToriokiRecipeChange = (name: string) => {
    setToriokiRecipe(name)
    localStorage.setItem(TORIOKI_RECIPE_KEY, name)
    const ctx = costCtxRef.current
    if (name && ctx) {
      setAcharCost(Math.round(perServingCost(name, ctx)))
    } else {
      setAcharCost(null)
    }
  }

  const toriokiN = Number(torioki) || 0
  const toriokiCost = toriokiN * (acharCost ?? 0)

  const handleClose = async () => {
    if (!token || sales.length === 0) return
    setSubmitting(true)
    setCloseError(null)
    try {
      const date = todayStr()
      const fee = Number(locationFee) || 0
      const misc = Number(otherCost) || 0 // 手入力のその他経費
      // メニュー名＋単価で集計（手動金額の異なる単価も区別）
      const agg: Record<string, { name: string; price: number; qty: number }> = {}
      for (const r of sales) {
        for (const it of r.items) {
          const k = `${it.name}${it.price}`
          if (!agg[k]) agg[k] = { name: it.name, price: it.price, qty: 0 }
          agg[k].qty += it.qty
        }
      }
      const salesRows = Object.values(agg).map((v) => [
        date,
        v.name,
        v.qty,
        v.price,
        v.price * v.qty,
      ])
      await appendRows(token, '営業記録!A:E', salesRows)

      let foodCost = 0
      let serviceCost = 0 // 取り置き特典原価
      try {
        const ctx = costCtxRef.current ?? (await buildCtx())
        const recipeOf: Record<string, string> = {}
        for (const m of menus) recipeOf[m.name] = m.recipe
        for (const v of Object.values(agg)) {
          foodCost += menuUnitCost(recipeOf[v.name] ?? '', ctx) * v.qty
        }
        if (toriokiRecipe) serviceCost = toriokiN * perServingCost(toriokiRecipe, ctx)
      } catch {
        foodCost = 0
        serviceCost = toriokiN * (acharCost ?? 0)
      }
      foodCost = Math.round(foodCost)
      serviceCost = Math.round(serviceCost)
      const other = misc // その他経費（手入力分のみ）
      const totalDeduct = foodCost + fee + other + serviceCost
      const rate = dayTotal > 0 ? Math.round((foodCost / dayTotal) * 1000) / 10 : 0
      const note = `${memo}${memo ? ' ' : ''}(${sales.length}組${
        toriokiN > 0 ? ` 取り置き${toriokiN}人` : ''
      })`

      await appendRows(token, '営業サマリー!A:I', [
        [date, dayTotal, foodCost, fee, dayTotal - totalDeduct, rate, note, other, serviceCost],
      ])
      // 組数と仕入れ実費をlocalStorageに保存（分析用）
      patchEventData(date, { groups: sales.length })
      localStorage.removeItem(salesKey(date))
      setSales([])
      setLocationFee('5000')
      setOtherCost('')
      setTorioki('')
      setAcharCost(null)
      setMemo('')
      setClosing(false)
      setDone(true)
      setTimeout(() => setDone(false), 3000)
    } catch (e) {
      setCloseError(e instanceof Error ? e.message : '保存に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  // ── 未ログイン ──
  if (!token) {
    return (
      <div className="p-6 flex flex-col items-center justify-center min-h-[70svh] gap-6">
        <div className="text-6xl">🍛</div>
        <h1 className="text-2xl font-bold text-amber-800">コバタロカレー レジ</h1>
        <button
          onClick={login}
          className="bg-amber-700 text-[#faf9f5] px-8 py-4 rounded-xl font-semibold text-lg shadow active:scale-95 transition-transform"
        >
          Googleでログイン
        </button>
      </div>
    )
  }

  // ── 預り金入力（電卓） ──
  if (step === 'pay') {
    return (
      <div
        className="flex flex-col mx-auto px-4 pt-2 max-w-md md:max-w-3xl lg:max-w-5xl"
        style={{
          // モバイル下部ナビ(64px)＋セーフエリアを避ける。固定配置は使わない
          minHeight: '100svh',
          paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 5rem)',
        }}
      >
        <div className="flex items-center mb-2 shrink-0">
          <button onClick={() => setStep('select')} className="text-stone-500 py-1 md:text-lg">
            ← 戻る
          </button>
        </div>

        {/* 本体：モバイルは縦1列、iPad（md以上）は左に表示・右にテンキーの2列 */}
        <div className="flex-1 min-h-0 flex flex-col md:grid md:grid-cols-2 md:auto-rows-fr md:gap-8 md:items-stretch">
          {/* 左：お会計・お預かり・おつり＋紙幣ボタン（iPadでは左上寄せ） */}
          <div className="flex flex-col shrink-0 md:justify-start md:gap-3 md:self-start md:w-full">
            {/* 金額パネル（濃い背景と同じ色／Airレジ風の積み重ね表示） */}
            <div className="rounded-2xl bg-[#191817] border border-stone-300 overflow-hidden mb-2 md:mb-0 shrink-0">
              <div className="flex items-baseline justify-between px-4 py-2.5 md:py-4">
                <span className="text-stone-500 text-sm md:text-lg">お会計（{cartCount}点）</span>
                <span className="text-2xl md:text-4xl font-bold text-stone-900">
                  ¥{cartTotal.toLocaleString()}
                </span>
              </div>
              <div className="flex items-baseline justify-between px-4 py-2.5 md:py-4 border-t border-stone-300">
                <span className="text-stone-500 text-sm md:text-lg">お預かり</span>
                <span className="text-4xl md:text-6xl font-bold text-stone-900 tracking-tight">
                  ¥{receivedNum.toLocaleString()}
                </span>
              </div>
              <div className="flex items-baseline justify-between px-4 py-2.5 md:py-4 border-t border-stone-300">
                <span className="text-stone-500 text-sm md:text-lg">おつり</span>
                <span
                  className={`text-3xl md:text-5xl font-bold tracking-tight ${
                    received === '' ? 'text-stone-300' : change < 0 ? 'text-red-500' : 'text-green-600'
                  }`}
                >
                  {received === ''
                    ? '—'
                    : change < 0
                      ? `不足 ¥${(-change).toLocaleString()}`
                      : `¥${change.toLocaleString()}`}
                </span>
              </div>
            </div>

            {/* 紙幣ボタン（タップで加算）＋ちょうど */}
            <div className="grid grid-cols-4 gap-2 mb-2 md:mb-0 shrink-0">
              <button
                onClick={() => setReceived(String(cartTotal))}
                className="py-3 md:py-5 rounded-xl bg-amber-700 text-[#faf9f5] font-bold md:text-lg active:brightness-95 transition"
              >
                ちょうど
              </button>
              {QUICK_AMOUNTS.map((amt) => (
                <button
                  key={amt}
                  onClick={() => addReceived(amt)}
                  className="py-3 md:py-5 rounded-xl bg-white border border-stone-200 text-stone-800 font-semibold text-sm md:text-lg active:bg-stone-100 transition"
                >
                  ＋{amt.toLocaleString()}
                </button>
              ))}
            </div>
          </div>

          {/* 右：テンキー＋会計操作（残りの高さいっぱいに広がる） */}
          <div className="flex-1 min-h-0 flex flex-col">
            <Numpad onKey={pressReceived} fill />
            <div className="flex items-center gap-3 mt-3 shrink-0">
              <button
                onClick={() => setReceived('')}
                className="px-5 py-4 md:py-5 rounded-2xl bg-white border border-stone-200 text-stone-500 font-semibold md:text-lg active:bg-stone-100 transition shrink-0"
              >
                クリア
              </button>
              <button
                onClick={() => setStep('change')}
                disabled={received === '' || change < 0}
                className="flex-1 bg-amber-700 text-[#faf9f5] py-4 md:py-5 rounded-2xl font-bold text-xl md:text-2xl disabled:opacity-30 active:scale-95 transition-transform"
              >
                会計する
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── お釣り表示 ──
  if (step === 'change') {
    return (
      <div className="p-4 min-h-[80svh] flex flex-col items-center justify-center gap-6">
        <p className="text-stone-500 text-lg">お釣り</p>
        <p className="text-7xl font-bold text-green-600">¥{change.toLocaleString()}</p>
        <p className="text-stone-400">
          合計 ¥{cartTotal.toLocaleString()} / 預り ¥{receivedNum.toLocaleString()}
        </p>
        <div className="w-full max-w-sm space-y-3 mt-6">
          <button
            onClick={handleNextAccount}
            className="w-full bg-amber-700 text-[#faf9f5] py-5 rounded-2xl font-bold text-xl active:scale-95 transition-transform"
          >
            次の会計へ →
          </button>
          <button onClick={() => setStep('pay')} className="w-full py-2 text-stone-400">
            ← 預り金を修正
          </button>
        </div>
      </div>
    )
  }

  // ── メニュー選択 ──
  return (
    <div className="p-4 pb-40">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-2xl font-bold text-amber-800">🛒 レジ</h1>
        <button onClick={() => loadMenus()} className="text-sm text-stone-500 border border-stone-200 rounded-lg px-2 py-1 active:bg-stone-50">
          ↻ 更新
        </button>
      </div>

      <div className="bg-stone-50 rounded-lg px-3 py-2 mb-4 space-y-2">
        {/* 売上サマリー行 */}
        <div className="flex items-center justify-between">
          <button
            onClick={() => setShowHistory((v) => !v)}
            className="text-stone-500 flex items-center gap-1"
          >
            本日 <span className="font-bold text-stone-800">{sales.length}</span> 組 / 売上{' '}
            <span className="font-bold text-stone-800">¥{dayTotal.toLocaleString()}</span>
            {sales.length > 0 && (
              <span className="text-xs text-stone-400 ml-1">{showHistory ? '▲' : '▼'}</span>
            )}
          </button>
          <button
            onClick={openClosing}
            disabled={sales.length === 0}
            className="text-amber-700 font-semibold underline disabled:opacity-30"
          >
            締める
          </button>
        </div>
        {/* 会計履歴 */}
        {showHistory && sales.length > 0 && (
          <div className="border-t border-stone-200 pt-2 space-y-2">
            {sales.map((r) => (
              <div key={r.id} className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <span className="text-xs text-stone-400 mr-2">{r.time}</span>
                  <span className="text-sm text-stone-700">
                    {r.items.map((it) => `${it.name}×${it.qty}`).join('、')}
                  </span>
                  <span className="ml-2 font-semibold text-stone-800">
                    ¥{r.total.toLocaleString()}
                  </span>
                </div>
                <button
                  onClick={() => persistSales(sales.filter((x) => x.id !== r.id))}
                  className="text-red-400 text-lg leading-none shrink-0 active:text-red-600"
                  title="削除"
                >
                  🗑️
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {done && (
        <div className="mb-4 bg-green-100 text-green-700 rounded-lg px-4 py-3 font-semibold text-center">
          ✓ 本日の売上を記録しました
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

      {loading && <Spinner />}

      {!loading && menus.length === 0 && !error && (
        <p className="text-center py-8 text-stone-500 text-sm">
          有効なメニューがありません。「設定」タブで登録してください。
        </p>
      )}

      {/* メニューカード（横3〜4） */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {menus.map((m) => {
          const count = qty[m.name] ?? 0
          return (
            <div
              className={`rounded-2xl border-2 flex flex-col ${
                count > 0 ? 'border-amber-500 bg-amber-50' : 'border-stone-300 bg-white'
              }`}
            >
              <button
                onClick={() => setCount(m.name, 1)}
                className="p-4 text-left flex-1 active:brightness-95 transition-all"
              >
                <p className="font-bold text-stone-900 leading-snug">{m.name}</p>
                <p className="text-amber-800 font-bold text-lg mt-1">
                  ¥{m.price.toLocaleString()}
                </p>
              </button>
              {count > 0 && (
                <div className="flex border-t-2 border-amber-200">
                  <button
                    onClick={() => setCount(m.name, -1)}
                    className="flex-1 py-3 text-2xl font-bold text-stone-600 active:bg-stone-100 rounded-bl-xl"
                  >
                    −
                  </button>
                  <span className="flex-1 py-3 text-center text-xl font-bold text-amber-700">
                    {count}
                  </span>
                  <button
                    onClick={() => setCount(m.name, 1)}
                    className="flex-1 py-3 text-2xl font-bold text-stone-600 active:bg-stone-100 rounded-br-xl"
                  >
                    ＋
                  </button>
                </div>
              )}
            </div>
          )
        })}

        {/* 手動金額 */}
        <button
          onClick={() => {
            setManualOpen(true)
            setManualVal('')
          }}
          className="rounded-2xl p-4 min-h-28 flex flex-col items-center justify-center border-2 border-dashed border-amber-400 text-amber-700 font-bold active:scale-95 transition-transform"
        >
          <span className="text-3xl">＋</span>
          金額入力
        </button>
      </div>

      {/* 手動金額のチップ */}
      {manualItems.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-3">
          {manualItems.map((mi) => (
            <span
              key={mi.id}
              className="inline-flex items-center gap-1 bg-amber-100 text-amber-800 rounded-full pl-3 pr-1.5 py-1.5 font-semibold"
            >
              金額入力 ¥{mi.price.toLocaleString()}
              <button
                onClick={() =>
                  setManualItems((prev) => prev.filter((x) => x.id !== mi.id))
                }
                className="text-amber-500 text-lg leading-none"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* 合計バー */}
      {menus.length > 0 && (
        <div className="fixed bottom-16 left-0 right-0 md:bottom-0 md:left-52 lg:left-60 bg-white border-t border-stone-200 z-30">
          <div className="mx-auto w-full max-w-screen-sm lg:max-w-3xl px-4 py-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-stone-500">合計（{cartCount}点）</span>
              <span className="text-3xl font-bold text-stone-900">
                ¥{cartTotal.toLocaleString()}
              </span>
            </div>
            <button
              onClick={() => setStep('pay')}
              disabled={cartCount === 0}
              className="w-full bg-amber-700 text-[#faf9f5] py-4 rounded-2xl font-bold text-xl disabled:opacity-30 active:scale-95 transition-transform"
            >
              会計へ
            </button>
          </div>
        </div>
      )}

      {/* 手動金額モーダル */}
      {manualOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-end md:items-center justify-center z-50 p-0 md:p-4">
          <div className="bg-white w-full max-w-sm rounded-t-2xl md:rounded-2xl p-5">
            <h2 className="text-lg font-bold text-stone-900 mb-2">金額を入力</h2>
            <div className="rounded-xl border-2 border-amber-400 p-4 mb-3 text-right">
              <span className="text-4xl font-bold text-stone-900">
                ¥{(Number(manualVal) || 0).toLocaleString()}
              </span>
            </div>
            <Numpad onKey={pressManual} />
            <div className="flex gap-3 mt-4">
              <button
                onClick={() => setManualOpen(false)}
                className="flex-1 py-3 rounded-xl border border-stone-300 text-stone-600 font-semibold"
              >
                キャンセル
              </button>
              <button
                onClick={addManual}
                disabled={!(Number(manualVal) > 0)}
                className="flex-1 py-3 rounded-xl bg-amber-700 text-[#faf9f5] font-bold disabled:opacity-40"
              >
                追加
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 締めモーダル */}
      {closing && (
        <div className="fixed inset-0 bg-black/50 flex items-end md:items-center justify-center z-50 md:p-4">
          <div
            className="bg-white w-full max-w-lg rounded-t-2xl md:rounded-2xl pt-5 px-5 space-y-4 overflow-y-auto max-h-[90svh]"
            style={{ paddingBottom: Math.max(20, kbOffset + 20) }}
          >
            <h2 className="text-lg font-bold text-stone-900">本日の締め</h2>
            <div className="flex justify-between text-stone-600">
              <span>会計組数</span>
              <span className="font-bold">{sales.length} 組</span>
            </div>
            <div className="flex justify-between text-stone-600">
              <span>売上合計</span>
              <span className="font-bold">¥{dayTotal.toLocaleString()}</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
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
                <label className="block text-sm text-stone-500 mb-1">その他経費（円）</label>
                <input
                  type="number"
                  inputMode="numeric"
                  value={otherCost}
                  onChange={(e) => setOtherCost(e.target.value)}
                  placeholder="0"
                  className="w-full border border-stone-300 rounded-lg px-3 py-2 text-lg"
                />
              </div>
            </div>

            {/* 仕入れ実費 */}
            <div>
              <label className="block text-sm text-stone-500 mb-1">仕入れ実費（円）</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  inputMode="numeric"
                  value={costStr}
                  onChange={(e) => {
                    setCostStr(e.target.value)
                    patchEventData(todayStr(), { cost: Number(e.target.value) || 0 })
                  }}
                  placeholder="0"
                  className="w-full border border-stone-300 rounded-lg px-3 py-2 text-lg"
                />
                {Number(costStr) > 0 && (
                  <span className="text-sm text-stone-500 shrink-0">
                    粗利 <b className={dayTotal - Number(costStr) >= 0 ? 'text-green-700' : 'text-red-600'}>
                      ¥{(dayTotal - Number(costStr)).toLocaleString()}
                    </b>
                  </span>
                )}
              </div>
            </div>

            {/* 取り置き特典 */}
            <div className="bg-amber-50/60 border border-amber-200 rounded-lg p-3 space-y-2">
              <p className="text-sm font-semibold text-stone-700">取り置き特典</p>
              <div>
                <label className="block text-xs text-stone-500 mb-1">対象レシピ</label>
                {acharLoading ? (
                  <p className="text-stone-400 text-sm">レシピ読み込み中…</p>
                ) : (
                  <select
                    value={toriokiRecipe}
                    onChange={(e) => handleToriokiRecipeChange(e.target.value)}
                    className="w-full border border-stone-300 rounded-lg px-3 py-2 text-sm bg-white"
                  >
                    <option value="">（なし）</option>
                    {recipeNames.map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                )}
              </div>
              <div className="flex items-end gap-3">
                <div className="flex-1">
                  <label className="block text-xs text-stone-500 mb-1">取り置き特典（人）</label>
                  <input
                    type="number"
                    inputMode="numeric"
                    value={torioki}
                    onChange={(e) => setTorioki(e.target.value)}
                    placeholder="0"
                    className="w-full border border-stone-300 rounded-lg px-3 py-2 text-lg"
                  />
                </div>
                <div className="flex-1 text-sm text-stone-600 pb-1">
                  {toriokiRecipe && acharCost !== null ? (
                    <>
                      ¥{acharCost.toLocaleString()}/食
                      {toriokiN > 0 && (
                        <>
                          {' → '}
                          <span className="font-bold text-stone-800">
                            ¥{toriokiCost.toLocaleString()}
                          </span>
                        </>
                      )}
                    </>
                  ) : toriokiRecipe ? (
                    <span className="text-amber-600 text-xs">原価を取得できませんでした</span>
                  ) : (
                    <span className="text-stone-400 text-xs">レシピを選択してください</span>
                  )}
                </div>
              </div>
              <p className="text-xs text-stone-400">
                ※ 取り置き原価として売上サマリーに別途記録されます
              </p>
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
            {closeError && (
              <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg px-4 py-3 text-sm">
                {closeError}
              </div>
            )}
            <div className="flex gap-3 pt-2">
              <button
                onClick={() => { setClosing(false); setCloseError(null) }}
                disabled={submitting}
                className="flex-1 py-3 rounded-xl border border-stone-300 text-stone-600 font-semibold"
              >
                キャンセル
              </button>
              <button
                onClick={handleClose}
                disabled={submitting}
                className="flex-1 py-3 rounded-xl bg-amber-700 text-[#faf9f5] font-bold disabled:opacity-50"
              >
                {submitting ? '保存中...' : '記録する'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
