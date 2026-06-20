/* app.js — シェルの初期化・設定画面・一覧（カード/リスト/検索/フィルタ/ソート）・SW 登録。
 *
 * フェーズ1: 設定（PAT/owner/repo/branch）保存・接続テスト・SW。
 * フェーズ2: Trees+Blob+IndexedDB ロード、js-yaml parse、JSトーン算出、一覧表示。
 *   （画像はフェーズ3、編集/追加はフェーズ4以降）
 */
'use strict';

const $ = (sel) => document.querySelector(sel);

const els = {};

// 一覧の状態
let ITEMS = [];        // parse 済みフル YAML（編集フェーズで再利用）
let SUMMARIES = [];    // 一覧用サマリ（Tone.listSummary）
let CATS = [];         // カテゴリ選択肢
let view = 'card';
let sortK = 'category';
let sortAsc = true;
let missOnly = false;  // 「未入力のみ」フィルタ
let loaded = false;
let loading = false;
let GH = null;         // 共有 GitHub クライアント（ロード時に更新）
let editingId = null;  // 編集中アイテム id
let newImageBlob = null; // 新規追加で選択・縮小済みの画像（JPEG Blob）
let editImageBlob = null; // 既存アイテムの画像差し替え用（選択・縮小済み JPEG）

// 取得手段（purchase.acquisition）の選択肢。price=0 の曖昧さを排すための区分。
const ACQUISITION_TYPES = ['購入', 'プレゼント', '相続・譲渡'];

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function cacheEls() {
  els.viewMain = $('#view-main');
  els.viewSettings = $('#view-settings');
  els.btnSettings = $('#btn-settings');
  els.btnNew = $('#btn-new');
  els.newSave = $('#new-save');
  els.btnBack = $('#btn-back');
  els.token = $('#f-token');
  els.owner = $('#f-owner');
  els.repo = $('#f-repo');
  els.branch = $('#f-branch');
  els.btnTest = $('#btn-test');
  els.btnSave = $('#btn-save');
  els.btnClear = $('#btn-clear');
  els.status = $('#settings-status');
  // 一覧
  els.mainEmpty = $('#main-empty');
  els.browser = $('#browser');
  els.q = $('#q');
  els.catf = $('#catf');
  els.missf = $('#missf');
  els.vCard = $('#vCard');
  els.vList = $('#vList');
  els.btnReload = $('#btn-reload');
  els.stat = $('#stat');
  els.loadStatus = $('#load-status');
  els.cards = $('#cards');
  els.emptyResults = $('#empty-results');
  els.netBanner = $('#net-banner');
  els.tbl = $('#tbl');
  els.tblWrap = $('#tbl-wrap');
  els.tbody = $('#tbl tbody');
}

/* ---------- ユーティリティ ---------- */
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}
const fmtYen = (v) => (v == null || v === '') ? '' : '¥' + Number(v).toLocaleString();
const asList = (v) => (Array.isArray(v) ? v.join(', ') : (v || ''));
const catRank = (c) => { const i = CATS.indexOf(c); return i < 0 ? CATS.length : i; };

/* ---------- ビュー切替 ---------- */
function showView(name) {
  els.viewMain.classList.toggle('on', name === 'main');
  els.viewSettings.classList.toggle('on', name === 'settings');
  window.scrollTo(0, 0);
}

function showBrowser(on) {
  els.browser.hidden = !on;
  els.mainEmpty.hidden = on;
}

/* ---------- 設定画面 ---------- */
function loadSettingsIntoForm() {
  const cfg = Settings.loadConfig();
  els.owner.value = cfg.owner;
  els.repo.value = cfg.repo;
  els.branch.value = cfg.branch;
  els.token.value = '';
  els.token.placeholder = Settings.hasToken() ? '保存済み（変更する場合のみ入力）' : 'github_pat_…';
}

function setStatus(kind, html) {
  els.status.className = `status ${kind}`;
  els.status.innerHTML = html;
}

function currentFormConfig() {
  return { owner: els.owner.value, repo: els.repo.value, branch: els.branch.value };
}

function persist() {
  const cfg = Settings.saveConfig(currentFormConfig());
  const t = els.token.value.trim();
  if (t) Settings.saveToken(t);
  return cfg;
}

async function onTest() {
  persist();
  loadSettingsIntoForm();
  if (!Settings.hasToken()) {
    setStatus('err', 'トークンを入力してください。');
    return;
  }
  if (!navigator.onLine) {
    setStatus('err', 'オフラインです。オンラインで接続テストしてください。');
    return;
  }
  setStatus('busy', '接続を確認中…');
  els.btnTest.disabled = true;
  try {
    const gh = new GitHub();
    const r = await gh.testConnection();
    const who = r.login ? `（${escapeHtml(r.login)}）` : '';
    const write = r.canWrite
      ? '<strong>書込可</strong>'
      : '<strong>読取のみ</strong>（編集・追加には Contents Write 権限が必要）';
    setStatus(
      'ok',
      `接続成功 ${who}<br>リポジトリ <code>${escapeHtml(r.repo)}</code> / ブランチ <code>${escapeHtml(r.branch)}</code> / ${write}`
    );
  } catch (e) {
    const rate = e.rateRemaining === '0' ? '（レート上限。しばらく待って再試行）' : '';
    setStatus('err', `接続失敗: ${escapeHtml(e.message)} ${rate}`);
  } finally {
    els.btnTest.disabled = false;
  }
}

function onSave() {
  const before = Settings.loadConfig();
  persist();
  const after = Settings.loadConfig();
  loadSettingsIntoForm();
  setStatus('ok', '保存しました。');
  // owner/repo/branch が変わったらキャッシュは別物なので再読込
  const cfgChanged = before.owner !== after.owner || before.repo !== after.repo || before.branch !== after.branch;
  if (cfgChanged) loaded = false;
}

function onClear() {
  if (!confirm('保存したトークンを端末から削除します。よろしいですか？')) return;
  Settings.clearToken();
  loadSettingsIntoForm();
  loaded = false;
  ITEMS = []; SUMMARIES = [];
  setStatus('ok', 'トークンを削除しました。GitHub 側でも失効させたい場合は Settings → Developer settings → Personal access tokens から revoke してください。');
}

