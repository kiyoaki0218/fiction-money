# クレクレコイン（KC）改善・新機能 実装計画

対象リポジトリ: fiction-money（Vercel Serverless + Supabase + Vanilla JS SPA）
本書は「提案の整理 + 実装計画」をまとめるものであり、コード変更はフェーズごとに別途実施する。

---

## 0. 現状アーキテクチャ（計画の前提）

| レイヤ | 実装 | 備考 |
|---|---|---|
| フロント | `public/index.html` + `public/app.js`（約700行、ビルド工程なし） | CDN 読込: tweetnacl / tweetnacl-util / qrcode |
| ウォレット | クライアント生成 Ed25519 キーペア。アドレス = SHA256(公開鍵) の先頭40hex | 秘密鍵は **localStorage に Base64 平文**（`app.js:54,260,273`） |
| API | `server.js`（Express, Vercel 経由）+ `db.js`（Supabase service role クライアント） | 署名検証付き送金、RPC `register_account` / `process_transfer` / `claim_onetime_link` |
| DB | Supabase Postgres: accounts / transactions / coin_info / onetime_links / nicknames / payment_requests | 内部単位は 10^5 の整数（DECIMALS=5） |
| 認可 | 招待コード（環境変数 `INVITE_CODE`）+ トランザクション署名 | Supabase Auth は未使用 |

計画の技術方針:
- **既存の構成（ビルドなし Vanilla JS + CDN / Express サーバーレス / Supabase RPC）を維持する**。フレームワーク移行は本計画の範囲外。
- 暗号は WebCrypto（ブラウザネイティブ）+ tweetnacl を使い、新規ナレッジは BIP-39 単語リスト（CDN パッケージ）のみ。
- DB 変更は Supabase SQL Editor で適用する SQL ファイルとしてリポジトリに追加（既存の `supabase_schema*.sql` の慣習に従う）。

---

## 1. 依頼項目以外で検出した既存課題（Phase 0 として先に解決する）

計画を進める上で、依頼された6領域より先に潰すべき既存の脆弱性・バグを確認した。いずれも小修正で、以後の全フェーズの土台になる。

1. **保存型 XSS による秘密鍵窃取（最重要）**
   ニックネーム等を `innerHTML` に直接挿入している（`app.js` の `loadHistory` / `loadDMList` / `loadRequests`）。攻撃者が自身のニックネームに `<img onerror=...>` を仕込むと、秘密鍵平文保持のため即座に資産が盗まれる。鍵を暗号化しても、ロック解除中の XSS はセッション内の鍵を盗めるため、**エスケープは Phase 1 の前提条件**。
2. **`/api/admin/genesis` が無認可**
   誰でも呼べば総供給量90%が配布対象アドレスに付く（`server.js`）。環境変数 `ADMIN_ADDRESS` で呼び出し元を固定する。
3. **管理ボタンが全ユーザーに常に表示**
   `updateBalance()` で `btn-admin-genesis` を無条件表示している（`app.js`）。
4. **署名対象が浮動小数点文字列**
   署名メッセージが `${from}:${to}:${amount}:${nonce}` で、amount が float のまま。`0.1` 等の表現ゆれ・精度問題を避けるため、**内部整数（amountInternal）で署名**する方式へ統一（サーバ・クライアント同時デプロイで移行）。
5. **レート制限・セキュリティヘッダ・CORS 絞り込みが無い**
   `cors()` 全開放、CSP 等のヘッダなし。Vercel の `vercel.json` headers で対応。
6. **nonce 取得と送信の竞合**
   `fetchNonce() + 1` は同時送信時に衝突しうる。サーバは nonce を検証済みとして使い、失敗時に再取得して1回だけ自動リトライする。
7. **招待コードが URL（`?invite=`）に載る**
   Referer / 履歴に残りうる。Phase 5 の招待チケット化で自然に解消（過渡期は URL 設定後に replaceState で消す）。

---

## 2. フェーズ総覧（優先順位と概算工数）

