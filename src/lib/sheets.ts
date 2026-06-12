const SPREADSHEET_ID = import.meta.env.VITE_SPREADSHEET_ID as string
const BASE = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}`

/** トークン失効を表すエラー（呼び出し側で再ログインを促す） */
export class AuthExpiredError extends Error {
  constructor() {
    super('認証の有効期限が切れました')
    this.name = 'AuthExpiredError'
  }
}

async function handle(res: Response) {
  if (res.status === 401 || res.status === 403) {
    throw new AuthExpiredError()
  }
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Sheets API エラー (${res.status}): ${text}`)
  }
  return res.json()
}

/** 指定範囲を2次元配列で読み込む。データなしは空配列。 */
export async function readRange(
  token: string,
  range: string,
): Promise<string[][]> {
  const res = await fetch(`${BASE}/values/${encodeURIComponent(range)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = await handle(res)
  return data.values ?? []
}

/** 指定範囲の値を上書き更新する。 */
export async function updateValues(
  token: string,
  range: string,
  rows: (string | number)[][],
) {
  const res = await fetch(
    `${BASE}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: rows }),
    },
  )
  return handle(res)
}

/** シート名から sheetId（数値ID）を取得する。 */
export async function getSheetId(token: string, title: string): Promise<number> {
  const res = await fetch(`${BASE}?fields=sheets(properties(sheetId,title))`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const data = await handle(res)
  const sheet = (data.sheets ?? []).find(
    (s: { properties?: { title?: string } }) => s.properties?.title === title,
  )
  if (!sheet) throw new Error(`シート「${title}」が見つかりません`)
  return sheet.properties.sheetId as number
}

/** シートが無ければ作成し、ヘッダー行を書き込む。存在すれば何もしない。
 *  作成・既存いずれの場合も sheetId を返す。 */
export async function ensureSheet(
  token: string,
  title: string,
  header?: string[],
): Promise<number> {
  try {
    return await getSheetId(token, title)
  } catch {
    // 見つからない → 新規作成
    const res = await fetch(`${BASE}:batchUpdate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requests: [{ addSheet: { properties: { title } } }],
      }),
    })
    const data = await handle(res)
    const sheetId = data.replies?.[0]?.addSheet?.properties?.sheetId as number
    if (header && header.length) {
      await updateValues(token, `${title}!A1`, [header])
    }
    return sheetId
  }
}

/** 指定シートの行を物理削除する。rowIndex は0始まり（ヘッダー行=0）。 */
export async function deleteRow(token: string, sheetId: number, rowIndex: number) {
  const res = await fetch(`${BASE}:batchUpdate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: rowIndex,
              endIndex: rowIndex + 1,
            },
          },
        },
      ],
    }),
  })
  return handle(res)
}

/** 複数行をまとめて削除する（0始まり行インデックスの配列）。 */
export async function deleteRows(token: string, sheetId: number, rowIndices: number[]) {
  if (rowIndices.length === 0) return
  // 行ズレを防ぐため降順で削除
  const sorted = [...new Set(rowIndices)].sort((a, b) => b - a)
  const res = await fetch(`${BASE}:batchUpdate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requests: sorted.map((rowIndex) => ({
        deleteDimension: {
          range: { sheetId, dimension: 'ROWS', startIndex: rowIndex, endIndex: rowIndex + 1 },
        },
      })),
    }),
  })
  return handle(res)
}

/** 指定範囲の末尾に行を追加する。 */
export async function appendRows(
  token: string,
  range: string,
  rows: (string | number)[][],
) {
  const res = await fetch(
    `${BASE}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: rows }),
    },
  )
  return handle(res)
}
