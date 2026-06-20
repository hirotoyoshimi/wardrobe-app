/* patch.js — 編集可能フィールドの定義と apply_patch の JS 移植。
 *
 * item_browser.apply_patch と同じく、人間が管理するフィールドのみを反映し、
 * 自動管理セクション（facts.color_measured / position / ai_assessment）は保全する。
 */
'use strict';

const EDITABLE = Object.freeze({
  top: ['name', 'brand', 'category'],
  facts: ['color', 'color_family', 'material', 'silhouette', 'collar_type',
    'details', 'season', 'scene', 'primary_flag', 'formal_adjacent',
    'condition', 'size_note'],
  purchase: ['date', 'price', 'channel', 'type', 'acquisition'],
  owner: ['satisfaction', 'liked_note', 'regret_note', 'usage_note'],
});

/**
 * patch（編集可能フィールドのみ）を既存 YAML オブジェクトにマージ。
 * 自動管理領域は patch に含まれないため保持される。data を破壊的に更新して返す。
 */
function applyPatch(data, patch) {
  for (const k of EDITABLE.top) {
    if (k in patch) data[k] = patch[k];
  }

  const facts = (data.facts = data.facts || {});
  const pf = patch.facts || {};
  for (const k of EDITABLE.facts) {
    if (k in pf) facts[k] = pf[k];
  }
  // style.lineage は facts.style の下にネスト
  if ('lineage' in pf) {
    const style = (facts.style = facts.style || {});
    style.lineage = pf.lineage;
  }

  for (const section of ['purchase', 'owner']) {
    const dst = (data[section] = data[section] || {});
    const src = patch[section] || {};
    for (const k of EDITABLE[section]) {
      if (k in src) dst[k] = src[k];
    }
  }
  return data;
}

window.Patch = { EDITABLE, applyPatch, newSkeleton };

/**
 * 新規アイテムの YAML スケルトンを生成。validate_items.py の必須要件を満たす
 * （必須トップキー、facts.color_family/season/scene はリスト、primary_flag は bool、
 * source_image=images/<id>.jpg）。色実測は空（confidence/extracted=null, clusters=[]）で、
 * トーンは「実測なし」。後でローカルの extract_colors.py が color_measured を確定する。
 * フィールド順は既存 items/*.yaml と揃える（js-yaml dump は sortKeys:false 前提）。
 */
function newSkeleton(f) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    id: f.id,
    name: f.name || '',
    brand: f.brand || '',
    category: f.category || '',
    facts: {
      style: { lineage: f.lineage || [] },
      color: f.color || '',
      color_measured: {
        source_image: `images/${f.id}.jpg`,
        extracted: null,
        clusters: [],
        family_auto: [],
        tone: null,
        confidence: null,
      },
      color_family: f.color_family || [],
      material: f.material || '',
      silhouette: f.silhouette || '',
      collar_type: f.collar_type || '',
      details: f.details || [],
      season: f.season || [],
      scene: f.scene || [],
      primary_flag: !!f.primary_flag,
      formal_adjacent: !!f.formal_adjacent,
      condition: f.condition || '',
      size_note: f.size_note || '',
    },
    purchase: {
      date: f.date || null,
      price: f.price == null ? null : f.price,
      channel: f.channel || '',
      type: f.type || null,
      acquisition: f.acquisition || '購入',
    },
    owner: {
      satisfaction: f.satisfaction == null ? null : f.satisfaction,
      liked_note: f.liked_note || '',
      regret_note: f.regret_note || '',
      usage_note: f.usage_note || '',
    },
    objective_note: {
      text: '',
      generated: null,
      verified: false,
    },
    ai_assessment: {
      generated: null,
      material_season_fit: '',
      structural_notes: '',
      versatility: '',
      style_fit: '',
    },
    wear: {
      count: 0,
      last_worn: null,
      log: [],
    },
    position: {
      updated: today,
      connected_cells: [],
      outfit_count: 0,
      tested_count: 0,
      tier: null,
    },
  };
}
