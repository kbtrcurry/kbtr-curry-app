import { useRef, useState, type ReactNode } from 'react'
import { useBackHandlerRef } from '../lib/backHandler'

// 横スクロール可能な祖先がある場合はスワイプ戻しを無効化（テーブル等との競合回避）
function hasHScrollAncestor(target: EventTarget | null): boolean {
  let n = target as HTMLElement | null
  while (n && n !== document.body) {
    if (n.scrollWidth > n.clientWidth + 2) {
      const ox = getComputedStyle(n).overflowX
      if (ox === 'auto' || ox === 'scroll') return true
    }
    n = n.parentElement
  }
  return false
}

/**
 * 左へスワイプすると「同じタブ内で一段階戻る」。タブ間の移動はしない。
 * 各ページが backHandler を登録しており、戻れたときだけ前の画面が滑らかに入ってくる。
 */
export function SwipeNav({ children }: { children: ReactNode }) {
  const backRef = useBackHandlerRef()
  const start = useRef<{ x: number; y: number } | null>(null)
  const horizontal = useRef(false)
  const [dx, setDx] = useState(0)
  const [animating, setAnimating] = useState(false)

  const THRESHOLD = 70

  const onTouchStart = (e: React.TouchEvent) => {
    if (animating) return
    if (hasHScrollAncestor(e.target)) {
      start.current = null
      return
    }
    const t = e.touches[0]
    start.current = { x: t.clientX, y: t.clientY }
    horizontal.current = false
    setDx(0)
  }

  const onTouchMove = (e: React.TouchEvent) => {
    if (!start.current || animating) return
    const t = e.touches[0]
    const ddx = t.clientX - start.current.x
    const ddy = t.clientY - start.current.y
    if (!horizontal.current) {
      if (Math.abs(ddx) < 12 && Math.abs(ddy) < 12) return
      horizontal.current = Math.abs(ddx) > Math.abs(ddy) * 1.4
      if (!horizontal.current) {
        start.current = null
        return
      }
    }
    // 戻し操作なので左方向のみ追従
    setDx(Math.min(0, ddx))
  }

  const finishSnapBack = () => {
    setAnimating(true)
    setDx(0)
    window.setTimeout(() => setAnimating(false), 200)
  }

  const onTouchEnd = () => {
    const released = start.current
    start.current = null
    if (!released) {
      if (dx !== 0) finishSnapBack()
      return
    }
    if (dx < -THRESHOLD) {
      // 一段階戻れるか試す（戻れたら新しい画面が左から入ってくる）
      const handled = backRef?.current?.() ?? false
      if (handled) {
        // 入れ替わった新しい画面を、ドラッグ位置から中央へ滑らかにスライドイン
        setAnimating(true)
        setDx(0)
        window.setTimeout(() => setAnimating(false), 220)
        return
      }
    }
    finishSnapBack()
  }

  return (
    <div
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      className="w-full"
      style={{
        transform: dx ? `translateX(${dx}px)` : undefined,
        transition: animating ? 'transform 0.22s ease-out' : undefined,
        touchAction: 'pan-y',
      }}
    >
      {children}
    </div>
  )
}
