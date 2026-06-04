import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../lib/auth'
import { readRange, AuthExpiredError } from '../lib/sheets'

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
const monthOf = (d: string) => d.slice(0, 7) // YYYY-MM
const thisMonth = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export default function DashboardPage() {
  const { token, login, logout } = useAuth()
  const [summaries, setSummaries] = useState<Summary[]>([])
  const [records, setRecords] = useState<SaleRec[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)

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
      const [sum, rec] = await Promise.all([
        readRange(token, '営業サマリー!A2:H'),
        readRange(token, '営業記録!A2:E'),
      ])
      setSummaries(
        sum
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
          })),
      )
      setRecords(
        rec
          .filter((r) => (r[0] ?? '').trim() && (r[1] ?? '').trim())
          .map((r) => ({
            date: (r[0] ?? '').trim(),
            menu: (r[1] ?? '').trim(),
            qty: Number(r[2]) || 0,
            subtotal: Number(r[4]) || 0,
          })),
      )
    } catch (e) {
      handleAuthError(e)
    } finally {
      setLoading(false)
    }
  }, [token, handleAuthError])

  useEffect(() => {
    load()
  }, [load])

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
        <button onClick={load} className="text-sm text-stone-500 underline">
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

                      {open && (
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
                          {s.memo && (
                            <p className="text-stone-500 mb-2">メモ: {s.memo}</p>
                          )}
                          {menus.length > 0 && (
                            <div className="bg-stone-50 rounded-lg p-2">
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
