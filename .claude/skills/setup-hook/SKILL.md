---
name: setup-hook
description: ターミナルで動いている Claude Code の許可の確認をこのビュワーで受けられるように、~/.claude/settings.json に hook を登録する・外す。ユーザーが「承認の hook を入れて」「setup-hook」「ビュワーで承認できるようにして」「hook を外して」のように頼んだときに使う。
---

# 承認の hook を登録する

`~/.claude/settings.json` の書き換えは `scripts/setup-hook.mjs` に任せる。settings.json を Edit や Write で直接書き換えない。

1. ビュワーを `PORT` や `CLAUDE_LOG_VIEWER_DATA` を変えて起動しているかをユーザーに聞く。変えているなら、以降のコマンドの先頭に同じ値を付ける
2. `npm run setup-hook -- --dry-run` を実行する（外すときは `--remove` も付ける）
3. 出力の「変更前」と「変更後」をユーザーに見せ、このまま書き換えてよいか聞く
4. ユーザーがよいと言ったら、`npm run setup-hook -- --run` を実行する（外すときは `--remove` も付ける）
5. 足したときは、ビュワーの設定画面の「承認」で「hook から届いた確認を受け付ける」をオンにして保存するよう伝える。既定ではオフなので、オンにするまでは何も変わらない
