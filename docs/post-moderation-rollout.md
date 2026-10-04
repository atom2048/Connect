# 投稿モデレーションの有効化

モデレーションAPIはFirebase IDトークンの署名をWorkerで検証し、カスタムクレーム `role=admin` がある場合だけ管理操作を許可します。クライアントのリンク表示は補助であり、認可はWorkerとFirestoreルールの両方で行います。

## 本番反映順

1. Cloudflare D1へ `drizzle/0009_post_moderation.sql` を適用します。
2. `firestore.rules` を反映します。
3. Cloudflare Workerをデプロイします。
4. Vercelクライアントをデプロイします。
5. 信頼されたFirebase Admin SDKの運用環境から、担当者だけに `role: 'admin'` を付与します。既存カスタムクレームを残す場合は、取得した `customClaims` に `role` を追加して設定します。ブラウザーから付与してはいけません。
6. 管理者はFirebase IDトークンを更新してから設定画面の「投稿モデレーション（管理者）」を開きます。

## API

- `GET /api/admin/moderation/posts`: 投稿ID、投稿者、本文、最小通報件数、投稿日時、削除済み状態で検索します。通報件数の多い投稿を先に返します。
- `DELETE /api/admin/posts/{postId}`: `{"reason":"spam|harassment|illegal|other"}` を必須にします。Firestore本文・メディアを公開文書から除き、D1に復旧用スナップショットと別監査行を保存します。
- `POST /api/admin/moderation/posts/{postId}/restore`: 保存済みスナップショットを使って投稿を復旧します。
- `POST /api/posts/{postId}/report`: 投稿者以外のログインユーザーから通報を受け付けます。同じユーザーから同じ投稿への重複通報は拒否します。
- `POST /api/moderation/appeals`: 削除された投稿の本人だけが異議を送れます。管理者はモデレーション画面で状態を更新できます。

監査行と復旧用スナップショットは管理者APIからのみ読めます。対象ユーザー向け通知には管理者IDを含めません。通知はアプリ内に表示し、削除理由を日本語に変換して本人専用の異議フォームへリンクします。

## 対応範囲

通常投稿の本文に対する自動的な不適切語検知・自動削除機能はまだありません。現状はユーザー通報、管理者レビュー、論理削除、復旧、監査、本人通知、異議申し立ての経路を提供します。