| Phase | 内容 | 優先度 | 概算工数 | 依存 |
|---|---|---|---|---|
| 0 | 緊急セキュリティ修正（XSS / genesis 保護 / CSP） | 最優先 | 0.5〜1 日 | なし |
| 1 | キーストア化（PBKDF2+AES-GCM）・BIP-39 ニーモニック・セッションロック | 最優先 | 2〜3 日 | Phase 0 |
| 2 | 送金確認モーダル・メモ付き送金・QR カメラ読み取り | 高 | 1〜2 日 | Phase 1（署名メッセージ変更を兼ねる） |
| 3 | 割り勘集金リンク・リクエスト自動消込とステータス管理 | 高 | 2〜3 日 | Phase 2（memo と同一 DB 変更） |
| 4 | Supabase Realtime による即時着金通知 | 中 | 1〜2 日 | Phase 3 |
| 5 | エクスプローラー統計ページ・招待チケット（リファラル） | 中 | 2〜3 日 | なし（並行可） |

各フェーズは独立してデプロイ可能。Phase 2〜3 は署名メッセージ形式・`transactions` スキーマを共に変更するため **同時デプロイ**する（旧ワンタイムリンクは失効扱い、短期間のため許容）。

---

## 3. Phase 0: 緊急セキュリティ修正

**目的**: XSS による鍵窃取を封じ、未保護の管理 API を閉じる。

### 変更内容

1. **HTML エスケープの統一**（`public/app.js`）
   - `escHtml()` ヘルパーを追加し、nickname / memo / 表示名など **外部由来の文字列は全て `textContent` かエスケープ経由**でのみ描画。
   - `loadHistory` / `loadDMList` / `loadRequests` のテンプレート文字列を対象。
   - 履歴・連絡先の表示はエレメント生成（`document.createElement`）へ段階的に移行。
2. **管理 API の保護**（`server.js`）
   - 環境変数 `ADMIN_ADDRESS`（管理者ウォレットアドレス）を追加。
   - `/api/admin/genesis` で `addressFromPublicKey(publicKey) === ADMIN_ADDRESS` を検証し、不一致は 403。
3. **管理ボタンの表示条件修正**（`public/app.js`）
   - 表示は `app.wallet.address === ADMIN_ADDRESS`（フロントにも同定用に `GET /api/info` の `adminAddress` を載せるか、登録時にサーバが `isAdmin` を返す）の場合のみ。
4. **セキュリティヘッダ**（`vercel.json` の `headers`）
   - `X-Content-Type-Options: nosniff` / `Referrer-Policy: no-referrer` / `X-Frame-Options: DENY`。
   - CSP は段階導入: 第1段で `script-src 'self' https://cdn.jsdelivr.net`（ただしインライン onclick が大量にあるため、本フェーズで `data-action` + イベント委譲への置換を実施）。`style-src` も同様に外し済みスタイル属性は残す。
   - CDN のサブリソースに SRI（integrity 属性）を付与。
5. **クライアント署名ヘルパーの一本化**（`public/app.js`）
   - 現状 `nacl.sign.detached` の直書きが7箇所以上に重複。`signMessage(msg)` ヘルパーへ集約し、Phase 1 の「鍵はロック解除中のみメモリ保持」への移行を1箇所で実装できるようにする。
6. **レート制限**（`server.js`）
   - `express-rate-limit` を導入（登録・送金・リンク作成エンドポイントに 10 req/min/IP 程度）。依存追加はこの1つのみ。

### 検証

- ニックネームに `<script>` / `<img onerror>` を設定しても描画されないことを手動確認。
- `ADMIN_ADDRESS` 以外の鍵で `/api/admin/genesis` が 403 になることを確認。
- ブラウザコンソールに CSP 違反が出ないこと。

### 工数: 0.5〜1 日

---

## 4. Phase 1: キーストア化・BIP-39 ニーモニック・セッションロック（最優先）

**目的**: 秘密鍵を「パスワードで暗号化された形」でのみ保存し、鍵の平文保存をやめる。バックアップ手段をニーモニックに統一。無操作ロックで端末離れ時の被害を防ぐ。

### 4.1 キーストア（パスワード暗号化保存）

**保存形式**（localStorage キー `kc_keystore`）:

```json
{
  "v": 1,
  "kdf": "PBKDF2",
  "hash": "SHA-256",
  "iterations": 600000,
  "salt": "<base64 16B>",
  "cipher": "AES-GCM",
  "iv": "<base64 12B>",
  "ct": "<base64(暗号化した secretKey 64B + GCM tag)>",
  "publicKey": "<base64>",
  "address": "<hex40>"
}
```

