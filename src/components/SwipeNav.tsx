import { useRef, useState, useEffect, type ReactNode } from 'react'
import { useNavigate, useLocation, useNavigationType } from 'react-router-dom'

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
 * 左へスワイプすると一つ前の画面へ戻る。指に追従し、離すと滑らかにスライドして戻る。
 * ブラウザ標準の端スワイプ（隣の履歴へ進む/戻る）は touch-action で抑制する。
 */
export function SwipeNav({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const location = useLocation()
  const navType = useNavigationType()
  const depth = useRef(0)

  // 履歴の深さを追跡（戻れるかどうかの判定用）
  useEffect(() => {
    if (navType === 'PUSH') depth.current += 1
    else if (navType === 'POP') depth.current = Math.max(0, depth.current - 1)
  }, [location.key, navType])

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
    // 戻し操作なので左方向のみ追従（右方向は無視）
    setDx(Math.min(0, ddx))
  }

  const onTouchEnd = () => {
    if (!start.current) {
      if (dx !== 0) {
        setAnimating(true)
        setDx(0)
        window.setTimeout(() => setAnimating(false), 200)
      }
      return
    }
    start.current = null
    if (dx < -THRESHOLD && depth.current > 0) {
      // 画面外まで滑らせてから戻る
      setAnimating(true)
      setDx(-window.innerWidth)
      window.setTimeout(() => {
        navigate(-1)
        setAnimating(false)
        setDx(0)
      }, 200)
    } else {
      // 閾値未満：元の位置へ滑らかに戻す
      setAnimating(true)
      setDx(0)
      window.setTimeout(() => setAnimating(false), 200)
    }
  }

  return (
    <div
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      style={{
        transform: dx ? `translateX(${dx}px)` : undefined,
        transition: animating ? 'transform 0.2s ease-out' : undefined,
        touchAction: 'pan-y',
      }}
    >
      {children}
    </div>
  )
}
