import type { Register } from 'claude-code'

// 削除とみなすコマンドの形（Bash / PowerShell / cmd）
const DELETE = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\b/, // rm -rf, rm -fr, rm -Rf …
  /\brm\s+-r\b/,
  /\bRemove-Item\b[^\n]*-Recurse/i,
  /\brmdir\s+\/s\b/i,
  /\bdel\s+\/[sq]\b/i,
  /\bgit\s+clean\s+-[a-zA-Z]*f/,
]

// 説明に「理由」と「影響」が書かれているか
const hasReason = (text: string) => /理由/.test(text) && /影響/.test(text)

const WHY = [
  '削除コマンドは、description に次の2点を書いてから再実行してください。',
  '理由: どのファイル／フォルダを、なぜ不要と判断したか（根拠になった確認内容）',
  '影響: 参照しているファイルや設定の有無、消した場合に動かなくなるものの有無',
  '不要かどうか確信が持てないときは、削除せずに .snapshot-{日時}-{目的}/ へ退避する案を出してください。',
].join('\n')

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = e.command ?? ''
    if (!DELETE.some(re => re.test(command))) return next(e)

    const description = e.description ?? ''
    if (!hasReason(description)) {
      return { deny: `${$.plugin.name}: ${WHY}` }
    }

    const summary = [
      `コマンド: ${command.length > 200 ? command.slice(0, 200) + '…' : command}`,
      `説明: ${description}`,
    ].join('\n')

    let choice: string
    try {
      choice = await $.ui.ask(`削除を実行しますか？\n${summary}`, {
        header: '削除の確認',
        options: ['実行する', 'やめる', '先にスナップショットを取る'],
      })
    } catch {
      return { deny: `${$.plugin.name}: 確認を取れなかったので実行しません（対話できない実行環境）。` }
    }

    if (choice === '実行する') return next(e)
    if (choice === '先にスナップショットを取る') {
      return {
        deny: `${$.plugin.name}: 先に対象を .snapshot-{YYYYMMDD-HHmm}-{目的}/ へ退避し、退避先を報告してから削除を再実行してください。`,
      }
    }
    return { deny: `${$.plugin.name}: ユーザーが削除をやめました。別の方法を提案してください。` }
  })
}
