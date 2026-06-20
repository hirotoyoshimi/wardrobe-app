#!/usr/bin/env python3
"""ワードローブPWA用のアイコンを生成する。

チャコール地に淡色のハンガーを描いた素朴なアイコン。
PNG: 192 / 512 / 512(maskable, 安全余白付き) / 180(apple-touch)。
依存: Pillow。  実行: python3 scripts/gen_icons.py
"""
from __future__ import annotations

import os

from PIL import Image, ImageDraw

BG = (42, 42, 40)        # チャコール（manifest theme_color と一致）
FG = (236, 233, 226)     # 淡いオフホワイト
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(HERE, "icons")


def draw_hanger(size: int, pad_ratio: float) -> Image.Image:
    """size×size のアイコンを 4倍解像度で描いて縮小（簡易アンチエイリアス）。"""
    s = size * 4
    img = Image.new("RGBA", (s, s), BG + (255,))
    d = ImageDraw.Draw(img)

    pad = s * pad_ratio
    w = s - 2 * pad                      # 描画領域の一辺
    cx = s / 2
    top = pad + w * 0.16                 # フックの天辺
    shoulder = pad + w * 0.46            # 肩（三角の頂点）のy
    bar_y = pad + w * 0.74               # 横バーのy
    half = w * 0.40                      # バー半幅
    lw = max(2, int(w * 0.045))          # 線幅

    # フック（半円）
    r = w * 0.10
    d.arc([cx - r, top, cx + r, top + 2 * r], start=180, end=360, fill=FG, width=lw)
    d.line([cx, top + r, cx, shoulder], fill=FG, width=lw)

    # 三角（肩から左右のバー端へ）
    d.line([cx, shoulder, cx - half, bar_y], fill=FG, width=lw)
    d.line([cx, shoulder, cx + half, bar_y], fill=FG, width=lw)

    # 横バー
    d.line([cx - half, bar_y, cx + half, bar_y], fill=FG, width=lw)

    # 端の丸み
    for ex in (cx - half, cx + half):
        rr = lw / 2
        d.ellipse([ex - rr, bar_y - rr, ex + rr, bar_y + rr], fill=FG)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    specs = [
        ("icon-192.png", 192, 0.18, True),
        ("icon-512.png", 512, 0.18, True),
        ("icon-512-maskable.png", 512, 0.28, True),   # safe-zone 余白を多めに
        ("apple-touch-icon.png", 180, 0.16, False),   # iOSは自動で角丸＋背景必須
    ]
    for name, size, pad, has_alpha in specs:
        img = draw_hanger(size, pad)
        if not has_alpha:
            img = img.convert("RGB")
        img.save(os.path.join(OUT, name))
        print("wrote", name, size)


if __name__ == "__main__":
    main()