- KDF は WebCrypto ネイティブの `deriveKey(PBKDF2, SHA-256, 600,000 回)`（OWASP 2023 推奨値。scrypt は WebCrypto 非対応のため採用しない）。暗号は `AES-GCM 256bit`（認証付き）。
- **保存されるのは暗号文のみ**。`app.wallet` に `secretKey` を持たせない（`publicKey` / `address` のみ）。平文鍵はモジュールスコープの `Session.unlock()` にのみ保持。
- 鍵の使用箇所は Phase 0 で集約した `signMessage()` に限定。ロック中は throw し、UI はロック画面へ。

**API（新規 `public/crypto.js`）**:

```js
keystore.encrypt(password, secretKeyBytes, publicKey, address) -> Promise<keystoreJSON>
keystore.decrypt(password, keystoreJSON) -> Promise<Uint8Array>  // 失敗=throw
Session.unlock(password) / Session.lock() / Session.isUnlocked() / Session.getSecretKey()
```

**新規作成フロー**（`createNewWallet`）:
招待コード →（Phase 1 以降）ニーモニック生成確認 → **パスワード設定（確認入力付き、強度チェック）** → 鍵ペア生成 → キーストア保存 → 登録。

**既存ユーザー移行**（互換性の要点）:
- 起動時に旧 `kc_wallet`（平文 JSON）を検出したら、**初回のみ**「パスワード設定」画面を表示し、入力パスワードでキーストアへ変換 → 旧キーを `localStorage.removeItem`。
- 未移行ユーザーには移行を促すトーストを表示（移行を後回しにした状態で送金を許可しない）。
- 秘密鍵の Base64 エクスポートは「パスワード再入力後のみ表示」に変更し、ニーモニックを正規のバックアップ手段とする。

### 4.2 BIP-39 ニーモニック

- 導入: CDN から `@scure/bip39`（英語ワードリスト同梱）を ESM import。生成は `generateMnemonic(wordlist, 128)` = **12単語**（設定で256bit = 24単語）。
- 鍵導出: `mnemonicToSeedSync(mnemonic)` → 64 bytes の先頭32 bytes を `nacl.sign.keyPair.fromSeed()` の入力にし、そこからアドレス導出（`deriveAddress` は現状のまま）。
- 復元画面（`view-restore`）を2モードに: 「ニーモニックで復元」（デフォルト）と「旧 Base64 秘密鍵で復元」（後方互換、復元後は即キーストア化を促す）。
- 生成時の UX: 単語を一度だけ表示 → **手書き確認（3語の入力確認）** → 未確認なら警告を常時表示。
- 検証: `validateMnemonic()` で typo を受付時に拒否。
- **パスワードとニーモニックの役割**を UI で明記（パスワード=この端末のロックのみ。ニーモニック=全資産のバックアップ。パスワード忘れ = ニーモニックから復元して再作成）。

### 4.3 セッションロック・自動ログアウト

- 既定: **無操作 5 分で自動ロック**（設定画面で 1/5/15 分・OFF を選択、`kc_autolock` に保存）。
- トリガー: `mousemove` / `keydown` / `touchstart` / `visibilitychange`（裏タブ化から5分）。
- ロック時: `Session.lock()`（メモリ上の鍵を破棄、`app.wallet` から secretKey 不在を保証）→ ロックオーバーレイ表示（アドレス・残高は非表示）。解除はパスワード入力。
- 試行制限: 5回失敗で指数バックオフ（30s → 60s → …、上限10分）。**クライアント側のみの対策である旨を明記**（サーバ側のパスワード検証は存在しない＝鍵は端末外に出ない設計）。
- ログアウト: 従来通りキーストア削除（＋確認ダイアログで「キーストアを残す（パスワードで再ログイン）」オプションを追加）。

### 変更ファイル

| ファイル | 内容 |
|---|---|
| `public/crypto.js`（新規） | PBKDF2/AES-GCM、BIP-39、`Session` |
| `public/app.js` | 新規/復元/ログイン/移行/ロックUIのフロー制御、`signMessage()` 改修 |
| `public/index.html` | パスワード入力・ニーモニック表示/確認・ロック画面のマークアップ、`crypto.js` 読込 |
| `public/style.css` | ロック画面・パスワードフォームのスタイル |