/* ---------- 一覧ロード ---------- */
function buildCategoryOptions() {
  // 表示順は Tone.CAT_ORDER、実データにある未知カテゴリは末尾に追加
  const present = new Set(SUMMARIES.map((s) => s.category).filter(Boolean));
  CATS = Tone.CAT_ORDER.filter((c) => present.has(c));
  for (const c of present) if (!CATS.includes(c)) CATS.push(c);

  const cur = els.catf.value;
  els.catf.innerHTML = '<option value="">全カテゴリ</option>' +
    CATS.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  if (cur && CATS.includes(cur)) els.catf.value = cur;
}

function setLoadStatus(kind, html) {
  els.loadStatus.className = `status ${kind}`;
  els.loadStatus.innerHTML = html;
}

async function loadData(force) {
  if (!Settings.hasToken()) { showBrowser(false); return; }
  if (loading) return;
  if (loaded && !force) return;

  loading = true;
  els.btnReload.classList.add('spin');
  showBrowser(true);

  // オフライン: ネットワークを使わずキャッシュから表示
  if (!navigator.onLine) {
    await loadFromCache('オフライン');
    loading = false;
    els.btnReload.classList.remove('spin');
    return;
  }

  setLoadStatus('busy', '読み込み中…');
  try {
    GH = new GitHub();
    const res = await Store.loadItems(GH, (phase, done, total) => {
      if (phase === 'tree') setLoadStatus('busy', 'ファイル一覧を取得中…');
      else if (phase === 'blobs' && total) setLoadStatus('busy', `アイテム取得中… ${done}/${total}`);
    });
    ITEMS = res.items;
    SUMMARIES = ITEMS.map((it) => Tone.listSummary(it));
    buildCategoryOptions();
    loaded = true;
    render();
    const parts = [`取得 ${res.fetched} 件`, `キャッシュ ${res.fromCache} 件`];
    if (res.removed) parts.push(`削除 ${res.removed} 件`);
    let extra = '';
    if (GH.rate && GH.rate.remaining != null && GH.rate.remaining < 100) {
      extra = `　⚠ API残り ${GH.rate.remaining}（${fmtReset(GH.rate.reset)} に回復）`;
    }
    setLoadStatus('ok', `${ITEMS.length} 件読み込み（${parts.join(' / ')}）${extra}`);
  } catch (e) {
    // 通信エラーでキャッシュがあれば前回データを表示
    if (isNetworkError(e) && await loadFromCache('オフライン（取得失敗）')) {
      loading = false; els.btnReload.classList.remove('spin'); return;
    }
    let msg = escapeHtml(e.message || 'unknown');
    if (e.status === 401) msg = 'トークンが無効です（401）。⚙ から再設定してください。';
    else if (e.status === 404) msg = 'リポジトリ／ブランチが見つかりません。⚙ の設定を確認してください。';
    else if (e.rateRemaining === '0') msg = `API レート上限です。${fmtReset(e.rateReset)} に回復します。`;
    setLoadStatus('err', `読み込み失敗: ${msg}`);
  } finally {
    loading = false;
    els.btnReload.classList.remove('spin');
  }
}

function isNetworkError(e) {
  return e && (e.name === 'TypeError' || /load failed|networkerror|failed to fetch/i.test(e.message || ''));
}

/** IndexedDB キャッシュのみから表示（オフライン/取得失敗時）。表示できたら true。 */
async function loadFromCache(reason) {
  try {
    const res = await Store.loadCached();
    if (!res.items.length) {
      setLoadStatus('err', `${reason}: キャッシュがありません。一度オンラインで開いてください。`);
      return false;
    }
    ITEMS = res.items;
    SUMMARIES = ITEMS.map((it) => Tone.listSummary(it));
    buildCategoryOptions();
    loaded = true;
    render();
    setLoadStatus('busy', `${reason}: 前回データ ${ITEMS.length} 件を表示中（編集・追加はオンライン時のみ）`);
    return true;
  } catch (e) {
    setLoadStatus('err', `${reason}: キャッシュ読込に失敗しました。`);
    return false;
  }
}

function fmtReset(epochSec) {
  if (!epochSec) return '少し後';
  try {
    return new Date(epochSec * 1000).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  } catch (_e) { return '少し後'; }
}

