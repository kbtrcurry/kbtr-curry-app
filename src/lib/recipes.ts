import { readRange } from './sheets'

export type DetailItem = {
  name: string
  qty: number
  unit: string
  memo: string
  row: number // レシピ食材明細シートの行番号（メモ保存用）
}

// レシピ食材明細シートのメモ列
export const DETAIL_MEMO_COL = 'H'

export type RecipeData = {
  recipeMap: Record<string, DetailItem[]> // レシピ名 → 食材明細
  typeMap: Record<string, string> // レシピ名 → 料理タイプ
  saleMap: Record<string, number | null> // レシピ名 → 販売価格(円/一食・税込)
  yieldMap: Record<string, number | null> // レシピ名 → 総重量(g)
  servingWeightMap: Record<string, number | null> // レシピ名 → 一食重量(g)
  servingsMap: Record<string, number | null> // レシピ名 → 食数
  rowMap: Record<string, number> // レシピ名 → レシピ一覧シートの行番号
  names: string[] // 全レシピ名（レシピ一覧順）
  types: string[] // 存在する料理タイプ（表示順）
}

// レシピ一覧シートの列
export const YIELD_COL = 'G' // 総重量（仕上がり量g）
export const SALE_COL = 'Y' // 販売価格(円/一食・税込)
export const SERVING_WEIGHT_COL = 'Z' // 一食重量(g)
export const SERVINGS_COL = 'AA' // 食数
const YIELD_IDX = 6
const SALE_IDX = 24
const SERVING_WEIGHT_IDX = 25
const SERVINGS_IDX = 26

function numOrNull(s: string | undefined): number | null {
  const t = (s ?? '').trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isNaN(n) ? null : n
}

// 料理タイプの表示順
const TYPE_ORDER = [
  'カレー',
  'ビリヤニ',
  'キーマ',
  'ダル',
  'サブジ・野菜',
  'アチャール',
  'チャトニ',
  'ライタ',
  '揚げ物',
  'ご飯もの',
  'パン・麺',
  'ドリンク',
  'その他',
]

/** レシピ一覧（名前・料理タイプ）とレシピ食材明細をまとめて読み込む */
export async function loadRecipes(token: string): Promise<RecipeData> {
  const [list, detail] = await Promise.all([
    readRange(token, 'レシピ一覧!A2:AA'),
    readRange(token, 'レシピ食材明細!A2:H'),
  ])

  const typeMap: Record<string, string> = {}
  const saleMap: Record<string, number | null> = {}
  const yieldMap: Record<string, number | null> = {}
  const servingWeightMap: Record<string, number | null> = {}
  const servingsMap: Record<string, number | null> = {}
  const rowMap: Record<string, number> = {}
  const names: string[] = []
  list.forEach((r, i) => {
    const name = (r[0] ?? '').trim()
    if (!name) return
    typeMap[name] = (r[1] ?? '').trim() || 'その他'
    saleMap[name] = numOrNull(r[SALE_IDX])
    yieldMap[name] = numOrNull(r[YIELD_IDX])
    servingWeightMap[name] = numOrNull(r[SERVING_WEIGHT_IDX])
    servingsMap[name] = numOrNull(r[SERVINGS_IDX])
    rowMap[name] = i + 2 // シート行番号（A2始まり）
    names.push(name)
  })

  const recipeMap: Record<string, DetailItem[]> = {}
  detail.forEach((r, i) => {
    const recipe = (r[0] ?? '').trim()
    const ingredient = (r[1] ?? '').trim()
    if (!recipe || !ingredient) return
    if (!recipeMap[recipe]) recipeMap[recipe] = []
    recipeMap[recipe].push({
      name: ingredient,
      qty: Number(r[2]) || 0,
      unit: (r[3] ?? '').trim(),
      memo: (r[7] ?? '').trim(),
      row: i + 2, // シート行番号
    })
  })

  const present = new Set(Object.values(typeMap))
  const ordered = TYPE_ORDER.filter((t) => present.has(t))
  // TYPE_ORDER に無いタイプは末尾に追加
  const extra = [...present].filter((t) => !TYPE_ORDER.includes(t)).sort()
  const types = [...ordered, ...extra]

  return {
    recipeMap,
    typeMap,
    saleMap,
    yieldMap,
    servingWeightMap,
    servingsMap,
    rowMap,
    names,
    types,
  }
}
