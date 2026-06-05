// 起動直後に全画面ぶんのデータを取得してキャッシュを温める。
// これにより各タブを初めて開いたときの「読み込み中」表示が出なくなる。
import { readRange } from './sheets'
import { loadRecipes } from './recipes'
import { setCached } from './dataCache'

const DISABLED_FLAGS = ['off', 'false', '無効', 'no', '0']

function num(s: unknown): number {
  const t = String(s ?? '').trim()
  if (t === '') return 0
  const n = Number(t)
  return Number.isNaN(n) ? 0 : n
}

let started = false

/** 全ページのデータを並列取得し、各ページのキャッシュキーへ書き込む。1セッション1回のみ実行。 */
export async function preloadAll(token: string): Promise<void> {
  if (started || !token) return
  started = true
  try {
    const [rd, master, menuRows, summaryRows, recordRows] = await Promise.all([
      loadRecipes(token),
      readRange(token, '食材マスタ!A2:J'),
      readRange(token, 'メニュー構成!A2:D'),
      readRange(token, '営業サマリー!A2:I'),
      readRange(token, '営業記録!A2:E'),
    ])

    // ── レジ（pos_menus） ──
    const menus = menuRows
      .filter((r) => r[0]?.trim())
      .filter((r) => !DISABLED_FLAGS.includes((r[3] ?? '').trim().toLowerCase()))
      .map((r) => ({ name: r[0].trim(), price: num(r[1]), recipe: (r[2] ?? '').trim() }))
    setCached('pos_menus', menus)

    // ── 売上（dash_summaries / dash_records） ──
    const summaries = summaryRows
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => (r[0] ?? '').trim())
      .map(({ r, i }) => ({
        idx: i,
        date: (r[0] ?? '').trim(),
        sales: num(r[1]),
        foodCost: num(r[2]),
        locationFee: num(r[3]),
        profit: num(r[4]),
        memo: (r[6] ?? '').trim(),
        otherCost: num(r[7]),
        uzuraCost: num(r[8]),
      }))
    const validDates = new Set(summaries.map((s) => s.date))
    const seenRec = new Set<string>()
    const records = recordRows
      .filter((r) => (r[0] ?? '').trim() && (r[1] ?? '').trim())
      .map((r) => ({
        date: (r[0] ?? '').trim(),
        menu: (r[1] ?? '').trim(),
        qty: num(r[2]),
        subtotal: num(r[4]),
      }))
      .filter((r) => validDates.has(r.date))
      .filter((r) => {
        const k = `${r.date}|${r.menu}|${r.qty}|${r.subtotal}`
        if (seenRec.has(k)) return false
        seenRec.add(k)
        return true
      })
    setCached('dash_summaries', summaries)
    setCached('dash_records', records)

    // ── 食材（ing_list） ──
    const ingList = master
      .map((r, i) => ({
        row: i + 2,
        name: (r[0] ?? '').trim(),
        category: (r[1] ?? '').trim(),
        unit: (r[2] ?? '').trim(),
        pricePerG: num(r[3]),
        supplier: (r[4] ?? '').trim(),
        count: num(r[5]),
        weight: num(r[6]),
        stock: num(r[7]),
        unitPrice: num(r[8]),
        threshold: num(r[9]),
      }))
      .filter((x) => x.name)
    ingList.sort((a, b) => b.count - a.count)
    setCached('ing_list', ingList)

    // ── 仕込み（prep_data） ──
    const stockMap: Record<string, number | null> = {}
    for (const r of master) {
      const name = (r[0] ?? '').trim()
      if (!name) continue
      const s = (r[7] ?? '').trim()
      stockMap[name] = s === '' ? null : Number(s)
    }
    setCached('prep_data', {
      recipeMap: rd.recipeMap,
      typeMap: rd.typeMap,
      names: rd.names,
      types: rd.types,
      stockMap,
    })

    // ── レシピ（recipe_data） ──
    const priceMap: Record<string, number> = {}
    for (const r of master) {
      const name = (r[0] ?? '').trim()
      if (!name) continue
      const pricePerG = num(r[3])
      if (pricePerG > 0) {
        priceMap[name] = pricePerG
      } else {
        const weight = num(r[6])
        const unitPrice = num(r[8])
        priceMap[name] = weight > 0 && unitPrice > 0 ? unitPrice / weight : 0
      }
    }
    setCached('recipe_data', {
      priceMap,
      recipeMap: rd.recipeMap,
      typeMap: rd.typeMap,
      saleMap: rd.saleMap,
      yieldMap: rd.yieldMap,
      swMap: rd.servingWeightMap,
      servingsMap: rd.servingsMap,
      rowMap: rd.rowMap,
      names: rd.names,
      types: rd.types,
    })
  } catch {
    // 失敗しても各ページが自前で再取得するので握りつぶす
    started = false
  }
}