/* ---------- フィルタ・ソート ---------- */
function filtered() {
  const q = els.q.value.trim().toLowerCase();
  const cat = els.catf.value;
  let rows = SUMMARIES.filter((it) => {
    if (cat && it.category !== cat) return false;
    if (missOnly && it.price != null && it.date != null) return false;
    if (q) {
      const hay = [it.name, it.brand, it.category, it.color, asList(it.color_family),
        asList(it.lineage), it.tone].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  rows.sort((a, b) => {
    let x, y;
    if (sortK === 'category') { x = catRank(a.category); y = catRank(b.category); }
    else if (sortK === 'lineage') { x = asList(a.lineage); y = asList(b.lineage); }
    else if (sortK === 'price') { x = a.price ?? -1; y = b.price ?? -1; }
    else if (sortK === 'satisfaction') { x = a.satisfaction ?? -1; y = b.satisfaction ?? -1; }
    else { x = (a[sortK] || ''); y = (b[sortK] || ''); }
    if (x < y) return sortAsc ? -1 : 1;
    if (x > y) return sortAsc ? 1 : -1;
    return 0;
  });
  return rows;
}

function render() {
  if (!loaded) return;
  const rows = filtered();
  const total = rows.reduce((s, it) => s + (it.price || 0), 0);
  const priced = rows.filter((it) => it.price != null).length;
  els.stat.textContent = `${rows.length} 件 / 購入額合計 ${fmtYen(total)}（金額入力済 ${priced} 件）`;
  // 0件のときは空状態を表示
  els.emptyResults.hidden = rows.length > 0;
  els.cards.hidden = rows.length === 0 || view !== 'card';
  els.tblWrap.hidden = rows.length === 0 || view !== 'list';
  if (rows.length) { if (view === 'card') renderCards(rows); else renderList(rows); }
  updateSortHeaders();
}

function thumbHtml(it) {
  if (it.image) {
    return `<img class="thumb ph" data-img="${escapeHtml(it.image)}" alt="" loading="lazy">`;
  }
  return '<div class="thumb ph">No image</div>';
}

function toneDot(it) {
  if (!it.tone) return '';
  const bg = it.tone_hex ? escapeHtml(it.tone_hex) : '#ccc';
  return `<span class="tonedot" style="background:${bg}" title="${escapeHtml(it.tone)}"></span>` +
    `<span class="tonelbl">${escapeHtml(it.tone)}</span>`;
}

function renderCards(rows) {
  els.cards.hidden = false;
  els.tblWrap.hidden = true;
  const html = rows.map((it) => {
    const price = it.price != null
      ? `<span class="price">${fmtYen(it.price)}</span>`
      : '<span class="price miss">未入力</span>';
    return `<div class="card" data-id="${escapeHtml(it.id)}">
      ${thumbHtml(it)}
      <div class="cbody">
        <div class="nm">${escapeHtml(it.name || it.id)}</div>
        <div class="br">${escapeHtml(it.brand || it.category || '')}</div>
        <div class="cfoot">${price}<span class="tone">${toneDot(it)}</span>
          <button type="button" class="wearbtn" data-id="${escapeHtml(it.id)}" title="今日これを着た（着用回数を+1）">👕 <span class="wc">${it.wear_count || 0}</span></button>
        </div>
      </div></div>`;
  }).join('');
  els.cards.innerHTML = html;
  observeThumbs();
}

/* ---------- 画像の遅延ロード（フェーズ3） ---------- */
let thumbObserver = null;
function observeThumbs() {
  if (!('IntersectionObserver' in window)) {
    // 非対応環境では即時ロード
    els.cards.querySelectorAll('img.thumb[data-img]').forEach(loadThumb);
    return;
  }
  if (!thumbObserver) {
    thumbObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { thumbObserver.unobserve(e.target); loadThumb(e.target); }
      }
    }, { rootMargin: '120px' });
  }
  els.cards.querySelectorAll('img.thumb[data-img]').forEach((img) => thumbObserver.observe(img));
}

async function loadThumb(img) {
  const path = img.dataset.img;
  if (!path || img.dataset.loaded) return;
  img.dataset.loaded = '1';
  try {
    const url = await Store.imageUrl(GH || new GitHub(), path);
    if (url) { img.src = url; img.classList.remove('ph'); }
    else { showThumbFail(img); }
  } catch (e) {
    console.warn('画像取得失敗:', path, e);
    showThumbFail(img);
  }
}

function showThumbFail(img) {
  const ph = document.createElement('div');
  ph.className = 'thumb ph';
  ph.textContent = '画像なし';
  img.replaceWith(ph);
}