### 検証

- 正しいパスワードで復号でき、誤パスワードで復号に失敗すること（Node の `webcrypto` で同じロジックの単体テストを追加）。
- 旧 `kc_wallet` 保持状態から起動 → 移行完了後、旧キーが localStorage から消えていること。
- ニーモニック復元が元のアドレスと一致すること（12語/24語双方）。
- 自動ロック後に送金操作が失敗し、パスワード解除で再開できること。
- リロード後も平文鍵が localStorage に存在しないこと（DevTools 確認）。

### 工数: 2〜3 日

---

## 5. Phase 2: 送金・受取 UX 向上

### 5.1 送金確認モーダル（誤送金防止）

- `directSend()` と `fulfillRequest()` を「入力 → 確認 → 実行」の2ステップに変更。
- 確認モーダルに表示: **宛先の表示名**（ニックネームキャッシュ → 未登録なら短縮アドレス `abcd1234...` + フルアドレス改行表示）、**金額**、**送金後残高**（現在残高 − 送金額、変動中の場合は「残高確認中…」）。
- メモ欄もこの画面に入力（50文字、後述5.3）。
- 「実行」で署名 → `/api/send`。取引先が未登録アドレスの場合、確認画面に警告を出す（`GET /api/account/:address` を確認前に呼ぶ）。
- ワンタイム URL 生成・割り勘支払いも同一モーダルを再利用（実装を1箇所に集約）。

### 5.2 QR コード決済（生成 + カメラ読み取り）

- 生成は既存の `qrcode` ライブラリで充足（受取・送金 URL の QR は既存）。
- **読み取り**: `html5-qrcode`（CDN）を導入。受取パネル／送金パネルに「カメラで読み取る」ボタン → フルスクリーンオーバーレイでスキャン。
- 読み取った URL からクエリを解析して分岐: `pay_to`（宛先セット）/ `receive_link`（ワンタイム受取）/ `split`（Phase 3 割り勘）/ `invite`（Phase 5 招待）。
- HTTPS 必須（Vercel は充足）。カメラ拒否・非対応端末では手入力へフォールバック。
- 対面利用を考慮し、スキャン成功時に haptic/音フィードバック（`navigator.vibrate`）。

### 5.3 メモ付き送金

- DB: `transactions.memo varchar(100)` を追加（既存 SQLite 期の `memo` 列の名前・意図を踏襲。Supabase 側は `ALTER TABLE ... ADD COLUMN IF NOT EXISTS memo varchar(100)`）。
- **署名対象に含める**: メッセージ形式を内部整数 + メモ込みへ更新
  `` `${from}:${to}:${amountInternal}:${nonce}:${memo || ''}` ``
  （Phase 0 の float 解消と同時に変更。サーバ・クライアント同時デプロイ。署名検証は `server.js` の4箇所 / `onetime-link` / `process-send` / `requests` 系すべてで新形式に揃える）。
- `process_transfer` RPC に `p_memo` 引数を追加し、txId ハッシュにも memo を含める。
- 表示: 履歴アイテムにメモを1行表示（Phase 0 のエスケープ経由。**メモは XSS の新入口になるので必ずエスケープ**）。
- ワンタイムリンク・送金URL経由の送金にもメモを持たせる（URL では URLSearchParams に追加）。
- **互換性**: 変更前に入れたワンタイムリンクは署名不一致で失効する。リンク有効期限が実質的なものであるため許容し、デプロイ時に Announce（トースト）する。

### 検証

- 確認モーダル経由の送金が実際に DB に memo 付きで入ることを API 呼び出しで確認。
- 古い形式の署名が拒否されること（サーバ側テスト）。
- スマホ実機で QR 読み取りが動作すること（HTTPS プレビューで確認）。

### 工数: 1〜2 日（Phase 3 と同時デプロイ）

---

## 6. Phase 3: 「くれくれ（請求・集金）」拡張

### 6.1 リクエストのステータス管理・自動消込

**現状の問題**: 「支払う」ボタンは送金フォームを埋めるだけで、リクエストとの紐付けがなく、支払ったかどうかは誰も分からない。

