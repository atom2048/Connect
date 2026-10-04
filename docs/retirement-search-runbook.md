# Connect 廃止・検索導入 runbook

この変更は、DM/話題ハッシュタグの廃止と検索導入を同じProduction切替に依存させない。

## Release tracks

### Track A — DM

1. A1: UI・producer・Push表示を停止し、Firestore/StorageはPhase Aの既存read predicateを維持する。DM write、typing、call/signaling、read-receipt、reaction、attachment writeは即時停止する。
2. Data Access監査が実際に観測可能であることをtest readで確認する。
3. 監査確認後をT0として、72時間連続のlegacy readなし、またはA1公開から最大7日でA2へ進む。監査欠損期間は0件扱いしない。
4. A2: Firestore DM readとStorage DM read/listもdenyする。Rules変更だけでなく、Admin SDK/Functions/Vercel producerが停止済みであることを別確認する。

Searchの成功・失敗・BLOCKEDはTrack Aの進行条件ではない。DM A2とSearchを同日に切り替える場合は、commit、時間帯、smoke testを分離する。

### Track B — Search

1. Preflight Aはread-onlyで実行する。Firestore edition、post件数、public eligibility、本文長分布、projection documentサイズ、token/index見積もり、post update頻度、non-search update率、notification counter、DM/hashtag writer、Rules allow経路を確認する。
2. Preflight B開始前に `scripts/search-preflight-gates.json` とscan budgetをgate commitとして固定する。基準変更時は別commit・理由記録・B全再実行が必要。
3. staging/emulatorを優先し、prototype collectionを使って本番アルゴリズムを測る。full `postSearchIndex` とSearch APIはB合格前に外部公開しない。
4. B合格後にSearch Function、Firestore indexes、backfillを進める。Function/backfill/repairは同じtransaction-based `syncPostSearchIndex(postId)`を使う。
5. full backfillとintegrity verification完了後、Vercel環境変数 `SEARCH_API_ENABLED=true` と `SEARCH_INDEX_READY=true` を同時に有効化する。未設定時のSearch APIはfail-closedで503を返す。
6. Exploreの検索UIは `GET /api/search/ready` が200を返した場合だけ描画する。未設定・503・timeout・通信失敗時は検索フォームと検索カテゴリを表示せず、検索query付きlegacy URLも通常ニュースへ正規化する。API本体のfail-closed gateと二重化する。

## Search API公開gate

次が全て確認できるまでAPIをProduction公開しない。

- Search Function deployed
- required Firestore composite indexes READY
- full backfill complete
- current schema/normalizer coverage verified
- stale/orphan rate within the frozen gate
- canonical batch authorization verified
- Preflight Bのlatency、candidate scan、Function invocation、golden query gateがPASS

`postSearchIndex/**` はclient get/list/query/create/update/deleteをRulesで拒否する。Admin SDKはRulesを迂回するため、server writer停止はRulesとは別の責務である。

## Correctness contract

- `sourceVersion` はstable canonical projectionのSHA-256。同一projectionの一致確認だけに使い、新旧順序の比較には使わない。
- canonical postが存在しない、非public、malformedの場合はderived indexを削除する。DM、notification、post、hashtag aggregateなど既存user dataは削除しない。
- candidate取得はcurrent schema/normalizer version、deterministic anchor、`scanLimit + 1` lookaheadで行う。
- `nextCursor` は最後にscanしたcandidateを指す。`items=[] / hasMore=true` は正常な中間pageであり、zero resultと同一視しない。
- index内部のmatch、author/block prefilter、canonical post batch read、index整合確認、visibility確認が完了するまでresponse DTOを作らない。
- malformed indexはSearch API中に修復writeせず、skipとtelemetryのみ。repair/reconcilerが修復する。

## DM/notification compatibility

既存 `dm` / `story_reply` documentはlegacy decoder用に残す。新規producer、Push、未読badge、mark-all-read、Active一覧には含めない。既発行Storage download URLのtoken revokeは今回のscope外であり、最終報告ではRules path accessとdirect URL accessを分けて記録する。

## Evidence status

- Local: command、commit、timestamp、expected、actual
- Preview: Local項目 + deployment ID/Preview URL
- Production: Preview項目 + deployment ID/URL/device/browser
- P99母数不足、監査ログ未確認、TURN/iPhone未確認、Rules Emulator未実行はPASSにしない

このworkspaceではProduction deploy、Firebase Rules/Functions deploy、実Firestore backfill、監査ログ、実機確認を実行していない場合、最終報告で `NOT VERIFIED` とする。
