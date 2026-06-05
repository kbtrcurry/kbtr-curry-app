import { useEffect, useRef, useState, type ReactNode } from 'react'
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
 * 左へスワイプで「同じタブ内で一段階戻る」。タブ間移動はしない。
 * window レベルでタッチを拾うため、余白やどの要素の上でも確実に反応する。
 */
export function SwipeNav({ children }: { children: ReactNode }) {
  const backRef = useBackHandlerRef()
  const startRef = useRef<{ x: number; y: number } | null>(null)
  const horiz = useRef(false)
  const dxRef = useRef(0)
  const [dx, setDx] = useState(0)
  const [animating, setAnimating] = useState(false)

  useEffect(() => {
    const THRESHOLD = 55

    const snapBack = () => {
      setAnimating(true)
      setDx(0)
      window.setTimeout(() => setAnimating(false), 200)
    }

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1 || hasHScrollAncestor(e.target)) {
        startRef.current = null
        return
      }
      const t = e.touches[0]
      startRef.current = { x: t.clientX, y: t.clientY }
      horiz.current = false
      dxRef.current = 0
    }

    const onMove = (e: TouchEvent) => {
      const s = startRef.current
      if (!s) return
      const t = e.touches[0]
      const ddx = t.clientX - s.x
      const ddy = t.clientY - s.y
      if (!horiz.current) {
        if (Math.abs(ddx) < 20) return
        if (Math.abs(ddx) <= Math.abs(ddy)) {
          // 縦方向のスクロールと判断 → このジェスチャーは無視
          startRef.current = null
          return
        }
        horiz.current = true
      }
      const v = Math.min(0, ddx) // 左方向のみ追従
      dxRef.current = v
      setDx(v)
    }

    const onEnd = () => {
      const s = startRef.current
      const v = dxRef.current
      startRef.current = null
      dxRef.current = 0
      if (s && horiz.current && v < -THRESHOLD) {
        const handled = backRef?.current?.() ?? false
        if (handled) {
          // 入れ替わった前の画面を中央へ滑らかにスライドイン
          setAnimating(true)
          setDx(0)
          window.setTimeout(() => setAnimating(false), 220)
          return
        }
      }
      if (v !== 0) snapBack()
    }

    window.addEventListener('touchstart', onStart, { passive: true })
    window.addEventListener('touchmove', onMove, { passive: true })
    window.addEventListener('touchend', onEnd, { passive: true })
    window.addEventListener('touchcancel', onEnd, { passive: true })
    return () => {
      window.removeEventListener('touchstart', onStart)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
      window.removeEventListener('touchcancel', onEnd)
    }
  }, [backRef])

  return (
    <div
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
