/* github.js — GitHub REST API 層 と 端末ローカル設定の保存。
 *
 * v1 はバックエンドを持たず、クライアントから直接 GitHub API を叩く。
 * PAT（fine-grained, 対象1リポジトリ・Contents R/W）は localStorage に保存し、
 * シェルにも repo にも絶対にコミットしない。
 *
 * フェーズ1ではこのモジュールに「設定の保存」と「接続テスト」を実装する。
 * Trees/Blob/Contents 取得・コミットは後続フェーズでメソッドを追加していく。
 */
'use strict';

const API_BASE = 'https://api.github.com';

const TOKEN_KEY = 'wardrobe.pat';
const CONFIG_KEY = 'wardrobe.config';

const DEFAULT_CONFIG = Object.freeze({
  owner: 'hirotoyoshimi',
  repo: 'wardrobe',
  branch: 'main',
});

/** 端末ローカルの設定／トークン管理。 */
const Settings = {
  loadConfig() {
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      if (!raw) return { ...DEFAULT_CONFIG };
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_CONFIG, ...parsed };
    } catch (_e) {
      return { ...DEFAULT_CONFIG };
    }
  },
  saveConfig(cfg) {
    const clean = {
      owner: (cfg.owner || '').trim(),
      repo: (cfg.repo || '').trim(),
      branch: (cfg.branch || '').trim() || 'main',
    };
    localStorage.setItem(CONFIG_KEY, JSON.stringify(clean));
    return clean;
  },
  loadToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
  },
  saveToken(token) {
    if (token) localStorage.setItem(TOKEN_KEY, token.trim());
  },
  clearToken() {
    localStorage.removeItem(TOKEN_KEY);
  },
  hasToken() {
    return !!localStorage.getItem(TOKEN_KEY);
  },
};

/** GitHub API クライアント。 */
class GitHub {
  constructor(token, config) {
    this.token = token || Settings.loadToken();
    this.config = config || Settings.loadConfig();
  }

  get owner() { return this.config.owner; }
  get repo() { return this.config.repo; }
  get branch() { return this.config.branch; }

  /** 認証ヘッダ付きで API を叩く。失敗時は status を持つ Error を投げる。 */
  async request(path, opts = {}) {
    const url = path.startsWith('http') ? path : API_BASE + path;
    const headers = Object.assign(
      {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      opts.headers || {}
    );
    if (this.token) headers.Authorization = `Bearer ${this.token}`;

    const res = await fetch(url, { ...opts, headers });
    // レート情報を記録（成功・失敗どちらでも）
    const rem = res.headers.get('x-ratelimit-remaining');
    const rst = res.headers.get('x-ratelimit-reset');
    if (rem != null) this.rate = { remaining: Number(rem), reset: rst ? Number(rst) : null };
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).message || ''; } catch (_e) { /* noop */ }
      const err = new Error(detail || `${res.status} ${res.statusText}`);
      err.status = res.status;
      err.rateRemaining = rem;
      err.rateReset = rst ? Number(rst) : null;
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  /**
   * 接続テスト: リポジトリにアクセスでき、対象ブランチが存在し、
   * Contents 書き込み権限があるかを確認する。
   * @returns {Promise<{login?:string, repo:string, branch:string, canWrite:boolean, defaultBranch:string}>}
   */
  async testConnection() {
    if (!this.token) {
      const e = new Error('トークンが未設定です');
      e.status = 0;
      throw e;
    }

    // ログイン名（fine-grained PAT では取得できない場合があるので失敗は無視）
    let login;
    try {
      login = (await this.request('/user')).login;
    } catch (_e) {
      login = undefined;
    }

    // リポジトリ存在＋権限
    let repo;
    try {
      repo = await this.request(`/repos/${this.owner}/${this.repo}`);
    } catch (e) {
      if (e.status === 404) {
        e.message = `リポジトリ ${this.owner}/${this.repo} が見つかりません（PATのリポジトリ指定/権限を確認）`;
      } else if (e.status === 401) {
        e.message = 'トークンが無効です（401）';
      }
      throw e;
    }

    // 対象ブランチの存在確認
    try {
      await this.request(`/repos/${this.owner}/${this.repo}/branches/${encodeURIComponent(this.branch)}`);
    } catch (e) {
      if (e.status === 404) {
        e.message = `ブランチ "${this.branch}" が見つかりません（既定ブランチは "${repo.default_branch}"）`;
      }
      throw e;
    }

    const perms = repo.permissions || {};
    return {
      login,
      repo: repo.full_name,
      branch: this.branch,
      defaultBranch: repo.default_branch,
      canWrite: !!(perms.push || perms.admin || perms.maintain),
    };
  }

