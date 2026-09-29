"""Build PokéBinder's card catalog from TCGCSV (a daily copy of TCGplayer's catalog).

Writes, into ../catalog/:
  sets.json              every English and Japanese set (id, name, code, release date, card count)
  cards-en.json / -ja    every single card (sealed products are skipped)
  prices-en.json / -ja   TCGplayer market price per card, in USD (only with --prices)

Card pictures are not downloaded; the app shows them from TCGplayer's image server.
TCGCSV asks for an identifiable User-Agent and a pause between requests: https://tcgcsv.com/faq
"""
import argparse
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

BASE = "https://tcgcsv.com/tcgplayer"
CATEGORIES = {"en": 3, "ja": 85}  # TCGplayer: Pokemon, Pokemon Japan
USER_AGENT = "PokeBinder catalog builder (+https://github.com/RainbowTuna/pokebinder)"
PAUSE = 0.25
OUT = Path(__file__).resolve().parent.parent / "catalog"

# "Umbreon VMAX - 095/069" → "Umbreon VMAX", "Lucario - 53/127 (Prerelease)" → "Lucario (Prerelease)"
NUMBER_SUFFIX = re.compile(r"\s+-\s+[A-Za-z]*\d+[A-Za-z]*(?:/[A-Za-z0-9\-]+)?(?=\s*(?:\(|\[|$))")
# "Umbreon (13)", "Umbreon (H29)" → "Umbreon" (TCGplayer's way of telling same-named cards apart)
NUMBER_LABEL = re.compile(r"\s+\([A-Za-z]{0,5}\d+[a-z]?\)$")
# "S6a: Eevee Heroes" → "Eevee Heroes" (the code is kept separately)
CODE_PREFIX = re.compile(r"^[A-Za-z0-9.\-]+:\s+")
PRICE_ORDER = ["Normal", "Holofoil", "Reverse Holofoil", "1st Edition Holofoil", "1st Edition", "Unlimited Holofoil", "Unlimited"]


def get(path, tries=4):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(f"{BASE}/{path}", headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.load(r)
            time.sleep(PAUSE)
            return data.get("results", [])
        except Exception as err:  # network hiccup – wait and retry
            if attempt == tries - 1:
                raise
            print(f"  retry {path}: {err}", file=sys.stderr)
            time.sleep(3 * (attempt + 1))


def extended(product):
    return {e["name"]: e["value"] for e in product.get("extendedData", [])}


def best_price(rows):
    by_type = {r["subTypeName"]: r for r in rows}
    for kind in PRICE_ORDER + sorted(by_type):
        row = by_type.get(kind)
        if row and (row.get("marketPrice") or row.get("midPrice")):
            return round(row.get("marketPrice") or row.get("midPrice"), 2)
    return None


def build(with_prices):
    OUT.mkdir(exist_ok=True)
    sets, rarities = [], []
    rarity_index = {}
    for lang, category in CATEGORIES.items():
        groups = sorted(get(f"{category}/groups"), key=lambda g: g.get("publishedOn") or "")
        rows, prices = [], {}
        print(f"{lang}: {len(groups)} sets", file=sys.stderr)
        for i, g in enumerate(groups, 1):
            products = get(f"{category}/{g['groupId']}/products")
            cards = []
            for p in products:
                ext = extended(p)
                number = ext.get("Number")
                if not number:  # booster boxes, packs, tins…
                    continue
                rarity = ext.get("Rarity") or ""
                if rarity not in rarity_index:
                    rarity_index[rarity] = len(rarities)
                    rarities.append(rarity)
                name = NUMBER_LABEL.sub("", NUMBER_SUFFIX.sub("", p["name"]).strip())
                cards.append([p["productId"], name, number, g["groupId"], rarity_index[rarity], 1 if p.get("imageCount") else 0])
            if not cards:
                continue
            if with_prices:
                singles = {c[0] for c in cards}
                by_product = {}
                for row in get(f"{category}/{g['groupId']}/prices"):
                    if row["productId"] not in singles:
                        continue
                    by_product.setdefault(row["productId"], []).append(row)
                for pid, price_rows in by_product.items():
                    price = best_price(price_rows)
                    if price is not None:
                        prices[pid] = price
            totals = sorted({n.split("/")[1] for n in (c[2] for c in cards) if "/" in n}, key=lambda t: (len(t), t))
            sets.append({
                "id": g["groupId"], "lang": lang,
                "name": CODE_PREFIX.sub("", g["name"]) if g.get("abbreviation") and g["name"].lower().startswith(g["abbreviation"].lower() + ":") else g["name"],
                "code": g.get("abbreviation") or "",
                "date": (g.get("publishedOn") or "")[:10],
                "cards": len(cards),
                "totals": totals[:4],
            })
            rows.extend(cards)
            if i % 25 == 0:
                print(f"  {lang} {i}/{len(groups)}", file=sys.stderr)
        write(f"cards-{lang}.json", {"fields": ["pid", "name", "number", "set", "rarity", "img"], "rows": rows})
        if with_prices:
            write(f"prices-{lang}.json", {str(k): v for k, v in prices.items()})
        print(f"{lang}: {len(rows)} cards", file=sys.stderr)
    write("sets.json", {"rarities": rarities, "sets": sets})


def write(name, data):
    (OUT / name).write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--prices", action="store_true", help="also refresh prices")
    build(parser.parse_args().prices)
