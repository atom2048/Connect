# Phase 3-C Media Implementation Prompt

> Archived prompt. Its DM upload requirements are superseded by the DM retirement contract and must not be implemented again.

対象は `C:\Users\akihi\.codex\sns-app` のみ。

Phase 1〜3-B は完了済み。今回は Phase 3-C として、Phase 3-B の調査結果に基づき、既存データ互換を維持したままメディア転送量削減の最小実装を行う。

## やらないこと

Cloud Functions の本格動画圧縮、Firebase Extensions の本番有効化、PWA、Pake、完全な仮想リスト、大規模UI刷新、Firestore rules / storage rules の緩和、本番DBへのバックフィル実行、Firebase deploy は行わない。必要な deploy コマンドがある場合は報告だけにする。

## 対象ファイル

- `src/attachments.ts`
- `src/types/domain.ts`
- `src/db.ts`
- `src/components.ts`
- `src/pageModules/home.ts`
- `src/pageModules/explore.ts`
- `src/pageModules/communications.ts`
- `src/pageModules/profile.ts`
- `docs/performance-checklist.md`
- `docs/manual-smoke-test-checklist.md`
- 必要なら `firestore.rules` / `storage.rules` は確認のみ。緩和しない。

## 実装する最小範囲

1. 新規投稿アップロードで optional media metadata を保存する。
   - 既存の `imageURLs`, `imageAlts`, `videoURL` は維持する。
   - 追加する場合は optional `attachments` として保存し、既存投稿に無くても動く fallback を維持する。
   - 画像は `storagePath`, `width`, `height`, `size`, `mimeType` を保存する。
   - 動画は `storagePath`, `duration`, `width`, `height`, `size`, `mimeType` を可能な範囲で保存する。

2. 新規DMアップロードで optional media metadata を保存する。
   - 既存の `imageURL`, `videoURL`, `fileURL`, `fileName` は維持する。
   - 追加する場合は optional `attachments` または同等の metadata を保存し、既存DMに無くても動く fallback を維持する。

3. コメント添付は Phase 3-A で `attachments/storagePath/metadata` 対応済みなので、壊れていないか確認する。

4. 表示ルールを全画面で統一する。
   - 画像一覧: `thumbnailUrl || previewUrl || url`。
   - 原寸表示/ダウンロード: `url`。
   - 動画一覧: `thumbnailUrl || previewUrl` があればサムネイル表示。無ければ既存どおり `preload="none"` の video fallback。
   - 動画本体URLは、可能ならユーザー操作時または詳細表示時にだけ `src` をセットする。ただしリスクが高ければ `preload="none"` 維持までに留める。
   - PDF/zip/text/audio は一覧で本文・本体を取得せず、ファイル名/種別/サイズ/リンク/controls に留める。

## thumbnail / preview 生成の判断条件

以下のどちらかを選び、理由を報告する。

A. クライアント側 image preview 生成
- 採用条件: Cloud Functions / Extensions をまだ deploy したくない、まず新規画像だけ低リスクに軽くしたい。
- 実装範囲: 小〜中サイズ画像だけ canvas で WebP/JPEG preview を生成し、original と preview を別 Storage path にアップロードして `previewUrl` と `storagePath` を保存する。
- リスク: モバイルCPU/メモリ、EXIF、巨大画像。失敗時は original-only fallback。

B. Cloud Functions / Firebase Extensions 用の準備だけ
- 採用条件: クライアントCPU負荷を増やしたくない、バックエンドで一貫生成したい。
- 実装範囲: このPhaseでは `storagePath` と metadata を確実に保存し、Functions/Extensions は設計・stub・docs まで。deploy はしない。
- リスク: 次Phaseでbackend deployと監視が必要。

## 既存データ fallback

既存投稿、既存コメント、既存DM、既存添付に新フィールドが無くても従来表示すること。

Fallback:
- Posts: `attachments` があれば利用。無ければ `imageURLs`, `imageURL`, `videoURL`。
- Comments: `attachments` があれば利用。無ければ `imageURL`, `imageURLs`, `videoURL`, `audioURL`, `fileURL`。
- DM: 新 metadata があれば利用。無ければ `imageURL`, `videoURL`, `fileURL`, `fileName`。
- Profiles: post attachment preview があれば利用。無ければ legacy post URLs。

## Firestore / Storage rules 注意点

- Rules を緩めない。
- 新しい thumbnail/preview path を使う場合は、既存 owner-scoped path に置くか、必要な rules を最小追加として報告する。
- Firebase deploy は実行しない。必要なら `firebase deploy --only firestore:rules,storage` などを報告だけする。

## 検証コマンド

必ず実行する。

- `npm run typecheck`
- `npm run build`
- `npm run design:lint` が存在する場合
- `npm run lint` が存在する場合。無ければ未定義と報告。
- `git diff --check`

## 手動確認

- `localStorage.setItem('CONNECT_PERF_DEBUG', '1')` を有効化して reload。
- Feed, comments, DM, profile media, Explore を Chrome Network と Firebase Console Storage Usage で確認。
- 画像一覧で preview/thumbnail が使われるか確認。
- 動画一覧で本体が勝手に読み込まれないか確認。
- 既存データに新フィールドが無い投稿/DM/コメントも表示確認。

## ロールバック方針

- Legacy URL fields を残す。
- `thumbnailUrl/previewUrl/attachments` は optional にする。
- preview 生成に失敗しても original upload と legacy display が続くようにする。
- commit を分け、必要なら当該 commit を revert できるようにする。

## 報告形式

1. 作業開始時のgit状態
2. 変更したファイル一覧
3. 各ファイルで何を変更したか
4. 採用した preview/thumbnail 方針と理由
5. 投稿アップロードmetadata保存内容
6. DMアップロードmetadata保存内容
7. コメント添付互換確認
8. 表示fallback統一内容
9. Firestore / Storage rules確認結果
10. Firebase側で実行すべきコマンド
11. 実行したコマンドと結果
12. 作成したcommit
13. 既存機能の確認結果
14. 残っているリスク
15. 次にやるべきこと
