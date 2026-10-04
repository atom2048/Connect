# Connect SNS

友達とつながる、モダンなSNSアプリケーション。Firebase Auth + Firestore を使用し、Vercelで無料公開可能です。DMと話題ハッシュタグ機能は廃止済みで、検索はニュース画面の検索欄から提供します。

## 機能一覧

- **認証**: メール/パスワード、Google、Facebook、Apple、Microsoft ログイン
- **ホームフィード**: 友達+自分の投稿を時系列表示（無限スクロール）
- **投稿**: テキスト、画像URL、気分、場所付き投稿
- **インタラクション**: いいね、コメント（ネスト対応）、シェア、削除
- **プロフィール**: カバー画像、アバター、自己紹介、投稿一覧、編集機能
- **友達機能**: 検索、追加、削除、一覧表示
- **検索**: ニュース・ユーザー・公開投稿を検索（投稿検索はProduction gate完了後に有効化）
- **通知**: いいね・コメント・友達リクエストの通知（未読管理）
- **広告**: フィード内に広告カードを自然に挿入
- **ダークモード**: ライト/ダーク切替、localStorage保存
- **レスポンシブ**: モバイルファースト、下部ナビゲーション
- **SEO**: OGP、Twitter Card、metaタグ対応

## 技術スタック

- **フロントエンド**: HTML5 + CSS3 (Custom Properties) + Vanilla JavaScript (ES Modules)
- **ビルドツール**: Vite
- **バックエンド**: Firebase Auth + Cloud Firestore
- **デプロイ**: Vercel (推奨) / Firebase Hosting

## 前提条件

- Node.js 18+ と npm
- Firebase アカウント (無料枠で十分)
- Vercel アカウント (無料)

## セットアップ手順

### 1. Firebase プロジェクトの作成