- `payment_requests` に追加: `paid_tx_id uuid/null`, `updated_at timestamptz`。
- `/api/send` のリクエストに `requestId` を追加（署名メッセージにも含める: `...:${requestId || ''}`）。
- サーバ側: 送金成功後に `payment_requests` を検証（`id=requestId` かつ `target_address = from` かつ `status='pending'`）して `status='paid'`, `paid_tx_id` を更新。金額が指定リクエスト以上であることを確認（不足なら 400）。
- **新規 API**: `POST /api/requests/sent`（署名必須、`GET_REQUESTS_SENT` メッセージ）— 請求した側が pending / paid / discarded を一覧できる。
- UI: DM パネルに「送ったお願い」タブ（ステータスバッジ + 支払われたらトースト）。受取側のリクエスト一覧は既存のまま。
- 過去の支払との自動照合（取りこぼし救済）: `requests/reconcile` を新設し、`payment_requests` の pending 件数だけ見て、宛先・金額が一致する **直近の受取取引**があれば一括 paid 化するボタンを実装（1クエリで安全）。

### 6.2 割り勘（グループ集金）リンク

**新規テーブル**:

```sql
CREATE TABLE public.split_bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_address varchar NOT NULL,
  title varchar NOT NULL,                 -- 例: "飲み会代"
  total_amount bigint NOT NULL,           -- 内部単位(10^5)
  mode varchar NOT NULL,                  -- 'equal' | 'fixed'
  share_amount bigint NOT NULL,           -- 1人あたり（equal 時はサーバが計算）
  participant_count int NOT NULL,         -- equal 時の人数
  status varchar NOT NULL DEFAULT 'open', -- 'open' | 'completed' | 'cancelled'
  created_at timestamptz DEFAULT now(),
  completed_at timestamptz
);
CREATE TABLE public.split_bill_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id uuid NOT NULL REFERENCES split_bills(id),
  payer_address varchar NOT NULL,
  amount bigint NOT NULL,
  tx_id varchar NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (bill_id, payer_address)         -- 二重支払い防止
);
```

- **作成**: 金額形式（合計÷人数 / 固定額）・タイトル・人数を入力 → URL `${origin}/?split=<id>` を生成（QR 表示・コピーは既存パーツを再利用）。`equal` の割り切りは内部整数で floorし、端数は作成者負担に明示表示。
- **支払**: `split=<id>` を開くと既存の確認モーダルで内容表示（タイトル・1人額・自分の支払状況・残り人数）→ 署名付き送金。
- **RPC `pay_split_bill(p_bill_id, p_payer, p_amount, ...)`**: ①`split_bills` 行を `FOR UPDATE` でロックし open であること確認 → ②`process_transfer` 相当の残高移動・nonce 検証 → ③`split_bill_payments` 挿入（一意制約で二重防止）→ ④全員揃えば `status='completed'` を1つのトランザクションで実行。
- **進捗表示**: 達成率（`支払人数/参加人数`、`集計額/合計額`）のプログレスバー。データ取得は `GET /api/split/:id`（作成者・参加者・**リンクを開いた誰でも**参照可 — 公開情報として扱う。金額とニックネームのみ、フルアドレスは短縮表示）。
- Phase 4 実装後は進捗がリアルタイム更新（それまでは3秒ポーリング or 手動更新）。
- 制限: 作成時の上限額チェック、開催者自身の支払い可否（可とする）、`cancelled` は作成者のみ（署名検証）。

### DB マイグレーションファイル

- `supabase_schema_phase4.sql`（新規）: payment_requests 追加列 + split_bills + split_bill_payments + RPC `process_transfer` の memo/requestId 対応版の再定義。
- Supabase SQL Editor で適用 → `db.js` に `createSplitBill` / `paySplitBill` / `getSplitBill` / `listSentRequests` / `reconcileRequests` を追加 → `server.js` にエンドポイント追加。

### 検証

- 5人中2人が支払 → `2/5` 表示、3人目で `completed` になること。
- 同じ参加者2回目の支払が拒否されること。
- リクエスト支払後、請求側・支払側の双方で `paid` 表示されること。

### 工数: 2〜3 日

---

## 7. Phase 4: Supabase Realtime による即時着金通知

**現状の問題**: リロードまたは手動更新しないと着金・リクエストに気づけない。

