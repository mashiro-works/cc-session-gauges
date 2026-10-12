# claude-mods MEMORY

## 設計判断
- 2026-10-12 独立 git（main）。identity はこのリポジトリのローカル設定のみ（Mashiro / noreply）。push・remote 設定はユーザー判断まで行わない
- 元ソースは sandbox/tests/claude-mods/workspace/。agents-pane は今回の配布対象外
- 生成物（.claude-plugin/types/）と tsconfig.json は除外。plugin.json の types は自作の ./types/index.d.ts を指すので validate は通る
- marketplace.json の description は英語（公開先が英語圏も含むため）。plugin.json は日本語のまま
- model-watch のログ保存先は ~/.claude/model-watch/{session}.jsonl（README の既知の制限に明記）

## 未解決
- 公式 docs で marketplace.json スキーマを未確認（validate --strict は通過）
- tsconfig.json を外したため、ローカルで型チェックするときは types 生成後に tsconfig を手元で作る必要がある
- delete-guard が Bash の heredoc 内文字列にも反応する件（作業中に実際に発生）。対策は未着手
