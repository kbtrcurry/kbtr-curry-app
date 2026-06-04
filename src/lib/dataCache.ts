// タブ切替で毎回 API を叩かないよう、fetch 結果を sessionStorage にキャッシュする。
// - 初回: キャッシュ無し → ローディング表示あり
// - 2回目以降: キャッシュを即座に表示しつつバックグラウンドでサイレント更新

const PREFIX = 'kbtr_dc_'

export function getCached<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(PREFIX + key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

export function setCached<T>(key: string, value: T): void {
  try {
    sessionStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch { /* quota超過は無視 */ }
}

export function clearCache(key: string): void {
  sessionStorage.removeItem(PREFIX + key)
}
