import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../lib/auth'
import { readRange, AuthExpiredError } from '../lib/sheets'

type DetailItem = { name: string; qty: number; unit: string }

export default function CostPage() {
  const { token, login, logout } = useAuth()
  const [recipeMap, setRecipeMap] = useState<Record<string, DetailItem[]>>({})
  const [priceMap, setPriceMap] = useState<Record<string, number>>({})
  const [recipeNames, setRecipeNames] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [salePrice, setSalePrice] = useState('')
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
      const [detail, master] = await Promise.all([
        readRange(token, 'レシピ食材明細!A2:G'),
        readRange(token, '食材マスタ!A2:D'),
      ])
      const prices: Record<string, number> = {}
      for (const r of master) {
        const name = (r[0] ?? '').trim()
        if (name) prices[name] = Number(r[3]) || 0
      }
      const recipes: Record<string, DetailItem[]> = {}
      for (const r of detail) {
        const recipe = (r[0] ?? '').trim()
        const ingredient = (r[1] ?? '').trim()
        if (!recipe || !ingredient) continue
        if (!recipes[recipe]) recipes[recipe] = []
        recipes[recipe].push({
          name: ingredient,
          qty: Number(r[2]) || 0,
          unit: (r[3] ?? '').trim(),
        })
      }
      setPriceMap(prices)
      setRecipeMap(recipes)
      setRecipeNames(Object.keys(recipes).sort())
    } catch (e) {
      handleAuthError(e)
    } finally {
      setLoading(false)
    }
  }, [token, handleAuthError])

  useEffect(() => {
    load()
  }, [load])

  const items = selected ? (recipeMap[selected] ?? []) : []
  const rows = items.map((it) => {
    const price = priceMap[it.name] ?? 0
    return { ...it, price, cost: it.qty * price }
  })
  const totalCost = rows.reduce((s, r) => s + r.cost, 0)
  const unknownCount = rows.filter((r) => r.price === 0).length

  const sale = Number(salePrice) || 0
  const costRate = sale > 0 ? (totalCost / sale) * 100 : 0
  const profit = sale - totalCost

  const matchingRecipes = search
    ? recipeNames.filter((n) => n.includes(search)).slice(0, 30)
    : []

  if (!token) {
    return (
      <div className="p-6 flex flex-col items-center justify-center min-h-[70svh] gap-6">
        <div className="text-6xl">💴</div>
        <h1 className="text-xl font-bold text-amber-800">原価計算</h1>
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
        <h1 className="text-xl font-bold text-amber-800">💴 原価計算</h1>
        <button onClick={load} className="text-xs text-stone-400 underline">
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

      {/* レシピ選択 */}
      {!selected && !loading && (
        <>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="レシピ名で検索…"
            className="w-full border border-stone-300 rounded-lg px-3 py-2 mb-3"
          />
          <p className="text-xs text-stone-400 mb-2">
            全 {recipeNames.length} レシピ
          </p>
          <div className="space-y-1">
            {matchingRecipes.map((name) => (
              <button
                key={name}
                onClick={() => {
                  setSelected(name)
                  setSearch('')
                  setSalePrice('')
                }}
                className="w-full text-left border border-stone-200 rounded-lg px-3 py-2 active:bg-stone-50"
              >
                <span className="font-medium text-stone-800">{name}</span>
                <span className="text-xs text-stone-400 ml-2">
                  {recipeMap[name]?.length ?? 0} 種
                </span>
              </button>
            ))}
            {search && matchingRecipes.length === 0 && (
              <p className="text-center text-stone-400 text-sm py-8">
                一致するレシピがありません
              </p>
            )}
            {!search && (
              <p className="text-center text-stone-400 text-sm py-8">
                レシピ名を入力して選択してください
              </p>
            )}
          </div>
        </>
      )}

      {/* 原価明細 */}
      {selected && (
        <>
          <button
            onClick={() => setSelected(null)}
            className="text-stone-400 text-sm mb-3"
          >
            ← レシピ選択へ
          </button>
          <h2 className="font-bold text-stone-800 mb-3">{selected}</h2>

          <div className="border border-stone-200 rounded-lg overflow-hidden mb-4">
            <table className="w-full text-sm">
              <thead className="bg-stone-50 text-stone-500">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">食材</th>
                  <th className="text-right px-2 py-2 font-medium">使用量</th>
                  <th className="text-right px-2 py-2 font-medium">単価</th>
                  <th className="text-right px-3 py-2 font-medium">原価</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr
                    key={i}
                    className={`border-t border-stone-100 ${
                      r.price === 0 ? 'bg-amber-50/50' : ''
                    }`}
                  >
                    <td className="px-3 py-2 text-stone-800">{r.name}</td>
                    <td className="px-2 py-2 text-right text-stone-500">
                      {r.qty}
                      {r.unit}
                    </td>
                    <td className="px-2 py-2 text-right text-stone-500">
                      {r.price === 0 ? (
                        <span className="text-amber-600">未設定</span>
                      ) : (
                        `¥${r.price}`
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-medium text-stone-700">
                      ¥{Math.round(r.cost).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {unknownCount > 0 && (
            <p className="text-xs text-amber-600 mb-3">
              ※ {unknownCount} 件の食材が単価未設定です。「食材」タブで設定すると正確になります。
            </p>
          )}

          <div className="bg-stone-50 rounded-xl p-4 space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-stone-500">合計原価</span>
              <span className="text-2xl font-bold text-stone-800">
                ¥{Math.round(totalCost).toLocaleString()}
              </span>
            </div>
            <div>
              <label className="block text-sm text-stone-500 mb-1">売価（円）</label>
              <input
                type="number"
                inputMode="numeric"
                value={salePrice}
                onChange={(e) => setSalePrice(e.target.value)}
                placeholder="例: 1500"
                className="w-full border border-stone-300 rounded-lg px-3 py-2 text-lg"
              />
            </div>
            {sale > 0 && (
              <div className="grid grid-cols-2 gap-3 pt-2">
                <div className="bg-white rounded-lg p-3 text-center">
                  <p className="text-xs text-stone-400">原価率</p>
                  <p
                    className={`text-xl font-bold ${
                      costRate > 35 ? 'text-red-500' : 'text-green-600'
                    }`}
                  >
                    {costRate.toFixed(1)}%
                  </p>
                </div>
                <div className="bg-white rounded-lg p-3 text-center">
                  <p className="text-xs text-stone-400">粗利</p>
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