  /**
   * 対象ブランチの再帰ツリーを取得し、指定 prefix 配下の blob 一覧（path/sha/size）を返す。
   * 1リクエストで items/*.yaml 全件分の blob SHA が得られる。
   * @param {string} prefix 例: "items/"
   * @param {string} [ext]  例: ".yaml"（拡張子フィルタ）
   */
  async listTree(prefix, ext) {
    const tree = await this.request(
      `/repos/${this.owner}/${this.repo}/git/trees/${encodeURIComponent(this.branch)}?recursive=1`
    );
    if (tree.truncated) {
      console.warn('git tree が truncated。アイテム数が多い場合は分割取得が必要。');
    }
    return (tree.tree || []).filter(
      (e) => e.type === 'blob' && e.path.startsWith(prefix) && (!ext || e.path.endsWith(ext))
    );
  }

  /** blob SHA から内容を取得（base64 → UTF-8 文字列にデコード）。 */
  async getBlobText(sha) {
    const blob = await this.request(`/repos/${this.owner}/${this.repo}/git/blobs/${sha}`);
    if (blob.encoding === 'base64') return decodeBase64Utf8(blob.content);
    return blob.content; // 既に utf-8 の場合
  }

  /** blob SHA からバイナリ（画像など）を取得。raw メディアタイプで直接バイト列を得る。 */
  async getBlobBytes(sha) {
    const url = `${API_BASE}/repos/${this.owner}/${this.repo}/git/blobs/${sha}`;
    const res = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github.raw',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${this.token}`,
      },
    });
    if (!res.ok) {
      const err = new Error(`blob 取得失敗: ${res.status}`);
      err.status = res.status;
      throw err;
    }
    // raw が効かない場合のフォールバック（JSON+base64）
    const ctype = res.headers.get('content-type') || '';
    if (ctype.includes('application/json')) {
      const json = await res.json();
      return base64ToBytes(json.content || '');
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * Contents API でファイルを作成/更新（= 即コミット）。
   * @param {string} path リポジトリ内パス（例: items/foo.yaml）
   * @param {{message:string, text?:string, bytes?:Uint8Array, sha?:string}} opts
   *   text（UTF-8文字列）か bytes のどちらかを渡す。sha は更新時に必須（新規は省略）。
   * @returns {Promise<object>} PUT レスポンス（content.sha などを含む）
   */
  async putContents(path, opts) {
    const content = opts.bytes != null
      ? bytesToBase64(opts.bytes)
      : encodeBase64Utf8(opts.text || '');
    const body = {
      message: opts.message,
      content,
      branch: this.branch,
    };
    if (opts.sha) body.sha = opts.sha;
    return this.request(`/repos/${this.owner}/${this.repo}/contents/${encodePath(path)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
}

/** パスの各セグメントを encodeURIComponent（スラッシュは保持）。 */
function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** base64（改行入り可）→ Uint8Array。 */
function base64ToBytes(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** GitHub blob の base64 → UTF-8 文字列。 */
function decodeBase64Utf8(b64) {
  return new TextDecoder('utf-8').decode(base64ToBytes(b64));
}

/** Uint8Array → base64 文字列。 */
function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000; // 大きな配列で apply の引数上限を超えないよう分割
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** UTF-8 文字列 → base64。 */
function encodeBase64Utf8(text) {
  return bytesToBase64(new TextEncoder().encode(text));
}

// グローバル公開（モジュールバンドラなしの素の <script> 構成）
window.Settings = Settings;
window.GitHub = GitHub;
