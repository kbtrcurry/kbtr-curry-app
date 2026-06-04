import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../lib/auth'
import { readRange, appendRows, AuthExpiredError } from '../lib/sheets'
import { loadRecipes } from '../lib/recipes'
import { menuUnitCost, perServingCost, type CostCtx } from '../lib/cost'
import { usePersistedState } from '../lib/persistState'

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
// 取り置きのサービス品（無料）。このレシピの一食原価 × 件数 をその他経費に加算する
const TORIOKI_RECIPE = 'うずらのアチャール'

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

// 大きいテンキー
function Numpad({ onKey }: { onKey: (k: string) => void }) {
  const keys = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '00', '0', '⌫']
  return (
    <div className="grid grid-cols-3 gap-2">
      {keys.map((k) => (
        <button
          key={k}
          onClick={() => onKey(k)}
          className="py-5 rounded-xl bg-stone-100 text-stone-900 text-3xl font-bold active:bg-stone-200 active:scale-95 transition-transform"
        >
          {k}
        </button>
      ))}
    </div>
  )
}

export default function PosPage() {
  const { token, login, logout } = useAuth()
  const [menus, setMenus] = useState<Menu[]>([])
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

  const [closing, setClosing] = useState(false)
  const [locationFee, setLocationFee] = useState('5000')
  const [otherCost, setOtherCost] = useState('')
  const [torioki, setTorioki] = useState('')
  const [acharCost, setAcharCost] = useState<number | null>(null)
  const [acharLoading, setAcharLoading] = useState(false)
  const [memo, setMemo] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)

  const persistSales = useCallback((next: Receipt[]) => {
    setSales(next)
    localStorage.setItem(salesKey(todayStr()), JSON.stringify(next))
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
      readRange(token, '食材マスタ!A2:D'),
    ])
    const priceMap: Record<string, number> = {}
    for (const r of master) {
      const nm = (r[0] ?? '').trim()
      if (nm) priceMap[nm] = Number(r[3]) || 0
    }
    return {
      recipeMap: rd.recipeMap,
      priceMap,
      yieldMap: rd.yieldMap,
      servingWeightMap: rd.servingWeightMap,
      servingsMap: rd.servingsMap,
    }
  }, [token])

  // 締め画面を開く（取り置きサービス品の一食原価を取得）
  const openClosing = async () => {
    setClosing(true)
    setAcharLoading(true)
    try {
      const ctx = await buildCtx()
      setAcharCost(Math.round(perServingCost(TORIOKI_RECIPE, ctx)))
    } catch {
      setAcharCost(null)
    } finally {
      setAcharLoading(false)
    }
  }

  const toriokiN = Number(torioki) || 0
  const toriokiCost = toriokiN * (acharCost ?? 0)

  const handleClose = async () => {
    if (!token || sales.length === 0) return
    setSubmitting(true)
    setError(null)
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
      let serviceCost = 0 // 取り置きのサービス品（うずらのアチャール）原価
      try {
        const ctx = await buildCtx()
        const recipeOf: Record<string, string> = {}
        for (const m of menus) recipeOf[m.name] = m.recipe
        for (const v of Object.values(agg)) {
          foodCost += menuUnitCost(recipeOf[v.name] ?? '', ctx) * v.qty
        }
        serviceCost = toriokiN * perServingCost(TORIOKI_RECIPE, ctx)
      } catch {
        foodCost = 0
        serviceCost = toriokiN * (acharCost ?? 0)
      }
      foodCost = Math.round(foodCost)
      serviceCost = Math.round(serviceCost)
      const other = misc + serviceCost // その他経費 = 手入力分 ＋ 取り置きサービス分
      const rate = dayTotal > 0 ? Math.round((foodCost / dayTotal) * 1000) / 10 : 0
      const note = `${memo}${memo ? ' ' : ''}(${sales.length}組${
        toriokiN > 0 ? ` 取り置き${toriokiN}件` : ''
      })`

      await appendRows(token, '営業サマリー!A:H', [
        [date, dayTotal, foodCost, fee, dayTotal - foodCost - fee - other, rate, note, other],
      ])
      localStorage.removeItem(salesKey(date))
      setSales([])
      setLocationFee('5000')
      setOtherCost('')
      setTorioki('')
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
      <div className="p-4 max-w-md mx-auto min-h-[80svh] flex flex-col">
        <button onClick={() => setStep('select')} className="text-stone-500 self-start mb-3">
          ← 戻る
        </button>
        <div className="flex items-baseline justify-between mb-3">
          <span className="text-stone-500">合計（{cartCount}点）</span>
          <span className="text-3xl font-bold text-stone-900">
            ¥{cartTotal.toLocaleString()}
          </span>
        </div>

        {/* 預り金・お釣り表示 */}
        <div className="rounded-2xl border-2 border-amber-400 p-4 mb-3">
          <div className="flex items-baseline justify-between">
            <span className="text-stone-500 text-sm">預り金</span>
            <span className="text-4xl font-bold text-stone-900">
              ¥{receivedNum.toLocaleString()}
            </span>
          </div>
          <div className="flex items-baseline justify-between mt-2 pt-2 border-t border-stone-200">
            <span className="text-stone-500 text-sm">お釣り</span>
            <span
              className={`text-2xl font-bold ${
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

        {/* クイック金額 */}
        <div className="grid grid-cols-4 gap-2 mb-2">
          <button
            onClick={() => setReceived(String(cartTotal))}
            className="py-3 rounded-xl bg-amber-50 text-amber-800 font-bold active:scale-95"
          >
            ちょうど
          </button>
          {QUICK_AMOUNTS.map((amt) => (
            <button
              key={amt}
              onClick={() => setReceived(String(amt))}
              className="py-3 rounded-xl bg-stone-100 text-stone-800 font-semibold active:scale-95"
            >
              {amt / 1000}千
            </button>
          ))}
        </div>

        <Numpad onKey={pressReceived} />
        <button
          onClick={() => setReceived('')}
          className="w-full mt-2 py-2 rounded-lg text-stone-500 text-sm"
        >
          クリア
        </button>

        <button
          onClick={() => setStep('change')}
          disabled={received === '' || change < 0}
          className="w-full mt-3 bg-amber-700 text-[#faf9f5] py-5 rounded-2xl font-bold text-xl disabled:opacity-30 active:scale-95 transition-transform"
        >
          会計する
        </button>
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
        <button onClick={loadMenus} className="text-sm text-stone-500 underline">
          ↻ 更新
        </button>
      </div>

      <div className="flex items-center justify-between bg-stone-50 rounded-lg px-3 py-2 mb-4">
        <span className="text-stone-500">
          本日 <span className="font-bold text-stone-800">{sales.length}</span> 組 / 売上{' '}
          <span className="font-bold text-stone-800">¥{dayTotal.toLocaleString()}</span>
        </span>
        <button
          onClick={openClosing}
          disabled={sales.length === 0}
          className="text-amber-700 font-semibold underline disabled:opacity-30"
        >
          締める
        </button>
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

      {loading && <p className="text-stone-400 text-center py-8">読み込み中...</p>}

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
            <button
              key={m.name}
              onClick={() => setCount(m.name, 1)}
              className={`relative rounded-2xl p-4 text-left min-h-28 flex flex-col justify-between active:scale-95 transition-transform border-2 ${
                count > 0 ? 'border-amber-500 bg-amber-50' : 'border-stone-300 bg-white'
              }`}
            >
              <p className="font-bold text-stone-900 leading-snug">{m.name}</p>
              <p className="text-amber-800 font-bold text-lg mt-1">
                ¥{m.price.toLocaleString()}
              </p>
              {count > 0 && (
                <>
                  <span className="absolute top-2 right-2 min-w-7 h-7 px-1.5 rounded-full bg-amber-600 text-[#faf9f5] font-bold flex items-center justify-center">
                    {count}
                  </span>
                  <span
                    role="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      setCount(m.name, -1)
                    }}
                    className="absolute bottom-2 right-2 w-8 h-8 rounded-full bg-stone-200 text-stone-700 text-xl font-bold flex items-center justify-center"
                  >
                    −
                  </span>
                </>
              )}
            </button>
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
          <div className="bg-white w-full max-w-lg rounded-t-2xl md:rounded-2xl p-5 space-y-4">
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

            {/* 取り置きサービス（うずらのアチャール） */}
            <div className="bg-amber-50/60 border border-amber-200 rounded-lg p-3">
              <div className="flex items-end gap-3">
                <div className="flex-1">
                  <label className="block text-sm text-stone-500 mb-1">取り置き件数</label>
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
                  {acharLoading ? (
                    <span className="text-stone-400">原価を計算中…</span>
                  ) : acharCost === null ? (
                    <span className="text-amber-600">
                      「{TORIOKI_RECIPE}」のレシピ未登録（原価0）
                    </span>
                  ) : (
                    <>
                      {TORIOKI_RECIPE} ¥{acharCost.toLocaleString()}/食
                      <br />
                      サービス分{' '}
                      <span className="font-bold text-stone-800">
                        ¥{toriokiCost.toLocaleString()}
                      </span>
                    </>
                  )}
                </div>
              </div>
              <p className="text-xs text-stone-400 mt-1">
                ※ サービス分はその他経費に自動加算されます
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
