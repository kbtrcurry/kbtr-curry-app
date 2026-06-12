const keyFor = (date: string) => `kbtr_event_${date}`

export type EventData = {
  groups?: number  // 当日の会計組数（締め時に自動保存）
  people?: number  // 当日の客数（人数合計・締め時に自動保存）
  cost?: number    // 仕入れ実費（手動入力・円）
}

export function getEventData(date: string): EventData {
  try { return JSON.parse(localStorage.getItem(keyFor(date)) ?? '{}') as EventData }
  catch { return {} }
}

export function patchEventData(date: string, patch: Partial<EventData>): void {
  const prev = getEventData(date)
  localStorage.setItem(keyFor(date), JSON.stringify({ ...prev, ...patch }))
}