### 鍵となる設計判断

Supabase Realtime をブラウザから使うには匿名キーでの購読になるが、**このアプリには Supabase Auth がなく、匿名キーでは RLS で「自分の行だけ」を保証できない**。サービスロールキーをブラウザに出してはならない。そこで:

1. **サーバが短命 JWT を発行する**（推奨方式）
   - 新API `POST /api/realtime-token`: クライアントが `address:REALTIME:<unixtime>` に署名して送付 → サーバが検証 → `SUPABASE_JWT_SECRET`（HS256）で **5分有効** の JWT を発行（claims: `role=authenticated`, `app_metadata.address=<自分のアドレス>`）。
   - ブラウザは `@supabase/supabase-js`（CDN）でこの JWT を `setAuth()` してチャンネル購読。
   - RLS ポリシー: `transactions` / `payment_requests` は `from_addr = (auth.jwt()->'app_metadata'->>'address') OR to_addr = ...` 形式で select を許可。`split_bills` は公開読み、`split_bill_payments` は自分の分のみ。
   - `alter publication supabase_realtime add table transactions, payment_requests, split_bills, split_bill_payments;`
   - サーバコードは service role を使うため RLS 影響なし。JWT 期限切れはタイマーで再発行。
   - **前提**: Supabase ダッシュボードの Project Settings から JWT secret を環境変数 `SUPABASE_JWT_SECRET` に追加する作業がユーザー側で必要（本計画の実行前に1つだけ手動設定）。
2. **フォールバック（JWT secret が用意できない場合）**: 既存 API ポーリングを 15秒 → 30秒 → 60秒（上限2分）の指数的バックオフに置き換え、通知トーストはこの仕組みで先に実装しておく（Realtime は後から差し替える）。

### 実装内容

