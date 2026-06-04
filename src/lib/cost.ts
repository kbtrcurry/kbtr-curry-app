import type { DetailItem } from './recipes'

export const TAX = 1.08 // 軽減税率8%（食材単価は税抜→原価は税込）

type NumMap = Record<string, number | null>

export type CostCtx = {
  recipeMap: Record<string, DetailItem[]>
  priceMap: Record<string, number> // 食材名 → 税抜単価(円/g)
  yieldMap: NumMap
  servingWeightMap: NumMap
  servingsMap: NumMap
}

/** レシピの一食あたり原価（税込） */
export function perServingCost(name: string, ctx: CostCtx): number {
  const items = ctx.recipeMap[name] ?? []
  const total = items.reduce(
    (s, it) => s + it.qty * (ctx.priceMap[it.name] ?? 0) * TAX,
    0,
  )
  const sv = ctx.servingsMap[name]
  const y = ctx.yieldMap[name]
  const w = ctx.servingWeightMap[name]
  const eff = sv && sv > 0 ? sv : y && w && w > 0 ? y / w : null
  return eff ? total / eff : total
}

/** "レシピ名×食分, ..." を構成に分解 */
export function parseComps(s: string): { name: string; servings: number }[] {
  return s
    .split(/[,、]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((tok) => {
      const i = tok.lastIndexOf('×')
      if (i > 0) {
        const nm = tok.slice(0, i).trim()
        const n = Number(tok.slice(i + 1))
        if (!Number.isNaN(n)) return { name: nm, servings: n }
      }
      return { name: tok, servings: 1 }
    })
}

/** メニュー1食分の原価（税込）= Σ 構成レシピの一食原価 × 食分 */
export function menuUnitCost(recipeStr: string, ctx: CostCtx): number {
  return parseComps(recipeStr).reduce(
    (s, c) => s + perServingCost(c.name, ctx) * c.servings,
    0,
  )
}
