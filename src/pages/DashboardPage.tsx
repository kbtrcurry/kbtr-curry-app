import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../lib/auth'
import {
  readRange,
  updateValues,
  deleteRow,
  getSheetId,
  AuthExpiredError,
} from '../lib/sheets'
import { usePersistedState } from '../lib/persistState'
import { getCached, setCached, clearCache } from '../lib/dataCache'
import { getEventData } from '../lib/eventData'
import { useKeyboardOffset } from '../lib/useKeyboardOffset'

type Summary = {
  idx: number
  date: string
  sales: number
  foodCost: number
  locationFee: number
  otherCost: number
  profit: number
  memo: string
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
    sales: '',
    foodCost: '',
    locationFee: '',
    otherCost: '',
    memo: '',
  })
  const [busy, setBusy] = useState(false)

  const [dashTab, setDashTab] = usePersistedState<DashTab>('kbtr_view_dash_tab', 'summary')
  const [period, setPeriod] = usePersistedState<Period>('kbtr_view_dash_period', 'all')
  const [targetInput, setTargetInput] = useState('')
  useKeyboardOffset()

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
      const [sum, rec] = await Promise.all([
        readRange(token, '営業サマリー!A2:H'),
        readRange(token, '営業記録!A2:E'),
      ])
      const newSummaries = sum
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
        }))
      const newRecords = rec
        .filter((r) => (r[0] ?? '').trim() && (r[1] ?? '').trim())
        .map((r) => ({
          date: (r[0] ?? '').trim(),
          menu: (r[1] ?? '').trim(),
          qty: Number(r[2]) || 0,
          subtotal: Number(r[4]) || 0,
        }))
      setSummaries(newSummaries)
      setRecords(newRecords)
      setCached('dash_summaries', newSummaries)
      setCached('dash_records', newRecords)
    } catch (e) {
      if (!silent) handleAuthError(e)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [token, handleAuthError])

  useEffect(() => {
    const hasCached =
      getCached('dash_summaries') !== null && getCached('dash_records') !== null
    load(hasCached)
  }, [load])

  const startEdit = (s: Summary, sid: string) => {
    setEditId(sid)
    setEdit({
      sales: String(s.sales),
      foodCost: String(s.foodCost),
      locationFee: String(s.locationFee),
      otherCost: String(s.otherCost),
      memo: s.memo,
    })
  }

  const saveEdit = async (s: Summary) => {
    if (!token) return
    setBusy(true)
    setError(null)
    try {
      const sales = Number(edit.sales) || 0
      const foodCost = Number(edit.foodCost) || 0
      const fee = Number(edit.locationFee) || 0
      const other = Number(edit.otherCost) || 0
      const profit = sales - foodCost - fee - other
      const rate = sales > 0 ? Math.round((foodCost / sales) * 1000) / 10 : 0
      const row = s.idx + 2 // A2 が先頭データ行
      await updateValues(token, `営業サマリー!B${row}:H${row}`, [
        [sales, foodCost, fee, profit, rate, edit.memo, other],
      ])
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

  const removeSession = async (s: Summary) => {
    if (!token) return
    if (!confirm(`${s.date} の営業記録を削除しますか？（元に戻せません）`)) return
    setBusy(true)
    setError(null)
    try {
      const sheetId = await getSheetId(token, '営業サマリー')
      await deleteRow(token, sheetId, s.idx + 1) // 0始まり行（ヘッダー=0）
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

  // 集計
  const tm = thisMonth()
  const tmSummaries = summaries.filter((s) => monthOf(s.date) === tm)
  const tmSales = tmSummaries.reduce((a, s) => a + s.sales, 0)
  const tmProfit = tmSummaries.reduce((a, s) => a + s.profit, 0)
  const tmFoodCost = tmSummaries.reduce((a, s) => a + s.foodCost, 0)
  const tmRate = tmSales > 0 ? (tmFoodCost / tmSales) * 100 : null
  const totalSales = summaries.reduce((a, s) => a + s.sales, 0)

  // 月別売上
  const byMonth: Record<string, number> = {}
  for (const s of summaries) byMonth[monthOf(s.date)] = (byMonth[monthOf(s.date)] ?? 0) + s.sales
  const months = Object.entries(byMonth).sort((a, b) => a[0].localeCompare(b[0]))
  const monthMax = Math.max(1, ...months.map(([, v]) => v))

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

  // メニュー別販売数
  const byMenu: Record<string, number> = {}
  for (const r of records) byMenu[r.menu] = (byMenu[r.menu] ?? 0) + r.qty
  const menus = Object.entries(byMenu).sort((a, b) => b[1] - a[1]).slice(0, 10)
  const menuMax = Math.max(1, ...menus.map(([, v]) => v))

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

  // ── 仕込み計算タブ用 ──
  const target = Math.max(0, parseInt(targetInput) || 0)
  const prepCalc = (() => {
    if (eventDates.length === 0) return null
    // 各イベント日の組数（eventDataから）と商品別数量（recordsから）
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
        <button onClick={() => load()} className="text-sm text-stone-500 underline">
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
          {/* KPI */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 mb-5">
            <Kpi label={`今月の売上（${tm}）`} value={yen(tmSales)} />
            <Kpi label="今月の利益" value={yen(tmProfit)} accent />
            <Kpi
              label="今月の原価率"
              value={tmRate != null ? `${tmRate.toFixed(1)}%` : '—'}
            />
            <Kpi label="累計売上" value={yen(totalSales)} />
          </div>

          {/* 月別売上 */}
          {months.length > 0 && (
            <Section title="月別売上">
              <div className="flex items-end gap-2 h-32">
                {months.map(([mn, v]) => (
                  <div key={mn} className="flex-1 flex flex-col items-center justify-end">
                    <span className="text-[10px] text-stone-500 mb-1">
                      {Math.round(v / 1000)}k
                    </span>
                    <div
                      className="w-full bg-amber-500 rounded-t"
                      style={{ height: `${(v / monthMax) * 100}%` }}
                    />
                    <span className="text-[10px] text-stone-400 mt-1">{mn.slice(5)}</span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* 売上・利益の推移（折れ線） */}
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

          {/* 営業履歴（各回タップで詳細） */}
          {sessions.length > 0 && (
            <Section title="営業履歴（タップで詳細）">
              <div className="space-y-2">
                {sessions.map((s) => {
                  const sid = `${s.date}#${s.idx}`
                  const open = openId === sid
                  const rate = s.sales > 0 ? (s.foodCost / s.sales) * 100 : null
                  const menus = Object.entries(recByDate[s.date] ?? {}).sort(
                    (a, b) => b[1].amount - a[1].amount,
                  )
                  return (
                    <div key={sid} className="border border-stone-200 rounded-xl overflow-hidden">
                      <button
                        onClick={() => setOpenId(open ? null : sid)}
                        className="w-full text-left px-3 py-2.5"
                      >
                        <div className="flex justify-between items-center text-sm mb-1">
                          <span className="font-semibold text-stone-800">
                            {open ? '▾' : '▸'} {s.date}
                          </span>
                          <span className="text-stone-600">
                            売上 <b className="text-stone-900">{yen(s.sales)}</b>
                            <span className="text-stone-300 mx-1">/</span>
                            利益 <b className="text-green-700">{yen(s.profit)}</b>
                          </span>
                        </div>
                        <div className="h-2 bg-stone-100 rounded overflow-hidden">
                          <div
                            className="h-full bg-amber-500"
                            style={{ width: `${(s.sales / recentMax) * 100}%` }}
                          />
                        </div>
                      </button>

                      {open && editId === sid && (
                        <div className="px-3 pb-3 pt-2 border-t border-stone-100 text-sm space-y-2">
                          <div className="grid grid-cols-2 gap-2">
                            <EditField
                              label="売上"
                              value={edit.sales}
                              onChange={(v) => setEdit((e) => ({ ...e, sales: v }))}
                            />
                            <EditField
                              label="食材原価"
                              value={edit.foodCost}
                              onChange={(v) => setEdit((e) => ({ ...e, foodCost: v }))}
                            />
                            <EditField
                              label="場所代"
                              value={edit.locationFee}
                              onChange={(v) => setEdit((e) => ({ ...e, locationFee: v }))}
                            />
                            <EditField
                              label="その他経費"
                              value={edit.otherCost}
                              onChange={(v) => setEdit((e) => ({ ...e, otherCost: v }))}
                            />
                          </div>
                          <div>
                            <label className="block text-xs text-stone-500 mb-1">メモ</label>
                            <input
                              type="text"
                              value={edit.memo}
                              onChange={(e) =>
                                setEdit((p) => ({ ...p, memo: e.target.value }))
                              }
                              className="w-full border border-stone-300 rounded-lg px-3 py-2"
                            />
                          </div>
                          <p className="text-xs text-stone-400">
                            利益 = 売上 − 食材原価 − 場所代 − その他経費（自動計算）
                          </p>
                          <div className="flex gap-2 pt-1">
                            <button
                              onClick={() => setEditId(null)}
                              disabled={busy}
                              className="flex-1 py-2 rounded-lg border border-stone-300 text-stone-600 font-semibold"
                            >
                              キャンセル
                            </button>
                            <button
                              onClick={() => saveEdit(s)}
                              disabled={busy}
                              className="flex-1 py-2 rounded-lg bg-amber-700 text-[#faf9f5] font-bold disabled:opacity-50"
                            >
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
                            {s.otherCost > 0 && (
                              <Row label="その他経費" value={yen(s.otherCost)} />
                            )}
                            <Row label="利益" value={yen(s.profit)} accent />
                            <Row
                              label="原価率"
                              value={rate != null ? `${rate.toFixed(1)}%` : '—'}
                            />
                          </div>
                          {(() => {
                            const ev = getEventData(s.date)
                            if (!ev.cost && !ev.groups) return null
                            const grossProfit = ev.cost != null ? s.sales - ev.cost : null
                            const costRate = ev.cost != null && s.sales > 0
                              ? Math.round((ev.cost / s.sales) * 100) : null
                            return (
                              <div className="bg-amber-50/60 border border-amber-200 rounded-lg px-3 py-2 mb-2 text-xs space-y-0.5">
                                <p className="font-semibold text-amber-800 mb-1">仕入れ実費</p>
                                {ev.groups != null && <Row label="組数" value={`${ev.groups} 組`} />}
                                {ev.cost != null && ev.cost > 0 && (
                                  <>
                                    <Row label="仕入れ" value={yen(ev.cost)} />
                                    {grossProfit != null && <Row label="粗利" value={yen(grossProfit)} accent={grossProfit >= 0} />}
                                    {costRate != null && <Row label="原価率" value={`${costRate}%`} />}
                                  </>
                                )}
                              </div>
                            )
                          })()}
                          {s.memo && (
                            <p className="text-stone-500 mb-2">メモ: {s.memo}</p>
                          )}
                          {menus.length > 0 && (
                            <div className="bg-stone-50 rounded-lg p-2 mb-2">
                              <p className="text-xs text-stone-400 mb-1">メニュー別</p>
                              {menus.map(([mn, v]) => (
                                <div
                                  key={mn}
                                  className="flex justify-between py-0.5 text-stone-700"
                                >
                                  <span className="truncate">
                                    {mn} <span className="text-stone-400">×{v.qty}</span>
                                  </span>
                                  <span className="font-medium text-stone-800 shrink-0 ml-2">
                                    {yen(v.amount)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                          <div className="flex gap-2">
                            <button
                              onClick={() => startEdit(s, sid)}
                              disabled={busy}
                              className="flex-1 py-2 rounded-lg border border-stone-300 text-stone-700 font-semibold active:bg-stone-50"
                            >
                              ✏️ 編集
                            </button>
                            <button
                              onClick={() => removeSession(s)}
                              disabled={busy}
                              className="flex-1 py-2 rounded-lg border border-red-200 text-red-600 font-semibold active:bg-red-50 disabled:opacity-50"
                            >
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
          )}

          {/* メニュー別販売数 */}
          {menus.length > 0 && (
            <Section title="メニュー別 販売数">
              <div className="space-y-1.5">
                {menus.map(([mn, v]) => (
                  <div key={mn} className="flex items-center gap-2 text-sm">
                    <span className="w-28 truncate text-stone-700 shrink-0">{mn}</span>
                    <div className="flex-1 h-4 bg-stone-100 rounded overflow-hidden">
                      <div
                        className="h-full bg-amber-400"
                        style={{ width: `${(v / menuMax) * 100}%` }}
                      />
                    </div>
                    <span className="w-8 text-right font-semibold text-stone-700">{v}</span>
                  </div>
                ))}
              </div>
            </Section>
          )}
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

              {productStats.length === 0 ? (
                <p className="text-center text-stone-400 text-sm py-8">データがありません</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-stone-200 text-stone-500 text-xs">
                        <th className="text-left pb-2">商品名</th>
                        <th className="text-right pb-2 pr-2">販売数</th>
                        <th className="text-right pb-2 pr-2">売上</th>
                        <th className="text-right pb-2">構成比</th>
                      </tr>
                    </thead>
                    <tbody>
                      {productStats.map((p) => (
                        <tr key={p.name} className="border-b border-stone-100">
                          <td className="py-2 pr-2 font-medium text-stone-800 truncate max-w-32">{p.name}</td>
                          <td className="py-2 pr-2 text-right text-stone-700">{p.qty}</td>
                          <td className="py-2 pr-2 text-right text-stone-700">{yen(p.amount)}</td>
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
                        <td className="pt-2 text-right">100%</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
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
    </div>
  )
}

function Kpi({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="border border-stone-200 rounded-xl p-3">
      <p className="text-xs text-stone-500">{label}</p>
      <p className={`text-xl font-bold ${accent ? 'text-green-700' : 'text-stone-900'}`}>
        {value}
      </p>
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
          <text x={x(i)} y={H - 8} fontSize="8" textAnchor="middle" fill="#918b81">
            {d.label}
          </text>
        </g>
      ))}
    </svg>
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <h2 className="text-sm font-bold text-stone-700 mb-2">{title}</h2>
      {children}
    </div>
  )
}
