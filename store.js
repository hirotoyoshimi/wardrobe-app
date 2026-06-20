/* store.js — items/images のロード（GitHub Trees + Blob）と IndexedDB(SHAキー)キャッシュ。
 *
 * 起動時に 1 リクエストでツリー（path + blob SHA）を取得し、
 * キャッシュと SHA を突き合わせて **変わった blob だけ** 取得・parse する。
 * 初回のみ最大103取得（並列＋上限）、以降は差分のみで高速・省レート。
 * 画像は遅延ロード（カードが見えたときに認証付き blob 取得 → IndexedDB キャッシュ）。
 *
 * データやトークンは Service Worker キャッシュには載せない（IndexedDB のみ）。
 */
'use strict';

const DB_NAME = 'wardrobe';
const DB_VERSION = 5;
const ITEMS_STORE = 'items';   // key: path,  value: { path, sha, item }
const IMAGES_STORE = 'images'; // key: sha,   value: { sha, blob }  (縮小サムネ)
const META_STORE = 'meta';     // key: key,   value: { key, value }  (SHAマップ等)
const DOCS_STORE = 'docs';     // key: path,  value: { path, sha, text } (Markdown)

const ITEMS_PREFIX = 'items/';
const ITEMS_EXT = '.yaml';
const IMAGES_PREFIX = 'images/';
const FETCH_CONCURRENCY = 12;
const THUMB_MAX = 600; // サムネ長辺(px)。カード/モーダル兼用

