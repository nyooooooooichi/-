# ITO ONLINE

PCとスマホのブラウザから、ルームコードで友達とリアルタイム対戦できるITO風カードゲームです。

## 入っている機能

- PC / スマホ対応
- 6桁ルームコード
- 友達とオンライン参加
- お題：ランダム / 自作
- 1人2枚、1〜100からランダム配布
- 各カードの数字は本人だけに表示
- 各カードにヒント入力
- 全員のヒントをリアルタイム同期
- 並び順を全員で同期
- ホストが答え合わせ
- 答え合わせ時に数字を公開
- 次ラウンド

## 1. Supabaseを作る

1. https://supabase.com/ で新しいProjectを作る
2. SQL Editorを開く
3. `supabase/schema.sql` を全部貼り付けて実行
4. Authentication → Providers / Sign In で **Anonymous Sign-Ins** を有効にする
5. Projectの **URL** と **Publishable key** を確認する

※ `service_role` キーは絶対にブラウザへ入れないでください。

## 2. .envを作る

`.env.example` をコピーして `.env` に変更し、中身を自分のSupabase情報にします。

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxxxx
```

## 3. 起動

Node.jsを入れてから、このフォルダで:

```bash
npm install
npm run dev
```

表示されたURLをブラウザで開きます。

## 4. 公開

Vercel / Netlify などにこのフォルダをアップロードして、同じ2つの環境変数を設定すれば公開できます。

Build command:
```bash
npm run build
```

Output directory:
```text
dist
```

## 遊び方

1. 1人が「ルームを作る」
2. 6桁コードを友達へ送る
3. 友達は「ルームに参加」
4. ホストがお題を決めて開始
5. 各プレイヤーに数字カード2枚
6. 各カードにヒントを入力
7. 全カードのヒントを小さいと思う順に並べる
8. ホストが「答え合わせ」


## Netlifyで公開する最短手順

1. https://app.netlify.com/drop を開く
2. Netlifyにログインする
3. このZIPを解凍して、`ito-online-netlify` フォルダをそのままDropエリアへ入れる
4. 公開URLが表示される
5. NetlifyのSite configuration → Environment variables に以下を追加:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_PUBLISHABLE_KEY`
6. Deploysから再デプロイする

SupabaseのSQLは `supabase/schema.sql` をSupabase SQL Editorで1回だけ実行してください。
