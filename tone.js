/* tone.js — カラートーン算出と表示用定数（item_browser / lineage_cluster_report からの移植）。
 *
 * 判定ロジックは scripts/lineage_cluster_report.py の dominant_lch / tone_group、
 * 閾値は data/style_lineage.yaml の tone_groups と一致させる。
 * 色相 h は atan2(b,a) の符号付き度数 [-180,180] のまま比較する（warm_hue_range:[-30,110]）。
 */
'use strict';

// data/style_lineage.yaml の tone_groups と一致（移植・ハードコード）
const TONE_CFG = Object.freeze({
  warm_hue_range: [-30, 110],
  vivid_C_min: 25,
  achromatic_C_max: 8,
  achromatic_L_split: 35,
});

// confidence がこれ以外（low / null 等）のときは tone=null（実測なし扱い）
const CONF_OK = new Set(['high', 'medium']);

// カテゴリ表示順（build_snapshot.py / item_browser.py と揃える）
const CAT_ORDER = [
  'アウター', 'ジャケット', 'スーツ', 'シャツ', 'ニット', 'スウェット', 'Tシャツ',
  'スラックス', 'パンツ（その他）', 'デニム', '靴',
  'ネクタイ', 'ベルト', '時計', 'バッグ', 'アクセサリー・眼鏡',
];

const PURCHASE_TYPES = ['計画購入', '機会購入', 'セール駆動'];

const RAD2DEG = 180 / Math.PI;

/** 最大 ratio クラスタの Lab → [L, C, h°]。実測なし/低 confidence は null。 */
function dominantLch(item) {
  const cm = ((item && item.facts) || {}).color_measured || {};
  const clusters = cm.clusters || [];
  if (!clusters.length || !CONF_OK.has(cm.confidence)) return null;
  let top = clusters[0];
  for (const c of clusters) if ((c.ratio || 0) > (top.ratio || 0)) top = c;
  const lab = top.lab || [];
  const [L, a, b] = lab;
  if (L == null || a == null || b == null) return null;
  return [L, Math.hypot(a, b), Math.atan2(b, a) * RAD2DEG];
}

/** [L,C,h] → トーングループ名。 */
function toneGroup(lch, cfg = TONE_CFG) {
  const [L, C, h] = lch;
  if (C > cfg.vivid_C_min) return 'ビビッド';
  if (C <= cfg.achromatic_C_max) return L < cfg.achromatic_L_split ? 'ダーク無彩' : 'ライト無彩';
  const [lo, hi] = cfg.warm_hue_range;
  return lo <= h && h <= hi ? 'アース' : 'クール';
}

/** 表示用トーン情報（読み取り専用）。 */
function toneInfo(item) {
  const cm = ((item && item.facts) || {}).color_measured || {};
  const clusters = cm.clusters || [];
  let domHex = null;
  if (clusters.length) {
    let top = clusters[0];
    for (const c of clusters) if ((c.ratio || 0) > (top.ratio || 0)) top = c;
    domHex = top.hex || null;
  }
  const lch = dominantLch(item);
  const info = {
    group: lch ? toneGroup(lch) : null,
    hex: domHex,
    confidence: cm.confidence || null,
    family_auto: cm.family_auto || [],
  };
  if (lch) {
    info.L = Math.round(lch[0] * 10) / 10;
    info.C = Math.round(lch[1] * 10) / 10;
    info.h = Math.round(lch[2] * 10) / 10;
  }
  return info;
}

/** 一覧表示用の軽量サマリ（item_browser.list_summary 相当）。 */
function listSummary(item) {
  const facts = item.facts || {};
  const cm = facts.color_measured || {};
  const tone = toneInfo(item);
  return {
    id: item.id,
    name: item.name,
    brand: item.brand,
    category: item.category,
    color: facts.color,
    color_family: facts.color_family || [],
    lineage: (facts.style || {}).lineage || [],
    tone: tone.group,
    tone_hex: tone.hex,
    date: (item.purchase || {}).date,
    price: (item.purchase || {}).price,
    satisfaction: (item.owner || {}).satisfaction,
    tier: (item.position || {}).tier,
    wear_count: (item.wear || {}).count || 0,
    image: cm.source_image,
  };
}

window.Tone = { TONE_CFG, CAT_ORDER, PURCHASE_TYPES, dominantLch, toneGroup, toneInfo, listSummary };
