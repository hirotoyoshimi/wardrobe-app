# Wardrobe PWA（v1）

`items/*.yaml` を iPhone から閲覧・編集・追加するためのインストール可能な PWA。
バックエンドは持たず、端末に保存した **fine-grained PAT** で GitHub REST API を直接叩く。
設計の全体像は [`../docs/pwa_plan.md`](../docs/pwa_plan.md) を参照。

## 現状（フェーズ1–4 完了）

- [x] アプリシェル（`index.html` / `app.js` / `github.js` / `styles.css`）
- [x] PWA manifest（`manifest.webmanifest`）＋アイコン一式（`icons/`）
- [x] Service Worker（`sw.js`）— **公開シェルのみ**をプリキャッシュ。private データ・トークンはキャッシュしない
- [x] 設定画面（PAT / owner / repo / branch を localStorage に保存）＋接続テスト
- [x] **フェーズ2**: Trees+Blob+IndexedDB(SHA) ロード（`store.js`）、js-yaml parse、JSトーン算出（`tone.js`）、一覧/カード/検索/フィルタ/ソート
- [x] **フェーズ3**: 認証付き画像 blob 取得 → **クライアントで長辺600pxへ縮小** → IndexedDB(SHA) に
  サムネのみキャッシュ（原寸 約291MB → 約5MB）。`URL.createObjectURL`、IntersectionObserver で遅延ロード、
  画像 null はプレースホルダ。モーダルも同サムネを再利用（開くたびの再取得なし）
- [x] **フェーズ4**: 編集モーダル＋JS `apply_patch`（`patch.js`）＋js-yaml dump＋Contents PUT（保存＝即コミット）、sha 競合(409)処理
- [x] **フェーズ5**: ＋ボタン→カメラ/写真選択→長辺1600pxへ縮小→`images/<id>.jpg` コミット→
  `items/<id>.yaml` スケルトン（`Patch.newSkeleton`）コミット。色は空＝トーン「実測なし」で、
  後でローカル `extract_colors.py` が確定（UIに明示）。ID は半角・一意・`id==ファイル名` を検証
- [x] **フェーズ6**: オフライン表示（IndexedDB キャッシュから前回データを閲覧＋バナー、
  編集/追加/再読込はオンライン時のみ）、iOS「ホーム画面に追加」導線、空状態、
  API レート残量/回復時刻の表示、復帰時の自動同期

### 仕上げ（フェーズ6）
- **オフライン**: `navigator.onLine` と online/offline イベントで検知。オフライン時は
  `Store.loadCached()`（meta ストアに保存した SHA マップ＋IndexedDB）から表示。バナーで明示し、
  編集・追加・接続テストはガード。オンライン復帰で自動的に最新へ同期。
- **ホーム追加導線**: iOS Safari かつ未インストール時のみ「共有→ホーム画面に追加」を1回案内（×で記憶）。
- **レート**: 残量が少ないと一覧ステータスに警告、429/403 時は回復時刻を表示。
- 検索結果0件は空状態を表示。

### ドキュメント表示
ヘッダの 📄 から、直下の `budget.md` / `wishlist.md` と `reports/*.md`（Claude生成レポート）を
アプリ内で Markdown 表示（`marked`、GFMテーブル対応）。SHA でキャッシュしオフラインでも閲覧可。
表示対象は `store.js` の `isDocPath`（直下 `*.md` ＋ `reports/*.md`）で決定。

### 新規追加（フェーズ5）
1. `<input type="file" accept="image/*">` で撮影/選択（iOS はカメラ/ライブラリ選択メニュー）。
2. `createImageBitmap`（iOS Safari は HEIC もネイティブ復号）→ canvas で長辺1600pxへ縮小→JPEG。
3. ID を `validate_items.py` 規則（半角 `^[A-Za-z0-9][A-Za-z0-9_]*$`・一意・`id==ファイル名`）で検証。
4. `images/<id>.jpg` を先にコミット（`source_image` 実在を満たす）→ `items/<id>.yaml` スケルトン。
5. スケルトンは必須キー・`color_family/season/scene` リスト・`primary_flag` bool を満たし、
   `color_measured` は空（`confidence/extracted:null, clusters:[]`）。トーンは「実測なし」。