function renderList(rows) {
  els.cards.hidden = true;
  els.tblWrap.hidden = false;
  els.tbody.innerHTML = rows.map((it) => {
    const lin = (it.lineage || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')
      || '<span class="miss">—</span>';
    const tone = it.tone
      ? `${it.tone_hex ? `<span class="sw" style="background:${escapeHtml(it.tone_hex)}"></span>` : ''}${escapeHtml(it.tone)}`
      : '<span class="miss">—</span>';
    return `<tr data-id="${escapeHtml(it.id)}">
      <td>${escapeHtml(it.name || it.id)}</td><td>${escapeHtml(it.brand || '')}</td>
      <td>${escapeHtml(it.category || '')}</td>
      <td>${lin}</td><td>${tone}</td>
      <td>${it.date ? escapeHtml(it.date) : '<span class="miss">—</span>'}</td>
      <td class="num">${it.price != null ? fmtYen(it.price) : '<span class="miss">—</span>'}</td>
      <td class="num">${it.satisfaction != null ? escapeHtml(it.satisfaction) : ''}</td>
      <td>${escapeHtml(it.tier || '')}</td>
    </tr>`;
  }).join('');
}

function updateSortHeaders() {
  document.querySelectorAll('#tbl th').forEach((th) => {
    const on = th.dataset.k === sortK;
    th.classList.toggle('sorted', on);
    th.classList.toggle('asc', on && sortAsc);
  });
}

/* ---------- 編集モーダル（フェーズ4） ---------- */
function deepClone(obj) {
  if (typeof structuredClone === 'function') {
    try { return structuredClone(obj); } catch (_e) { /* fall through */ }
  }
  return JSON.parse(JSON.stringify(obj));
}

function fld(label, inner, full, hint) {
  return `<div class="fld${full ? ' full' : ''}"><label>${escapeHtml(label)}</label>${inner}` +
    `${hint ? `<span class="hint">${escapeHtml(hint)}</span>` : ''}</div>`;
}

function setMsg(kind, text) {
  els.mMsg = els.mMsg || $('#m-msg');
  els.mMsg.className = `msg ${kind}`;
  els.mMsg.textContent = text;
}

function openEdit(id) {
  const it = ITEMS.find((x) => x.id === id);
  if (!it) return;
  editingId = id;
  editImageBlob = null;
  setMsg('', '');
  $('#m-name').textContent = it.name || id;
  $('#m-id').textContent = id;

  const f = it.facts || {}, p = it.purchase || {}, o = it.owner || {};
  const ai = it.ai_assessment || {}, pos = it.position || {};
  const tn = Tone.toneInfo(it);
  const catOpts = ['<option value=""></option>']
    .concat(CATS.map((c) => `<option ${c === it.category ? 'selected' : ''}>${escapeHtml(c)}</option>`)).join('');
  const ptOpts = ['<option value=""></option>']
    .concat(Tone.PURCHASE_TYPES.map((t) => `<option ${t === p.type ? 'selected' : ''}>${escapeHtml(t)}</option>`)).join('');
  const aqOpts = ACQUISITION_TYPES
    .map((t) => `<option ${t === (p.acquisition || '購入') ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('');

  const sw = tn.hex ? `<span class="sw" style="background:${escapeHtml(tn.hex)}"></span>` : '';
  const toneBlock = `<div class="tone-ro">
    <b>カラートーン（実測・読み取り専用）</b> ${sw}
    グループ: <b>${escapeHtml(tn.group || '—（実測なし/確度低）')}</b>${tn.confidence ? ` / confidence: ${escapeHtml(tn.confidence)}` : ''}
    ${tn.L != null ? `<br>L ${tn.L} / C ${tn.C} / h ${tn.h}°` : ''}
    ${(tn.family_auto && tn.family_auto.length) ? `<br>family_auto: ${escapeHtml(tn.family_auto.join(', '))}` : ''}
    <br><span class="hint">色実測は画像から自動算出され編集できません（color_measured は保全）。</span></div>`;

  const w = it.wear || {};
  const autoBlock = `<div class="ro-auto">自動管理（編集不可）— tier: ${escapeHtml(pos.tier || '—')} / outfit_count: ${pos.outfit_count ?? '—'}
    <br>着用回数: ${w.count ?? 0}${w.last_worn ? `（最終 ${escapeHtml(w.last_worn)}）` : ''}
    ${ai.style_fit ? `<br>AI style_fit: ${escapeHtml(ai.style_fit)}` : ''}</div>`;

  const photoBlock = `<div class="fld full">
      <div id="m-shot" class="shotbox"><span class="muted">画像読み込み中…</span></div>
      <input type="file" accept="image/*" id="m-file" hidden>
      <div class="photo-actions">
        <button type="button" class="btn secondary" id="m-photo">写真を変更 / 撮影</button>
        <span class="hint" id="m-photo-hint">変更すると色は「実測なし」に戻り、後でローカル抽出で再確定します。</span>
      </div>
    </div>`;

  $('#m-body').innerHTML =
    photoBlock +
    fld('名前', `<input id="e-name" value="${escapeHtml(it.name)}">`) +
    fld('ブランド', `<input id="e-brand" value="${escapeHtml(it.brand)}">`) +
    fld('カテゴリ', `<select id="e-category">${catOpts}</select>`) +
    fld('色（表現）', `<input id="e-color" value="${escapeHtml(f.color)}">`) +
    fld('購入時期', `<input id="e-pdate" value="${escapeHtml(p.date ?? '')}" placeholder="例: 2026-03">`, false, 'YYYY-MM など') +
    fld('購入金額（円）', `<input id="e-price" type="number" inputmode="numeric" value="${p.price ?? ''}">`) +
    fld('購入チャネル', `<input id="e-channel" value="${escapeHtml(p.channel)}" placeholder="店舗 / オンライン 等">`) +
    fld('購入種別', `<select id="e-ptype">${ptOpts}</select>`) +
    fld('取得手段', `<select id="e-acquisition">${aqOpts}</select>`, false, '購入 / プレゼント / 相続・譲渡') +
    fld('色ファミリー', `<input id="e-color_family" value="${escapeHtml(asList(f.color_family))}">`, true, 'カンマ区切り') +
    fld('系統タグ', `<input id="e-lineage" value="${escapeHtml(asList((f.style || {}).lineage))}">`, true, 'カンマ区切り・主系統を先頭') +
    toneBlock +
    fld('素材', `<input id="e-material" value="${escapeHtml(f.material)}">`) +
    fld('シルエット', `<input id="e-silhouette" value="${escapeHtml(f.silhouette)}">`) +
    fld('ディテール', `<input id="e-details" value="${escapeHtml(asList(f.details))}">`, true, 'カンマ区切り') +
    fld('シーズン', `<input id="e-season" value="${escapeHtml(asList(f.season))}">`) +
    fld('シーン', `<input id="e-scene" value="${escapeHtml(asList(f.scene))}">`) +
    fld('コンディション', `<input id="e-condition" value="${escapeHtml(f.condition)}">`) +
    fld('サイズ memo', `<input id="e-size_note" value="${escapeHtml(f.size_note)}">`) +
    `<div class="row2">
       <label class="chk"><input type="checkbox" id="e-primary_flag" ${f.primary_flag ? 'checked' : ''}> primary_flag</label>
       <label class="chk"><input type="checkbox" id="e-formal_adjacent" ${f.formal_adjacent ? 'checked' : ''}> formal_adjacent</label>
     </div>` +
    fld('満足度（1-5）', `<input id="e-satisfaction" type="number" min="1" max="5" value="${o.satisfaction ?? ''}">`) +
    fld('よかった点', `<textarea id="e-liked_note">${escapeHtml(o.liked_note)}</textarea>`, true) +
    fld('後悔メモ・フィット', `<textarea id="e-regret_note">${escapeHtml(o.regret_note)}</textarea>`, true) +
    fld('実用メモ', `<textarea id="e-usage_note">${escapeHtml(o.usage_note)}</textarea>`, true) +
    autoBlock;

  $('#ov').hidden = false;
  $('#m-photo').addEventListener('click', () => $('#m-file').click());
  $('#m-file').addEventListener('change', onEditPickImage);
  loadModalImage(it);
}

function setShot(url) {
  const box = $('#m-shot');
  if (!box) return;
  if (url) {
    box.innerHTML = '';
    const img = document.createElement('img');
    img.className = 'shot';
    img.src = url;
    box.appendChild(img);
  } else {
    box.innerHTML = '<span class="muted">画像なし（下のボタンで追加できます）</span>';
  }
}

async function loadModalImage(it) {
  const src = ((it.facts || {}).color_measured || {}).source_image;
  if (!src) { setShot(null); return; }
  try {
    const url = await Store.imageUrl(GH || new GitHub(), src);
    if (editingId !== it.id) return; // 別アイテムに切り替わっていたら破棄
    setShot(url || null);
  } catch (_e) {
    if (editingId === it.id) $('#m-shot').innerHTML = '<span class="muted">画像の取得に失敗</span>';
  }
}

async function onEditPickImage(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const box = $('#m-shot');
  box.innerHTML = '<span class="muted">画像を処理中…</span>';
  editImageBlob = null;
  try {
    const blob = await processNewImage(file);
    editImageBlob = blob;
    setShot(URL.createObjectURL(blob));
    $('#m-photo-hint').textContent = `新しい写真（${Math.round(blob.size / 1024)}KB）。保存で反映され、色は実測なしに戻ります。`;
  } catch (err) {
    console.warn('画像処理失敗:', err);
    box.innerHTML = '<span class="miss">画像の読み込みに失敗しました。別の写真でお試しください。</span>';
  }
}

function closeEdit() { $('#ov').hidden = true; editingId = null; editImageBlob = null; }

const splitList = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
const numOrNull = (s) => { s = String(s).trim(); return s === '' ? null : Number(s); };

function gatherPatch() {
  const v = (id) => $('#e-' + id);
  return {
    name: v('name').value.trim(), brand: v('brand').value.trim(), category: v('category').value,
    facts: {
      color: v('color').value.trim(), color_family: splitList(v('color_family').value),
      material: v('material').value.trim(), silhouette: v('silhouette').value.trim(),
      lineage: splitList(v('lineage').value),
      details: splitList(v('details').value), season: splitList(v('season').value),
      scene: splitList(v('scene').value), condition: v('condition').value.trim(),
      size_note: v('size_note').value.trim(),
      primary_flag: v('primary_flag').checked, formal_adjacent: v('formal_adjacent').checked,
    },
    purchase: {
      date: v('pdate').value.trim() || null, price: numOrNull(v('price').value),
      channel: v('channel').value.trim(), type: v('ptype').value || null,
      acquisition: v('acquisition').value || '購入',
    },
    owner: {
      satisfaction: numOrNull(v('satisfaction').value),
      liked_note: v('liked_note').value,
      regret_note: v('regret_note').value, usage_note: v('usage_note').value,
    },
  };
}

async function saveEdit() {
  if (!editingId || !$('#e-name')) return;
  if (!navigator.onLine) { setMsg('err', 'オフラインです。オンライン時に保存してください。'); return; }
  const id = editingId;
  const orig = ITEMS.find((x) => x.id === id);
  if (!orig) return;

  const path = `items/${id}.yaml`;
  const sha = Store.itemSha(id);
  if (!sha) { setMsg('err', 'sha 不明です。再読み込みしてから保存してください。'); return; }

  // キャッシュのフルYAMLに対し apply_patch（自動管理セクションは保全）
  // dump は PyYAML(safe_dump) の体裁に寄せる（noArrayIndent / 単一引用符）。lineWidth:-1 で
  // 長文 usage_note を1行に保ち、折り畳み(>-)を避けて読みやすく差分も最小化する。
  // 自動管理セクションは値が不変（js-yaml は 40.0→40 のように整数値 float の末尾 .0 だけ
  // 正規化するが数値は同一。色実測は後でローカルの extract_colors が再生成して確定）。
  const patched = Patch.applyPatch(deepClone(orig), gatherPatch());

  // 画像差し替え/追加がある場合: color_measured を空に戻し（source_image は維持/設定）、
  // 画像を先にコミットしてから YAML をコミットする。色は後でローカル抽出で再確定。
  let imgCommit = null;
  if (editImageBlob) {
    const cm = (orig.facts || {}).color_measured || {};
    const imgPath = cm.source_image || `images/${id}.jpg`;
    patched.facts = patched.facts || {};
    patched.facts.color_measured = {
      source_image: imgPath, extracted: null, clusters: [], family_auto: [], tone: null, confidence: null,
    };
    imgCommit = { path: imgPath, sha: Store.imageShas.get(imgPath) };
  }

  const yamlText = jsyaml.dump(patched, {
    sortKeys: false, lineWidth: -1, noRefs: true, noArrayIndent: true, quotingType: "'",
  });

  els.mSave = els.mSave || $('#m-save');
  els.mSave.disabled = true;
  setMsg('busy', '保存中…');
  try {
    const gh = GH || new GitHub();
    if (imgCommit) {
      setMsg('busy', '画像をコミット中…');
      const bytes = new Uint8Array(await editImageBlob.arrayBuffer());
      const ir = await gh.putContents(imgCommit.path, {
        message: `画像を更新: ${id}`, bytes, sha: imgCommit.sha,
      });
      const isha = ir && ir.content && ir.content.sha;
      if (isha) { Store.imageShas.set(imgCommit.path, isha); await Store.putThumb(isha, editImageBlob); }
      setMsg('busy', 'データをコミット中…');
    }
    const res = await gh.putContents(path, {
      message: `アイテム情報を更新: ${id}`,
      text: yamlText,
      sha,
    });
    const newSha = res && res.content && res.content.sha;
    if (newSha) await Store.updateItemCache(path, newSha, patched);

    // メモリ上の ITEMS / SUMMARIES を更新して再描画
    const i = ITEMS.findIndex((x) => x.id === id);
    if (i >= 0) { ITEMS[i] = patched; SUMMARIES[i] = Tone.listSummary(patched); }
    editImageBlob = null;
    setMsg('ok', imgCommit ? '画像とデータをコミットしました ✓' : 'コミットしました ✓');
    render();
    setTimeout(() => { if (editingId === id) closeEdit(); }, 700);
  } catch (e) {
    let msg = e.message || 'unknown';
    if (e.status === 409) msg = '競合（他から更新されています）。再読み込みしてから再編集してください。';
    else if (e.status === 403 && e.rateRemaining === '0') msg = 'API レート上限です。しばらく待って再試行してください。';
    else if (e.status === 401) msg = 'トークンが無効です（401）。⚙ から再設定してください。';
    else if (e.status === 404 || e.status === 422) msg = '保存先が見つかりません/不正です。書込権限と設定を確認してください。';
    setMsg('err', `保存失敗: ${msg}`);
  } finally {
    els.mSave.disabled = false;
  }
}

/* ---------- 着用記録（カードの「今日これ着た」タップ） ---------- */
// wear.count を +1、last_worn を当日、log に当日を追記して即コミットする。
// 自動管理セクション含めフル YAML を deepClone から再 dump するため他フィールドは保全される。
async function logWear(id, btn) {
  if (!navigator.onLine) { flashNet('オフラインです。オンライン時に記録してください。'); return; }
  const i = ITEMS.findIndex((x) => x.id === id);
  if (i < 0) return;
  const sha = Store.itemSha(id);
  if (!sha) { flashNet('sha 不明です。再読み込みしてから記録してください。'); return; }
  if (btn) { if (btn.dataset.busy) return; btn.dataset.busy = '1'; btn.disabled = true; btn.classList.add('busy'); }

  const today = new Date().toISOString().slice(0, 10);
  const patched = deepClone(ITEMS[i]);
  const wear = (patched.wear = patched.wear || { count: 0, last_worn: null, log: [] });
  wear.count = (wear.count || 0) + 1;
  wear.last_worn = today;
  wear.log = wear.log || [];
  wear.log.push(today);

  const yamlText = jsyaml.dump(patched, {
    sortKeys: false, lineWidth: -1, noRefs: true, noArrayIndent: true, quotingType: "'",
  });
  try {
    const gh = GH || new GitHub();
    const res = await gh.putContents(`items/${id}.yaml`, {
      message: `着用記録: ${id}（${today}・累計${wear.count}回）`,
      text: yamlText,
      sha,
    });
    const newSha = res && res.content && res.content.sha;
    if (newSha) await Store.updateItemCache(`items/${id}.yaml`, newSha, patched);
    ITEMS[i] = patched;
    SUMMARIES[i] = Tone.listSummary(patched);
    render(); // カードの回数表示を更新
  } catch (e) {
    let msg = e.message || 'unknown';
    if (e.status === 409) msg = '競合（他から更新）。再読み込みしてください。';
    else if (e.status === 401) msg = 'トークン無効（401）。⚙ から再設定してください。';
    else if (e.status === 403 && e.rateRemaining === '0') msg = 'API レート上限です。少し待って再試行してください。';
    flashNet(`着用記録の保存失敗: ${msg}`);
    if (btn) { btn.disabled = false; delete btn.dataset.busy; btn.classList.remove('busy'); }
  }
}

// ネットバナーに一時メッセージを表示する（数秒で自動的に隠す）。
let netFlashTimer = null;
function flashNet(text) {
  if (!els.netBanner) return;
  els.netBanner.textContent = text;
  els.netBanner.hidden = false;
  clearTimeout(netFlashTimer);
  netFlashTimer = setTimeout(() => { els.netBanner.hidden = true; }, 4000);
}

/* ---------- 新規追加（カメラ/写真, フェーズ5） ---------- */
function setNewMsg(kind, text) {
  const el = $('#new-msg');
  el.className = `msg ${kind}`;
  el.textContent = text;
}

/** 選択画像を長辺 maxSide の JPEG に縮小（iOS Safari は HEIC も createImageBitmap で復号可）。 */
async function processNewImage(file, maxSide = 1600, quality = 0.85) {
  let src, W, H;
  try {
    src = await createImageBitmap(file);
    W = src.width; H = src.height;
  } catch (_e) {
    // フォールバック: <img> で読み込む
    src = await new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('decode failed'));
      img.src = URL.createObjectURL(file);
    });
    W = src.naturalWidth; H = src.naturalHeight;
  }
  const scale = Math.min(1, maxSide / Math.max(W, H));
  const w = Math.round(W * scale), h = Math.round(H * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(src, 0, 0, w, h);
  if (src.close) src.close();
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
  if (!blob) throw new Error('encode failed');
  return blob;
}

async function onPickImage(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const prev = $('#n-preview');
  prev.innerHTML = '<span class="muted">画像を処理中…</span>';
  newImageBlob = null;
  try {
    const blob = await processNewImage(file);
    newImageBlob = blob;
    const url = URL.createObjectURL(blob);
    prev.innerHTML = `<img src="${url}" alt=""><span class="muted">縮小後 ${Math.round(blob.size / 1024)}KB</span>`;
  } catch (err) {
    console.warn('画像処理失敗:', err);
    prev.innerHTML = '<span class="miss">画像の読み込みに失敗しました。別の写真でお試しください。</span>';
  }
}

function openNew() {
  if (!Settings.hasToken()) { showView('settings'); return; }
  newImageBlob = null;
  setNewMsg('', '');
  const cats = CATS.length ? CATS : Tone.CAT_ORDER;
  const catOpts = ['<option value=""></option>']
    .concat(cats.map((c) => `<option>${escapeHtml(c)}</option>`)).join('');
  const ptOpts = ['<option value=""></option>']
    .concat(Tone.PURCHASE_TYPES.map((t) => `<option>${escapeHtml(t)}</option>`)).join('');

  $('#new-body').innerHTML =
    `<div class="fld full">
       <label>写真（カメラ / ライブラリ）</label>
       <input type="file" accept="image/*" id="n-file">
       <div id="n-preview" class="newprev"></div>
       <span class="hint">撮影/選択すると長辺1600pxのJPEGに縮小して保存します。</span>
     </div>` +
    `<div class="tone-ro full"><b>色は後でローカル抽出</b><br>ブラウザでは色抽出（extract_colors.py）を実行できないため、
       登録時のトーンは「実測なし」です。後でローカルで <code>scripts/extract_colors.py</code> を回すと
       color_measured が確定します。</div>` +
    fld('ID（半角・ファイル名になる）', `<input id="n-id" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="例: shirt_brand_black">`, true, '英数字と _ のみ。images/&lt;ID&gt;.jpg と items/&lt;ID&gt;.yaml になります') +
    fld('名前', `<input id="n-name" placeholder="例: Comoli ブラックシャツ">`) +
    fld('ブランド', `<input id="n-brand">`) +
    fld('カテゴリ', `<select id="n-category">${catOpts}</select>`) +
    fld('色（表現）', `<input id="n-color">`) +
    fld('色ファミリー', `<input id="n-color_family">`, true, 'カンマ区切り') +
    fld('系統タグ', `<input id="n-lineage">`, true, 'カンマ区切り・主系統を先頭') +
    fld('素材', `<input id="n-material">`) +
    fld('シルエット', `<input id="n-silhouette">`) +
    fld('ディテール', `<input id="n-details">`, true, 'カンマ区切り') +
    fld('シーズン', `<input id="n-season">`, false, 'カンマ区切り') +
    fld('シーン', `<input id="n-scene">`, false, 'カンマ区切り') +
    fld('コンディション', `<input id="n-condition">`) +
    fld('サイズ memo', `<input id="n-size_note">`) +
    `<div class="row2">
       <label class="chk"><input type="checkbox" id="n-primary_flag"> primary_flag</label>
       <label class="chk"><input type="checkbox" id="n-formal_adjacent"> formal_adjacent</label>
     </div>` +
    fld('購入時期', `<input id="n-pdate" placeholder="例: 2026-03">`, false, 'YYYY-MM など') +
    fld('購入金額（円）', `<input id="n-price" type="number" inputmode="numeric">`) +
    fld('購入チャネル', `<input id="n-channel">`) +
    fld('購入種別', `<select id="n-ptype">${ptOpts}</select>`) +
    fld('取得手段', `<select id="n-acquisition">${ACQUISITION_TYPES.map((t) => `<option>${escapeHtml(t)}</option>`).join('')}</select>`, false, '購入 / プレゼント / 相続・譲渡') +
    fld('満足度（1-5）', `<input id="n-satisfaction" type="number" min="1" max="5">`) +
    fld('よかった点', `<textarea id="n-liked_note"></textarea>`, true) +
    fld('後悔メモ・フィット', `<textarea id="n-regret_note"></textarea>`, true) +
    fld('実用メモ', `<textarea id="n-usage_note"></textarea>`, true);

  $('#newov').hidden = false;
  $('#n-file').addEventListener('change', onPickImage);
}

function closeNew() { $('#newov').hidden = true; newImageBlob = null; }

async function saveNew() {
  const v = (x) => $('#n-' + x);
  const id = (v('id').value || '').trim();
  const name = (v('name').value || '').trim();
  const category = v('category').value;

  if (!navigator.onLine) { setNewMsg('err', 'オフラインです。オンライン時に追加してください。'); return; }
  if (!newImageBlob) { setNewMsg('err', '写真を選択してください。'); return; }
  if (!/^[A-Za-z0-9][A-Za-z0-9_]*$/.test(id)) {
    setNewMsg('err', 'ID は半角英数字と _ のみ（先頭は英数字）にしてください。'); return;
  }
  if (ITEMS.some((it) => it.id === id) || Store.itemSha(id)) {
    setNewMsg('err', `ID "${id}" は既に存在します。別の ID にしてください。`); return;
  }
  if (!name) { setNewMsg('err', '名前を入力してください。'); return; }
  if (!category) { setNewMsg('err', 'カテゴリを選択してください。'); return; }

  const item = Patch.newSkeleton({
    id, name, brand: v('brand').value.trim(), category,
    color: v('color').value.trim(),
    color_family: splitList(v('color_family').value),
    lineage: splitList(v('lineage').value),
    material: v('material').value.trim(), silhouette: v('silhouette').value.trim(),
    details: splitList(v('details').value), season: splitList(v('season').value),
    scene: splitList(v('scene').value), condition: v('condition').value.trim(),
    size_note: v('size_note').value.trim(),
    primary_flag: v('primary_flag').checked, formal_adjacent: v('formal_adjacent').checked,
    date: v('pdate').value.trim() || null, price: numOrNull(v('price').value),
    channel: v('channel').value.trim(), type: v('ptype').value || null,
    acquisition: v('acquisition').value || '購入',
    satisfaction: numOrNull(v('satisfaction').value),
    liked_note: v('liked_note').value,
    regret_note: v('regret_note').value, usage_note: v('usage_note').value,
  });
  const yamlText = jsyaml.dump(item, {
    sortKeys: false, lineWidth: -1, noRefs: true, noArrayIndent: true, quotingType: "'",
  });

  els.newSave.disabled = true;
  try {
    const gh = GH || new GitHub();
    // 1) 画像を先にコミット（YAML の source_image 実在を満たす）
    setNewMsg('busy', '画像をコミット中…');
    const imgBytes = new Uint8Array(await newImageBlob.arrayBuffer());
    const imgRes = await gh.putContents(`images/${id}.jpg`, { message: `画像を追加: ${id}`, bytes: imgBytes });
    // 2) YAML スケルトンをコミット
    setNewMsg('busy', 'データをコミット中…');
    const ymlRes = await gh.putContents(`items/${id}.yaml`, { message: `アイテムを追加: ${id}`, text: yamlText });

    // 状態・キャッシュ更新
    const imgSha = imgRes && imgRes.content && imgRes.content.sha;
    const ymlSha = ymlRes && ymlRes.content && ymlRes.content.sha;
    if (imgSha) { Store.imageShas.set(`images/${id}.jpg`, imgSha); await Store.putThumb(imgSha, newImageBlob); }
    if (ymlSha) await Store.updateItemCache(`items/${id}.yaml`, ymlSha, item);
    ITEMS.push(item);
    SUMMARIES.push(Tone.listSummary(item));
    buildCategoryOptions();
    setNewMsg('ok', '追加しました ✓（色は後でローカルで extract_colors を実行）');
    render();
    setTimeout(closeNew, 900);
  } catch (e) {
    let msg = e.message || 'unknown';
    if (e.status === 422) msg = '同名ファイルが既に存在します。ID を変えてください。';
    else if (e.status === 403 && e.rateRemaining === '0') msg = 'API レート上限です。しばらく待って再試行してください。';
    else if (e.status === 401) msg = 'トークンが無効です（401）。⚙ から再設定してください。';
    else if (e.status === 404) msg = '書込先が見つかりません。Contents 書込権限と設定を確認してください。';
    setNewMsg('err', `追加失敗: ${escapeHtml(msg)}`);
  } finally {
    els.newSave.disabled = false;
  }
}

/* ---------- ネット状態 / ホーム追加導線（フェーズ6） ---------- */
function updateNetUI() {
  const offline = !navigator.onLine;
  els.netBanner.hidden = !offline;
  if (offline) {
    els.netBanner.className = 'net-banner';
    els.netBanner.textContent = 'オフライン — 前回データを表示中。編集・追加・再読み込みはオンライン時のみです。';
  }
}

function isStandalone() {
  return window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
}
function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent); }

function maybeShowA2HS() {
  if (localStorage.getItem('wardrobe.a2hs.dismissed')) return;
  if (!isIOS() || isStandalone()) return;
  $('#a2hs').hidden = false;
}

/* ---------- ドキュメント（budget / wishlist / レポート） ---------- */
const DOC_LABELS = { 'budget.md': '予算 (budget)', 'wishlist.md': 'ウィッシュリスト (wishlist)' };
function docLabel(path) {
  return DOC_LABELS[path] || path.split('/').pop().replace(/\.md$/, '');
}

function openDocs() {
  $('#docsov').hidden = false;
  showDocList();
}
function closeDocs() { $('#docsov').hidden = true; }

function showDocList() {
  $('#docs-title').textContent = 'ドキュメント';
  $('#docs-back').hidden = true;
  const paths = Store.docList();
  const body = $('#docs-body');
  if (!paths.length) {
    body.innerHTML = '<div class="placeholder">ドキュメントがありません。一覧を読み込んでから開いてください。</div>';
    return;
  }
  const root = paths.filter((p) => !p.includes('/'));
  const reports = paths.filter((p) => p.startsWith('reports/'));
  const group = (title, list) => (list.length
    ? `<div class="doc-group">${escapeHtml(title)}</div>` + list.map((p) =>
      `<button class="doc-item" data-path="${escapeHtml(p)}">${escapeHtml(docLabel(p))}` +
      `<span class="doc-path">${escapeHtml(p)}</span></button>`).join('')
    : '');
  body.innerHTML = group('メモ', root) + group('レポート', reports);
  body.scrollTop = 0;
}

async function showDoc(path) {
  $('#docs-title').textContent = docLabel(path);
  $('#docs-back').hidden = false;
  const body = $('#docs-body');
  body.innerHTML = '<div class="placeholder">読み込み中…</div>';
  try {
    const md = await Store.docText(GH || new GitHub(), path);
    body.innerHTML = `<div class="md-body">${marked.parse(md)}</div>`;
    body.scrollTop = 0;
  } catch (e) {
    body.innerHTML = `<div class="placeholder">読み込み失敗: ${escapeHtml(e.message || 'unknown')}</div>`;
  }
}

/* ---------- SW ---------- */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW 登録失敗:', e));
  });
}

/* ---------- 初期化 ---------- */
function init() {
  cacheEls();
  loadSettingsIntoForm();

  // 設定画面
  els.btnSettings.addEventListener('click', () => { loadSettingsIntoForm(); showView('settings'); });
  els.btnBack.addEventListener('click', () => { showView('main'); loadData(false); });
  els.btnTest.addEventListener('click', onTest);
  els.btnSave.addEventListener('click', onSave);
  els.btnClear.addEventListener('click', onClear);

  // 一覧
  els.q.addEventListener('input', debounce(render, 180));
  els.catf.addEventListener('change', render);
  els.missf.addEventListener('click', () => {
    missOnly = !missOnly;
    els.missf.classList.toggle('on', missOnly);
    els.missf.setAttribute('aria-pressed', String(missOnly));
    render();
  });
  els.vCard.addEventListener('click', () => { view = 'card'; els.vCard.classList.add('on'); els.vList.classList.remove('on'); render(); });
  els.vList.addEventListener('click', () => { view = 'list'; els.vList.classList.add('on'); els.vCard.classList.remove('on'); render(); });
  els.btnReload.addEventListener('click', () => loadData(true));
  document.querySelectorAll('#tbl th').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.k;
    if (sortK === k) sortAsc = !sortAsc; else { sortK = k; sortAsc = true; }
    render();
  }));

  // カード/行クリックで編集モーダル（イベント委譲）
  els.cards.addEventListener('click', (e) => {
    const wbtn = e.target.closest('.wearbtn');
    if (wbtn) { e.stopPropagation(); logWear(wbtn.dataset.id, wbtn); return; }
    const card = e.target.closest('.card');
    if (card && card.dataset.id) openEdit(card.dataset.id);
  });
  els.tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (tr && tr.dataset.id) openEdit(tr.dataset.id);
  });

  // 編集モーダル操作
  $('#m-close').addEventListener('click', closeEdit);
  $('#m-save').addEventListener('click', saveEdit);
  $('#ov').addEventListener('click', (e) => { if (e.target.id === 'ov') closeEdit(); });

  // ドキュメント
  $('#btn-docs').addEventListener('click', openDocs);
  $('#docs-close').addEventListener('click', closeDocs);
  $('#docs-back').addEventListener('click', showDocList);
  $('#docs-body').addEventListener('click', (e) => {
    const item = e.target.closest('.doc-item');
    if (item && item.dataset.path) showDoc(item.dataset.path);
  });
  $('#docsov').addEventListener('click', (e) => { if (e.target.id === 'docsov') closeDocs(); });

  // 新規追加
  els.btnNew.addEventListener('click', openNew);
  $('#new-close').addEventListener('click', closeNew);
  $('#new-save').addEventListener('click', saveNew);
  $('#newov').addEventListener('click', (e) => { if (e.target.id === 'newov') closeNew(); });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#docsov').hidden) closeDocs();
    else if (!$('#newov').hidden) closeNew();
    else if (!$('#ov').hidden) closeEdit();
  });

  // ネット状態 / ホーム追加導線
  $('#a2hs-close').addEventListener('click', () => {
    $('#a2hs').hidden = true;
    localStorage.setItem('wardrobe.a2hs.dismissed', '1');
  });
  window.addEventListener('offline', updateNetUI);
  window.addEventListener('online', () => {
    updateNetUI();
    if (Settings.hasToken()) loadData(true); // 復帰時に最新へ同期
  });
  updateNetUI();
  maybeShowA2HS();

  if (Settings.hasToken()) {
    showView('main');
    showBrowser(true);
    loadData(false);
  } else {
    showView('settings');
  }

  registerServiceWorker();
}

document.addEventListener('DOMContentLoaded', init);
