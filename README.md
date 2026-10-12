# claude-mods

Claude Code の Mods（プラグインで動く拡張）を配布するマーケットプレイスです。3つの Mod が入っています。

English: [README.en.md](README.en.md)

## 入っている Mod

| Mod | できること |
|-----|-----------|
| model-watch | リクエストごとに答えたモデルを記録し、入力欄の上の帯に表示します。`/model-watch report` で累計表を出し、`/model-watch force opus` などでサブエージェントのモデルを固定できます |
| usage-band | 5時間枠と週次枠の使用率を、入力欄の上に常時表示します |
| delete-guard | `rm -rf` などの削除コマンドに理由と影響の記述を求め、実行前に確認ダイアログを出します |

## 入れ方

### マーケットプレイスから入れる

Claude Code の中で次のように入力します。

```
/plugin marketplace add mashiro-works/claude-mods
/plugin install model-watch@claude-mods
```

usage-band と delete-guard も同じ形で入れられます（`/plugin install usage-band@claude-mods`、`/plugin install delete-guard@claude-mods`）。

### 入れずに試す

リポジトリを手元に置いて、起動時にフォルダを指定します。そのセッションだけで有効になります。

```
git clone https://github.com/mashiro-works/claude-mods.git
cd claude-mods
claude --plugin-dir ./plugins/model-watch
```

## 入れる前に中身を確かめる

次のコマンドで、Mod が処理するイベントと呼び出す機能を一覧できます。

```
claude plugin validate ./plugins/model-watch
```

Mods はあなたと同じ権限で動き、サンドボックスはありません。入れる前に、何をするのかを確認してください。

## 対応バージョン

| 環境 | 対応 |
|------|------|
| Claude Code（CLI） | 2.1.287 以降 |
| Claude Desktop アプリ | 2.1.286 以降 |
| 動作確認 | 2.1.295 |

## 止め方

- 起動時に `--safe-mode` を付けると、Mods を読み込まずに起動します
- `/plugin` を開き、Installed から対象の Mod を無効にします

## 既知の制限

- model-watch は、エンジン内部の問い合わせ（タイトル生成など）を捕まえられない場合があります
- usage-band と model-watch を両方入れると、入力欄の上の帯が2段になります
- delete-guard は文字列の一致で判定するため、heredoc の中に書いた文字列にも反応します
- model-watch はセッションごとの記録を `~/.claude/model-watch/` に保存します

## ライセンス

MIT License です。詳しくは [LICENSE](LICENSE) を見てください。