### データフロー
1. `GET /git/trees/{branch}?recursive=1` で全 blob の path + SHA を1リクエスト取得。
2. IndexedDB（`wardrobe` DB / `items`(key=path) / `images`(key=sha)）の SHA と突き合わせ、
   **変わった blob だけ** 取得（並列8）→ js-yaml で parse → キャッシュ。画像は遅延ロード。
3. トーンは `tone.js`（`dominant_lch`/`tone_group` 移植・閾値は `data/style_lineage.yaml` と一致）。
   全103件で Python 実装とトーングループ完全一致を検証済み。
4. 検索・カテゴリ/未入力フィルタ・ソートはすべてクライアント側。

### 編集・コミット
- カード/行タップで編集モーダル。人間管理フィールドのみ編集可、`facts.color_measured`/`position`/
  `ai_assessment` は **読み取り専用＋保全**（`patch.js` の `applyPatch`。Python `apply_patch` と
  全フィールド一致を検証済み）。
- 保存時: キャッシュのフル YAML に `applyPatch` → js-yaml で dump（`noArrayIndent`/単一引用符/`lineWidth:-1`、
  PyYAML 体裁に近似）→ base64 → `PUT /contents/items/<id>.yaml`（message/content/sha/branch）。
- **保存＝即コミット**。差分は `items/<id>.yaml` のみ・自動管理セクションは値が不変
  （js-yaml は整数 float の末尾 `.0` だけ正規化＝数値同一。色実測は後でローカル `extract_colors.py` が再生成）。
- sha 競合（409）は「再読み込みして再編集」を促す。成功時はレスポンスの新 sha でキャッシュ更新。

アプリは既定で **`hirotoyoshimi/wardrobe` の `main` ブランチ**を読み書き対象にする
（設定画面で変更可能）。

## ローカル動作確認

任意の静的サーバで配信して開くだけ（ビルド不要）:

```bash
cd wardrobe-app
python3 -m http.server 8080
# → http://localhost:8080/ を開く
```

Service Worker は `https` か `localhost` でのみ有効。

## ホスティング（GitHub Pages）

このディレクトリは **公開リポジトリ用シェル**（データを一切含まない）として設計している。
private リポジトリからの Pages 公開は GitHub Pro 限定のため、配信は別の**公開リポジトリ**で行う:

1. 公開リポジトリ（例 `wardrobe-app`）を作成。
2. この `wardrobe-app/` 配下のファイルをそのリポジトリのルートに配置。
3. Settings → Pages で `main` ブランチ（ルート）から公開を有効化。
4. iOS Safari で公開 URL を開き「ホーム画面に追加」。

> シェルにはデータもトークンも含まれないため、公開リポジトリに置いても情報は漏れない
> （データは各端末の PAT で private `wardrobe` から実行時取得する）。

### 自動デプロイ（推奨）

`.github/workflows/deploy-pwa.yml`（`wardrobe` リポジトリ側）が、`wardrobe-app/` の更新を
公開 `wardrobe-app` リポジトリの `main` へ自動 push する。手動コピーは不要。

一度きりの準備:
1. fine-grained PAT を発行（Repository access: `hirotoyoshimi/wardrobe-app` のみ /
   Permissions → Contents: Read and write）。
2. `wardrobe` リポジトリの Settings → Secrets and variables → Actions →
   New repository secret に登録（Name: `WARDROBE_APP_DEPLOY_TOKEN`）。

以降は `wardrobe-app/` を変更して push するたびに自動デプロイ。Actions タブから手動実行
（Run workflow）も可能。Secret 未設定の間はジョブはスキップ（緑）して何もしない。

### 手動デプロイ（Secret を使わない場合）

`wardrobe` リポジトリのフォルダ内で、`wardrobe-app/` だけを公開リポジトリへ送る:

```bash
git subtree split --prefix=wardrobe-app -b deploy-tmp
git push -f https://github.com/hirotoyoshimi/wardrobe-app.git deploy-tmp:main
git branch -D deploy-tmp
```

## アイコンの再生成

```bash
python3 scripts/gen_icons.py   # 要 Pillow
```

## セキュリティ

- PAT は **対象1リポジトリのみ / Contents: Read and write** の最小権限で発行する。
- トークン・設定は端末の `localStorage` にのみ保存。**シェルにも repo にも絶対にコミットしない。**
- 設定画面の「トークン削除」で端末から削除。GitHub 側の失効は token の `Revoke` で行う。
