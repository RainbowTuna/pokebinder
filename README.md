# PokéBinder

Scan Pokémon cards with your phone and keep them in digital binders with custom covers,
a wishlist, and checklists (every card of a Pokémon, or a whole set) – English and Japanese.

**Live site:** https://rainbowtuna.github.io/pokebinder/

- Card list, pictures & prices: TCGplayer's catalog via [TCGCSV](https://tcgcsv.com), rebuilt daily
  into `catalog/` by `tools/build_catalog.py` (GitHub Actions: `.github/workflows/catalog.yml`)
- Card reading (OCR): [Tesseract.js](https://tesseract.projectnaptha.com/), runs in the browser
- Login & sync: [Supabase](https://supabase.com) – set up with `supabase-setup.sql`
  (existing projects: also run `supabase-update-lists.sql`)

Run locally: double-click `start.bat` (needs Python), then open http://localhost:8000.
Rebuild the catalog by hand: `python tools/build_catalog.py --prices`.