- 購読イベント: `INSERT on transactions where to_addr = my_address` → 「`{nickname} から {amount} KC 受取」トースト + 残高自動更新。`INSERT on payment_requests where target_address = my_address` → 「送金のお願いが届きました」。split の支払い INSERT → 進捗更新。
 - トーストは既存 `toast()` を再利用（表示名は Phase 0 のエスケープ経由）。
 - 通知の既読管理は簡易に `kc_seen_tx`（最終処理した tx タイムスタンク）で管理し、再接続時の二重通知を防ぐ。
 - 画面非表示中は購読を維持し、`visibilitychange` で復帰時に残高・履歴を再取得。
- 新規ファイルは増やさず `app.js` 内の `initRealtime()` セクションに集約（ビルドなし構成を維持）。

### 検証

- 2ブラウザ（別アカウント）で、片方の送金操作により**もう片方がリロードなしで**トースト表示・残高更新されること。
- JWT 期限切れ後も自動で再接続すること。
- 他人のアドレスで RLS が通らないこと（購読しても自分の行以外来ないこと）。

### 工数: 1〜2 日（JWT 方式。ポーリングのみなら 0.5 日）

---

## 8. Phase 5: 経済圏・コミュニティ機能

### 8.1 エクスプローラー／統計ページ

- **新API `GET /api/stats`**（公開、レート制限付き）: 総流通量、登録アカウント数、本日の取引件数、GENESIS ボーナスプール残高、リクエスト/割り勘の稼働数。
  - 実装: `db.js` に `getStats()`。`transactions` は日次カウントが必要なので `count` + `timestamp >= 現在日付` のクエリ（Supabase の `gte`）。流通量・アカウント数は既存 `getCoinInfo` を流用（全件集計は現状同等なので許容、将来的に DB に集計ビュー `circulating_view` を作る選択肢を明記）。
- **UI**: SPA に `view-explorer` を追加（ダッシュボード下のフッターから遷移、または `?tab=explorer`）。項目はカード表示で既存 `style.css` の `card` を再利用。未ログインでも閲覧可（`showView` をログイン不要に拡張）。
- 数値のフォーマットは `toLocaleString()`、`GENESIS` 残高は「ボーナスプール枯渇率」をバーで表示（登録ボーナス設計と整合）。

### 8.2 招待チケット（リファラルシステム）

**現状**: 環境変数 `INVITE_CODE` の1種類のみで、誰が誰を招待したか管理できない。

**新規テーブル**:

```sql
CREATE TABLE public.invite_tickets (
  code varchar PRIMARY KEY,               -- 12桁ランダム（暗号学的乱数）
  issuer_address varchar NOT NULL,        -- 発行者
  status varchar NOT NULL DEFAULT 'unused', -- 'unused' | 'used' | 'revoked'
  used_by varchar, used_at timestamptz,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE public.referral_rewards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inviter_address varchar NOT NULL,
  invitee_address varchar NOT NULL,
  ticket_code varchar NOT NULL,
  inviter_bonus bigint NOT NULL,
  invitee_bonus bigint NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (ticket_code)
);
```

**仕様**:

- **登録時**: `/api/register` に `ticketCode` を追加。RPC `register_with_ticket(p_address, p_public_key, p_ticket, ...)` で ①チケット行を `FOR UPDATE` で unused 確認 → ②`used` に更新 → ③アカウント登録 + 登録ボーナス → ④発行者へ紹介ボーナス（GENESIS から、残高不足なら減額/0、既存 `registerAccount` の枯渇チェックを踏襲）を **1トランザクション**で実行。旧 `INVITE_CODE` は「マスターコード」として経過期間のみ併存（チケットなし登録の廃止は移行後）。
- **チケット発行**: 登録完了者に **初期3枚** を配布（`POST /api/tickets/issue`、署名必須、1アカウント累計上限を設定して無限発行を防止）。招待1件成立ごとに +1 枚。
- **報酬**: 招待された側 = 登録ボーナスに加えて紹介ボーナス（例: +50 KC）、招待した側 = +30 KC（`REFERRAL_BONUS_INVITER` / `_INVITEE` 環境変数、既定値は総供給から見て安全な値）。
- **UI**: ダッシュボードに「招待チケット」カード — 未使用チケット一覧（`?invite=<code>` リンク + QR + コピー）、自分が招待した人と獲得額の一覧（`GET /api/tickets/me`）。
- リンクの `?invite=` はPhase 0 で落地後に `replaceState` で消す（Phase 5 実装時に反映）。
- 検証: 同一チケットの2回使用が失敗すること、紹介者にのみ報酬が入ること、GENESIS 枯渇時のフォールバック。

### 工数: 2〜3 日

---

## 9. 環境変数の追加一覧（Vercel / Supabase 側で設定が必要）

| 変数 | 必須 | 用途 | 設定タイミング |
|---|---|---|---|
| `ADMIN_ADDRESS` | 必須 | `/api/admin/genesis` の呼び出し元固定 | Phase 0 |
| `SUPABASE_JWT_SECRET` | 推奨 | Realtime 用短命 JWT の発行（HS256） | Phase 4 |
| `REFERRAL_BONUS_INVITER` / `REFERRAL_BONUS_INVITEE` | 任意 | リファラル報酬額（既定 30 / 50 KC） | Phase 5 |
| `TICKETS_INITIAL_COUNT` / `TICKETS_MAX_PER_USER` | 任意 | 招待チケット初期枚数/上限 | Phase 5 |
| `AUTO_LOCK_MINUTES` | 任意 | 自動ロックの既定分数（5 分） | Phase 1 |

---

## 10. データモデル変更サマリー

| テーブル | 変更種別 | 内容 | Phase |
|---|---|---|---|
| `transactions` | 列追加 | `memo varchar(100)` | 2 |
| `payment_requests` | 列追加 | `paid_tx_id uuid`, `updated_at` | 3 |
| `split_bills` | 新規 | 割り勘定義 | 3 |
| `split_bill_payments` | 新規 | 支払記録（一意制約で二重防止） | 3 |
| `invite_tickets` | 新規 | 招待チケット | 5 |
| `referral_rewards` | 新規 | 紹介報酬台帳 | 5 |
| RPC `process_transfer` | 再定義 | `p_memo`, `p_request_id` 引数追加 + リクエスト自動 paid 化 | 2〜3 |
| RPC `register_account` | 再定義 | チケット消費+紹介報酬版 `register_with_ticket` を追加（既存版は過渡期併存） | 5 |
| RPC `pay_split_bill` | 新規 | 割り勘支払のアトミック処理 | 3 |
| Realtime publication + RLS | 設定 | `transactions` / `payment_requests` / `split_bills` / `split_bill_payments` | 4 |

---

## 11. テスト計画

現状 `npm test` は未設定。本計画に合わせて最小限の基盤を追加する:

1. **単体テスト（`node:test`、新規依存なし）**
   - `public/crypto.js` のロジックを Node の `node:crypto.webcrypto` で同一に検証: PBKDF2/AES-GCM 往復、誤パスワードでの復号失敗、BIP-39 12語/24語復元でのアドレス一致。
   - `server.js` の純関数: `verifySignature` / `addressFromPublicKey` / 新署名形式の検証。
2. **API テスト（`node:test` + `app.listen` + `db.js` をモック）**
   - 署名なし・不正署名の 403、旧形式署名の拒否、`ADMIN_ADDRESS` 違反の 403、requestId 紐づけ検証、チケット二重使用の拒否。
3. **手動 QA チェックリスト**: 各 Phase の「検証」節をそのまま採番。実機スマホ（QRカメラ・Realtime 通知・自動ロック）を含む。
4. **DB**: SQL を本番適用前に適用し、`check_supabase.js`（`check_db.js` の Supabase 版を新規作成）で制約・件数を確認。

---

## 12. リスクと対策

| リスク | 影響 | 対策 |
|---|---|---|
| 署名メッセージ形式変更（Phase 2）で旧ワンタイムリンク・旧送金URLが失効 | 中 | 短期リンクのみ影響。デプロイ時にトーストで告知。旧形式を拒否するサーバ側テストを追加し、曖昧な互換を持たない |
| パスワード忘れ | 高（資産利用不能） | ニーモニックバックアップの必須確認（3語確認）を強制。リカバリーコード（Base64 エクスポート）をパスワード設定時に一度だけ提示 |
| ブラウザの PBKDF2 600k 回による待機（低スペック端末で1〜2秒） | 低 | ローディング UI 表示。回数は環境変数で変更可（セキュリティと速度のトレードオフ） |
| XSS が残存していた場合、ロック解除中に鍵を盗まれる | 高 | Phase 0 のエスケープ + CSP を Phase 1 より前に必ずデプロイ（依存順序として固定） |
| Realtime の JWT secret が入手できない / RLS 設定ミスで他人の着金が見える | 中 | ポーリング・フォールバックを用意。RLS は「他人アカウントで購読して他人の行が来ない」テストを必須とする |
| GENESIS 枯渇後のリファラル報酬 | 低 | 既存 `registerAccount` と同じ枯渇チェックを RPC 内で行い、不足時は報酬0で登録は通す |
| `getCoinInfo` の全アカウント集計が成長に伴い遅化 | 低 | Explorer 実装時に集計ビュー/キャッシュを検討（計画には選択肢として記載） |
| nonce の同時送信競合 | 中 | 送金失敗時に nonce を再取得して1回だけ自動リトライ（Phase 2 で実装） |

---

## 13. マイルストーンと推奨順序

| 週 | 実施 | デプロイ単位 |
|---|---|---|
| 1週目 | Phase 0（XSS/genesis/CSP） → Phase 1（キーストア/ニーモニック/ロック） | 個別デプロイ。Phase 1 は移行フロー込みで QA 必须 |
| 2週目 | Phase 2 + Phase 3（署名形式・DB 変更を同時適用） | **同一デプロイで**。SQL → サーバ → フロントの順で適用 |
| 3週目 | Phase 4（Realtime）→ Phase 5（Explorer/招待チケット） | 個別デプロイ。Phase 5 は Phase 4 非依存で並行着手可 |

**全体の完了条件**:

1. localStorage に平文の秘密鍵が存在しない（旧ユーザーも移行済み）。
2. XSS ペイロード（ニックネーム/メモ）が描画上無害であることをテストで確認。
3. 送金は確認モーダル経由のみで、メモ付き・請求紐付け・自動消込が動作する。
4. 割り勘リンクが QR から開き、達成率がリアルタイムに更新される。
5. 着金・リクエストがリロードなしでトースト通知される。
6. Explorer と招待チケットが動作し、報酬が GENESIS から正しく出る。
7. `npm test` が上記単体/API テストで通る。

---

*本計画は上記順序での実施を前提とする。Phase 単位で着手・検収を繰り返すことを推奨する。*


