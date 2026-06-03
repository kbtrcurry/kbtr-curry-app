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