// ドキュメントとして表示する Markdown: 直下の *.md と reports/*.md
function isDocPath(path) {
  if (!path.endsWith('.md')) return false;
  if (!path.includes('/')) return true;          // ルート直下（budget.md / wishlist.md）
  return path.startsWith('reports/');             // Claude生成レポート
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldV = event.oldVersion;
      if (!db.objectStoreNames.contains(ITEMS_STORE)) {
        db.createObjectStore(ITEMS_STORE, { keyPath: 'path' });
      }
      // v3: 旧バージョン(v2以前)の原寸画像キャッシュ(最大291MB)は作り直して破棄。
      // 以降のバージョン上げではサムネを保持する（再ダウンロードを避ける）。
      if (oldV < 3 && db.objectStoreNames.contains(IMAGES_STORE)) db.deleteObjectStore(IMAGES_STORE);
      if (!db.objectStoreNames.contains(IMAGES_STORE)) {
        db.createObjectStore(IMAGES_STORE, { keyPath: 'sha' });
      }
      // v4: オフライン表示用に SHA マップ等を保存するメタストア
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' });
      }
      // v5: Markdown ドキュメントのキャッシュ
      if (!db.objectStoreNames.contains(DOCS_STORE)) {
        db.createObjectStore(DOCS_STORE, { keyPath: 'path' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbReq(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const os = db.transaction(store, mode).objectStore(store);
    const req = fn(os);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 並列度を制限して非同期タスクを実行。 */
async function runPooled(tasks, concurrency, onEach) {
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const idx = i++;
      await tasks[idx]();
      if (onEach) onEach(idx + 1, tasks.length);
    }
  }
  const workers = [];
  for (let k = 0; k < Math.min(concurrency, tasks.length); k++) workers.push(worker());
  await Promise.all(workers);
}

// メモリ内 objectURL キャッシュ（sha → URL）。再描画での重複生成を防ぐ。
const objectUrlBySha = new Map();

const Store = {
  // 直近ロード時のツリーから得た SHA マップ（編集・画像・ドキュメントで参照）
  itemShas: new Map(),   // path -> sha
  imageShas: new Map(),  // path -> sha
  docShas: new Map(),    // path -> sha (Markdown)

  /**
   * items を読み込む。SHA キャッシュを使い差分のみフェッチ。
   * @param {GitHub} gh
   * @param {(phase:string, done:number, total:number)=>void} [onProgress]
   * @returns {Promise<{items:object[], fromCache:number, fetched:number, removed:number}>}
   */
  async loadItems(gh, onProgress) {
    const db = await openDb();

    if (onProgress) onProgress('tree', 0, 0);
    const tree = await gh.listTree('', ''); // 全 blob を1リクエスト
    const itemEntries = tree.filter((e) => e.path.startsWith(ITEMS_PREFIX) && e.path.endsWith(ITEMS_EXT));

    // SHA マップを更新
    this.itemShas = new Map(itemEntries.map((e) => [e.path, e.sha]));
    this.imageShas = new Map(
      tree.filter((e) => e.path.startsWith(IMAGES_PREFIX)).map((e) => [e.path, e.sha])
    );
    this.docShas = new Map(
      tree.filter((e) => e.type === 'blob' && isDocPath(e.path)).map((e) => [e.path, e.sha])
    );

    const treeByPath = new Map(itemEntries.map((e) => [e.path, e]));

    // キャッシュ読み込み
    const cached = await idbReq(db, ITEMS_STORE, 'readonly', (os) => os.getAll()) || [];
    const cacheByPath = new Map(cached.map((r) => [r.path, r]));

    // ツリーから消えたものはキャッシュからも削除
    let removed = 0;
    for (const r of cached) {
      if (!treeByPath.has(r.path)) {
        await idbReq(db, ITEMS_STORE, 'readwrite', (os) => os.delete(r.path));
        removed++;
      }
    }

    const results = new Map(); // path -> item
    let fromCache = 0;
    for (const e of itemEntries) {
      const c = cacheByPath.get(e.path);
      if (c && c.sha === e.sha) { results.set(e.path, c.item); fromCache++; }
    }

    const toFetch = itemEntries.filter((e) => {
      const c = cacheByPath.get(e.path);
      return !c || c.sha !== e.sha;
    });

    let fetched = 0;
    if (onProgress) onProgress('blobs', 0, toFetch.length);
    const tasks = toFetch.map((e) => async () => {
      const text = await gh.getBlobText(e.sha);
      let item;
      try { item = jsyaml.load(text); }
      catch (err) { console.warn('YAML parse 失敗:', e.path, err); return; }
      await idbReq(db, ITEMS_STORE, 'readwrite', (os) => os.put({ path: e.path, sha: e.sha, item }));
      results.set(e.path, item);
    });
    await runPooled(tasks, FETCH_CONCURRENCY, (done) => {
      fetched = done;
      if (onProgress) onProgress('blobs', done, toFetch.length);
    });

    // オフライン表示用に SHA マップを保存
    await idbReq(db, META_STORE, 'readwrite', (os) => os.put({ key: 'itemShas', value: [...this.itemShas] }));
    await idbReq(db, META_STORE, 'readwrite', (os) => os.put({ key: 'imageShas', value: [...this.imageShas] }));
    await idbReq(db, META_STORE, 'readwrite', (os) => os.put({ key: 'docShas', value: [...this.docShas] }));

    db.close();

    const items = itemEntries.map((e) => results.get(e.path)).filter(Boolean);
    return { items, fromCache, fetched, removed };
  },

  /** ネットワークを使わず IndexedDB のキャッシュのみから items を読む（オフライン表示用）。 */
  async loadCached() {
    const db = await openDb();
    const cached = await idbReq(db, ITEMS_STORE, 'readonly', (os) => os.getAll()) || [];
    const itemMeta = await idbReq(db, META_STORE, 'readonly', (os) => os.get('itemShas'));
    const imgMeta = await idbReq(db, META_STORE, 'readonly', (os) => os.get('imageShas'));
    const docMeta = await idbReq(db, META_STORE, 'readonly', (os) => os.get('docShas'));
    db.close();
    this.itemShas = new Map(itemMeta ? itemMeta.value : []);
    this.imageShas = new Map(imgMeta ? imgMeta.value : []);
    this.docShas = new Map(docMeta ? docMeta.value : []);
    cached.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { items: cached.map((r) => r.item) };
  },

  /** items/<id>.yaml の最新 blob sha（ツリー取得時の値）。 */
  itemSha(id) {
    return this.itemShas.get(`${ITEMS_PREFIX}${id}${ITEMS_EXT}`);
  },

  /** 編集コミット後にキャッシュと SHA マップを更新。 */
  async updateItemCache(path, sha, item) {
    this.itemShas.set(path, sha);
    const db = await openDb();
    await idbReq(db, ITEMS_STORE, 'readwrite', (os) => os.put({ path, sha, item }));
    db.close();
  },

  /**
   * 画像パス（source_image, 例 images/foo.jpg）の objectURL を返す。
   * メモリ → IndexedDB(縮小サムネ) → 認証付き blob 取得→縮小 の順。画像が無ければ null。
   * 原寸(3〜6MB)はダウンロード後すぐ長辺600pxへ縮小し、サムネだけを永続化する。
   */
  async imageUrl(gh, path) {
    if (!path) return null;
    const sha = this.imageShas.get(path);
    if (!sha) return null; // ツリーに存在しない
    if (objectUrlBySha.has(sha)) return objectUrlBySha.get(sha);

    const db = await openDb();
    let rec = await idbReq(db, IMAGES_STORE, 'readonly', (os) => os.get(sha));
    if (!rec) {
      const bytes = await gh.getBlobBytes(sha);
      const blob = await makeThumb(bytes, mimeForPath(path));
      await idbReq(db, IMAGES_STORE, 'readwrite', (os) => os.put({ sha, blob }));
      rec = { sha, blob };
    }
    db.close();
    const url = URL.createObjectURL(rec.blob);
    objectUrlBySha.set(sha, url);
    return url;
  },

  /** 新規追加時など、手元の画像 Blob からサムネを作って sha キーでキャッシュ（再取得を回避）。 */
  async putThumb(sha, srcBlob) {
    if (!sha || !srcBlob) return;
    const bytes = new Uint8Array(await srcBlob.arrayBuffer());
    const thumb = await makeThumb(bytes, srcBlob.type || 'image/jpeg');
    const db = await openDb();
    await idbReq(db, IMAGES_STORE, 'readwrite', (os) => os.put({ sha, blob: thumb }));
    db.close();
    if (objectUrlBySha.has(sha)) { URL.revokeObjectURL(objectUrlBySha.get(sha)); objectUrlBySha.delete(sha); }
  },

  /** 表示対象 Markdown のパス一覧（昇順）。 */
  docList() {
    return [...this.docShas.keys()].sort();
  },

  /**
   * Markdown ドキュメント本文を返す。IndexedDB(docs) を SHA で突き合わせ、変わっていれば取得。
   * オフライン時はキャッシュがあればそれを返す。
   */
  async docText(gh, path) {
    const sha = this.docShas.get(path);
    const db = await openDb();
    let rec = await idbReq(db, DOCS_STORE, 'readonly', (os) => os.get(path));
    if (rec && rec.sha === sha) { db.close(); return rec.text; }
    if (!navigator.onLine) { db.close(); if (rec) return rec.text; throw new Error('オフライン: 未取得のドキュメントです'); }
    if (!sha) { db.close(); throw new Error('ドキュメントが見つかりません'); }
    const text = await gh.getBlobText(sha);
    await idbReq(db, DOCS_STORE, 'readwrite', (os) => os.put({ path, sha, text }));
    db.close();
    return text;
  },
};

function mimeForPath(path) {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  return ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.webp': 'image/webp', '.gif': 'image/gif' }[ext]) || 'application/octet-stream';
}

/** 原寸バイト列 → 長辺 THUMB_MAX の JPEG サムネ Blob（縮小不要/失敗時は原本のまま）。 */
async function makeThumb(bytes, mime) {
  const srcBlob = new Blob([bytes], { type: mime });
  let bmp;
  try {
    bmp = await createImageBitmap(srcBlob);
  } catch (_e) {
    return srcBlob; // デコード不可（HEIC 非対応環境など）はそのまま
  }
  const scale = Math.min(1, THUMB_MAX / Math.max(bmp.width, bmp.height));
  if (scale >= 1) { if (bmp.close) bmp.close(); return srcBlob; } // 既に十分小さい
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.82));
  return blob || srcBlob;
}

window.Store = Store;