1. [Firebase Console](https://console.firebase.google.com) にアクセス
2. 「プロジェクトを作成」→ プロジェクト名を入力 → 「作成」
3. 「アナリティクス」は必要に応じて有効化（不要なら無効でOK）

### 2. Firebase Auth の設定

1. Firebase Console > 「Authentication」→ 「始める」
2. 「Sign-in method」タブで以下を有効化:
   - **メール/パスワード**: 有効にする
   - **Google**: 有効にして、プロジェクトのサポートメールを設定
   - **Facebook**: Facebook for Developers でアプリを作成し、App ID と App Secret を入力
   - **Apple**: 「Appleでログイン」を有効（Apple Developer Program が必要な場合あり）
   - **Microsoft**: 「Microsoftでログイン」 を有効にして、Azure AD アプリケーション ID を入力

   > **注**: メール/パスワードのみでも動作します。他プロバイダは必要に応じて設定してください。

### 3. Cloud Firestore の作成

1. Firebase Console > 「Firestore Database」→ 「データベースを作成」
2. 「テストモード」で開始（後でセキュリティルールを適用）
3. ロケーションを選択（最も近いリージョン）

### 4. Firebase 設定情報の取得

1. Firebase Console > プロジェクト設定 > 「全般」
2. 「マイアプリ」→ 「Web」アイコン（`</>`）をクリック
3. アプリのニックネームを入力 → 「登録」
4. `firebaseConfig` オブジェクトの値をコピー

### 5. プロジェクトのセットアップ

```bash
# リポジトリのクローンまたはダウンロード
cd sns-app

# 依存関係のインストール
npm install

# 環境変数ファイルの作成
cp .env.example .env
```

`.env` ファイルを編集し、Firebase設定を記入:

```env
VITE_FIREBASE_API_KEY=AIzaSy...
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=123456789
VITE_FIREBASE_APP_ID=1:123456789:web:abc123
```

### 6. Firestore Security Rules の適用

1. Firebase Console > 「Firestore Database」→ 「ルール」タブ
2. `firestore.rules` の内容をコピー＆ペースト
3. 「公開」をクリック

### 7. ローカル開発

```bash
npm run dev
```

ブラウザで `http://localhost:3000` が開きます。

### 8. Firebase インデックスの作成

アプリケーションを最初に使用する際、Firebase からインデックス作成を促すエラーが発生することがあります。エラーメッセージに表示されるリンクをクリックして、必要なインデックスを作成してください。

必要なインデックス:
- `posts` コレクション: `userId` ASC, `createdAt` DESC (複合インデックス)
- `comments` コレクション: `postId` ASC, `createdAt` ASC (複合インデックス)
- `notifications` コレクション: `userId` ASC, `createdAt` DESC (複合インデックス)
- `likes` コレクション: `postId` ASC (単一フィールド)
- `friendships` コレクション:
  - `userId` ASC, `status` ASC
  - `friendId` ASC, `status` ASC

> **ヒント**: アプリを一度起動してエラーが出たら、Firebase Console > Firestore > インデックス で不足しているインデックスを確認し作成できます。

### 9. サンプルデータの投入

初回ログイン後、フィードが空の場合に「サンプルデータを読み込む」ボタンが表示されます。
クリックすると、3人のデモユーザー・6件の投稿・コメント・いいね・友情関係・広告が自動生成されます。

または、コンソールから手動でシードすることも可能です（詳細は後述）。

## Vercel へのデプロイ

### 方法1: Vercel CLI

```bash
# Vercel CLI のインストールとログイン
npm install -g vercel
vercel login

# デプロイ（環境変数を対話的に設定）
vercel

# 環境変数を設定
vercel env add VITE_FIREBASE_API_KEY
vercel env add VITE_FIREBASE_AUTH_DOMAIN
vercel env add VITE_FIREBASE_PROJECT_ID
vercel env add VITE_FIREBASE_STORAGE_BUCKET
vercel env add VITE_FIREBASE_MESSAGING_SENDER_ID
vercel env add VITE_FIREBASE_APP_ID

# 本番デプロイ
vercel --prod
```

### 方法2: GitHub + Vercel

1. GitHub にリポジトリを作成し、コードをプッシュ
2. [Vercel Dashboard](https://vercel.com) で「New Project」
3. GitHub リポジトリを連携
4. Framework Preset で「Vite」を選択
5. Environment Variables に Firebase 設定（上記6つ）を追加
6. 「Deploy」をクリック

## デモアカウント一覧

サンプルデータ投入後に使用できるデモアカウント:

| 名前 | メール | パスワード | 説明 |
|------|--------|-----------|------|
| Zuck | zuck@demo.com | demo123456 | Meta創業者 |
| Samay | samay@demo.com | demo123456 | コメディアン |
| Emma | emma@demo.com | demo123456 | ライター |

※ `@hikakin` は現在のシードデータには含まれていません。既に本番データ側に存在する場合は、投稿済みアカウント保護のため自動削除対象にはしません。

## プロジェクト構成

```
sns-app/
├── index.html           # メインHTML（SEOタグ含む）
├── package.json         # 依存関係
├── vite.config.js       # Vite設定
├── vercel.json          # Vercelデプロイ設定
├── firestore.rules      # Firestoreセキュリティルール
├── .env.example         # 環境変数の例
├── public/
│   ├── robots.txt       # クローラー設定
│   └── sitemap.xml      # サイトマップ
└── src/
    ├── main.js          # エントリーポイント
    ├── style.css        # 全スタイルシート
    ├── firebase.js      # Firebase初期化
    ├── auth.js          # 認証ロジック
    ├── db.js            # Firestore CRUD操作
    ├── router.js        # SPAルーター
    ├── state.js         # 状態管理
    ├── utils.js         # ユーティリティ関数
    ├── seed.js          # サンプルデータ生成
    ├── components.js    # UIコンポーネント
    └── pages.js         # 各ページのロジック
```

## Firestore データ設計

### コレクション一覧

- **users**: ユーザープロフィール (`uid`, `displayName`, `username`, `email`, `photoURL`, `avatarColor`, `bio`, `friendsCount`, `createdAt`)
- **posts**: 投稿 (`userId`, `text`, `imageURL`, `mood`, `location`, `likesCount`, `commentsCount`, `sharesCount`, `createdAt`)
- **comments**: コメント (`postId`, `userId`, `text`, `parentId`, `createdAt`)
- **likes**: いいね (`postId`, `userId`, `createdAt`) — ドキュメントIDは `${postId}_${userId}`
- **friendships**: 友情関係 (`userId`, `friendId`, `status`, `requester`, `createdAt`) — ドキュメントIDは `${min(userId,friendId)}_${max(userId,friendId)}`
- **notifications**: 通知 (`userId`, `type`, `fromUserId`, `postId`, `read`, `createdAt`)
- **ads**: 広告 (`advertiser`, `title`, `body`, `imageURL`, `ctaText`, `ctaLink`, `createdAt`)

## セキュリティ

- Firestore Security Rules で各操作の認可制御
- XSS対策: `textContent` 優先、`innerHTML` はエスケープ済みの安全なデータのみ
- ユーザー入力はすべて `escapeHtml()` でサニタイズ
- 自分の投稿・プロフィールのみ編集・削除可能
- 通知は対象ユーザーのみ閲覧可能

## 拡張方法

1. **画像アップロード**: Firebase Storage を追加し、プロフィール写真・投稿画像のアップロード機能を実装
2. **リアルタイム更新**: Firestoreの `onSnapshot` を使用してリアルタイム同期
3. **検索**: ニュース画面の検索欄からニュース・ユーザー・公開投稿を検索
4. **グループ機能**: `groups` + `group_members` コレクションでグループ作成・管理
5. **ハッシュタグメタデータ**: 投稿表示・検索互換のため、投稿内のハッシュタグmetadataは保持（トレンド集計画面・集計writerは廃止）
6. **通知プッシュ**: Firebase Cloud Messaging でプッシュ通知
7. **管理画面**: 管理ユーザー向けダッシュボード（ユーザー管理、広告管理）

## 注意点

1. **Firestore 無料枠**: 1日あたり書き込み50,000、読み取り50,000の制限あり。デモ用途では十分ですが、大規模利用には有料プランが必要です。
2. **Firebase Auth 無料枠**: メール認証は無制限、ソーシャルログイン無料。電話認証のみ有料。
3. **インデックス**: 複合クエリにはインデックスが必要。Firebase Console で自動的に作成できます。
4. **環境変数**: APIキーは環境変数で管理し、Git にコミットしないでください。
5. **OGP画像**: デフォルトのOGP画像は設定していません。必要に応じて実際の画像URLに置き換えてください。
6. **シードデータ**: Auth アカウント作成にはレート制限があるため、大量のユーザーを一度に作成すると失敗する可能性があります。

## ライセンス

MIT

---

**Happy connecting!** 🚀

## Connect モバイルアプリ (iOS / Android)

Expo + React Native WebView で、公開中の Connect Web アプリをネイティブアプリとして起動できます。
Web版と同じ Firebase / Vercel 本番環境を利用するため、投稿、QR、ストーリー、ニュース、検索などの現行機能を利用します。DM、ストーリー返信、Connect Spaces は廃止済みで、既存データは互換読取用に保持される場合がありますが、新規作成・送信・表示導線はありません。

### 起動

```bash
# 初回のみ。すでに実行済みなら不要
cd mobile
npm install

# Expo開発サーバー
npm run start

# Androidエミュレータ / 実機
npm run android

# iOS Simulator / 実機 (macOS + Xcodeが必要)
npm run ios
```

ルートから実行する場合:

```bash
npm run mobile:start
npm run mobile:android
npm run mobile:ios
```

### ビルド

Expo Application Services を使う場合、Expoアカウントでログイン後に以下を実行します。

```bash
cd mobile
npx eas login
npx eas init
npx eas build --platform android
npx eas build --platform ios
```

`mobile/app.json` の `extra.eas.projectId` は、`eas init` 後に発行された値へ置き換えてください。

### 権限

アプリは以下の既存Connect機能のために、iOS/Androidでカメラ、マイク、写真/動画アクセス権限を宣言しています。

- QRコード読み取り
- 画像/動画投稿
- ストーリー投稿
- 音声通話 / ビデオ通話
