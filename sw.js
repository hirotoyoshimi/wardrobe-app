/* Service Worker — アプリシェル（HTML/JS/CSS/アイコン）のみをプリキャッシュ。
 *
 * 重要: private データ（items/*.yaml・画像）や PAT は **絶対にキャッシュしない**。
 * それらは GitHub API から実行時に取得し、データは IndexedDB（後続フェーズ）、
 * トークンは localStorage に置く。SW のキャッシュ対象はあくまで公開シェルのみ。
 */
const CACHE = 'wardrobe-shell-v13';

// シェルを構成する静的ファイル（同一オリジン・公開リソースのみ）
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './github.js',
  './store.js',
  './tone.js',
  './patch.js',
  './vendor/js-yaml.min.js',
  './vendor/marked.min.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // GET のみ扱う。それ以外（PUT 等の API 書き込み）は素通し。
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 別オリジン（api.github.com / raw 等）はキャッシュせずネットワーク直行。
  // → private データやトークン付きリクエストが SW キャッシュに残らないようにする。
  if (url.origin !== self.location.origin) return;

  // 同一オリジンのシェル資産は network-first（オンライン時は常に最新を取得し、
  // 取得できたらキャッシュ更新。オフライン時のみキャッシュにフォールバック）。
  // → デプロイ後の更新が確実に反映され、PWA のキャッシュ貼り付き問題を防ぐ。
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((cached) => {
          if (cached) return cached;
          if (req.mode === 'navigate') return caches.match('./index.html');
          throw new Error('offline and not cached');
        })
      )
  );
});
