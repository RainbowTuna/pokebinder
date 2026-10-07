
import * as store from './data.js?v=18';
import * as catalog from './catalog.js?v=18';
import { CARD_IMAGE_RELAY } from './config.js?v=18';
import { CHANGELOG } from './changelog.js?v=18';

const TARGET_KEY = 'pkbinder.target';
const LANG_KEY = 'pkbinder.lang';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Card ids: catalog cards are "tp:<TCGplayer product id>", cards added by hand "custom:<uuid>".
// Older versions used TCGdex ids ("sv03.5-025", "ja:SV2a-025"); those are upgraded once the catalog loads.
const isLegacy = id => !id.startsWith('tp:') && !id.startsWith('custom:');
const imgUrl = (card, size = 'low') => {
  const src = card.image || '';
  if (!src || src.startsWith('data:')) return src;
  if (src.includes('tcgplayer-cdn')) return size === 'high' ? src.replace('_200w', '_in_1000x1000') : src;
  return `${src}/${size}.webp`; // TCGdex picture (cards added before the catalog)
};
const hasJapanese = s => /[぀-ヿ一-鿿]/.test(s);

const ui = { tab: 'add', view: 'shelf', binderId: null, results: null, modal: null, lastQuery: null, lastScan: null, list: null };
let lang = localStorage.getItem(LANG_KEY) === 'ja' ? 'ja' : 'en';

let setsCache = null; // catalog sets, once loaded
const getSets = async () => (setsCache = await catalog.sets());
const langOfCard = c => c?.lang || setsCache?.byId.get(c?.setId)?.lang ||
  (String(c?.id).startsWith('ja:') || String(c?.setId).startsWith('custom:ja') ? 'ja' : 'en');

// Cards shown on screen that aren't in the catalog (older or hand-added ones), so tiles can open them.
const seen = new Map();
const remember = cards => cards.forEach(c => { if (!catalog.cardById(c.id)) seen.set(c.id, { ...seen.get(c.id), ...c }); });

const sameNumber = (a, b) => {
  const x = parseInt(a, 10), y = parseInt(b, 10);
  return (!isNaN(x) && x === y) || String(a).toLowerCase() === String(b).toLowerCase();
};
// "Flabébé ex" → "flabebe ex", for forgiving name matching.
const nameKey = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// The catalog uses English names, even for Japanese cards: "ルカリオ" → "Lucario" (via TCGdex's Pokédex numbers).
const nameCache = new Map();
function englishName(jp) {
  if (!nameCache.has(jp)) {
    nameCache.set(jp, (async () => {
      const get = path => fetch(`https://api.tcgdex.net/v2${path}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
      const hits = await get('/ja/cards?' + new URLSearchParams({ name: jp }));
      if (!hits?.length) return '';
      const dex = (await get(`/ja/cards/${encodeURIComponent(hits[0].id)}`))?.dexId?.[0];
      if (!dex) return '';
      const en = await get(`/en/cards?dexId=eq:${dex}`);
      return (en || []).map(c => c.name).sort((a, b) => a.length - b.length)[0] || '';
    })());
  }
  return nameCache.get(jp);
}

/**
 * Find cards in the catalog.
 * names: possible card names (read off the card or typed), number: collector number ("25"),
 * total: printed set size ("165"), setCode: set read off the card ("g23637").
 */
async function findCards({ names = [], number = '', total = '', setCode = '', language = 'en' }) {
  const pool = await catalog.cards(language);
  await getSets();
  const keys = (await Promise.all(names.map(n => (hasJapanese(n) ? englishName(n) : n))))
    .filter(Boolean).map(nameKey).filter(k => k.length >= 2);
  const nameOk = c => !keys.length || keys.some(k => nameKey(c.name).includes(k));
  const numOk = c => !number || sameNumber(c.localId, number);
  const totalOk = c => !total || sameNumber(c.total, total);
  const nearTotal = c => !!total && !!c.total && String(+c.total).length === String(+total).length &&
    editDistance(String(+c.total), String(+total)) <= 1;

  let results = [];
  if (setCode && number) results = pool.filter(c => c.setId === setCode && numOk(c));
  if (!results.length && (keys.length || number)) results = pool.filter(c => nameOk(c) && numOk(c) && totalOk(c));
  if (!results.length && number && total) results = pool.filter(c => nameOk(c) && numOk(c) && nearTotal(c)); // set size one digit off
  if (!results.length && keys.length && number) results = pool.filter(c => nameOk(c) && numOk(c)); // set size misread
  if (!results.length && keys.length && number) results = pool.filter(nameOk); // number misread

  const exact = new Set(keys);
  const score = c => (setCode && c.setId === setCode ? 8 : 0) + (exact.has(nameKey(c.name)) ? 2 : 0) + (c.image ? 1 : 0);
  // Ties: the plain card ("Pikachu") before special versions ("Pikachu (Pokemon Together)").
  const variant = c => (/[([]/.test(c.name) ? 1 : 0);
  return results.map((c, i) => [c, score(c), i])
    .sort((a, b) => b[1] - a[1] || variant(a[0]) - variant(b[0]) || a[2] - b[2])
    .map(x => x[0]).slice(0, 150);
}

// ---------- OCR ----------
const workers = new Map();
// 'eng' reads whole cards; 'num' only reads set codes and numbers (letters, digits, "/"),
// which makes it much less likely to misread "105/190" as "505/100".
function getWorker(kind = 'eng') {
  if (!workers.has(kind)) {
    workers.set(kind, (async () => {
      const w = await Tesseract.createWorker('eng', 1, {
        logger: m => { if (m.status?.startsWith('loading')) status('Loading text reader (first time only)…'); },
      });
      if (kind === 'num') {
        await w.setParameters({
          tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/.- ',
          tessedit_pageseg_mode: '6',
        });
      }
      return w;
    })());
  }
  return workers.get(kind);
}

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]++;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

const STOP = new Set(('basic stage evolves from put this card onto hp pokemon pokémon trainer item supporter ' +
  'stadium energy tool ability weakness resistance retreat illus ex gx vmax vstar tera mega break prism star').split(' '));

function parseOcr(data, height) {
  const text = data.text || '';
  // Collector number, e.g. "025/165". Fix common OCR mix-ups (O→0, l/I→1).
  let number = '', total = '';
  const fix = s => s.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1');
  const slash = [...text.matchAll(/([0-9OoIl|]{1,3})\s*[\/⁄]\s*([0-9OoIl|]{2,3})\b/g)];
  const special = text.match(/\b((?:TG|GG|SV|RC)\d{1,3})\s*\/\s*(?:TG|GG|SV|RC)?\d{1,3}\b/);
  if (slash.length) {
    const m = slash[slash.length - 1]; // the number is printed near the bottom
    number = String(parseInt(fix(m[1]), 10));
    total = String(parseInt(fix(m[2]), 10));
  } else if (special) {
    number = special[1];
  }

  // Name: biggest words in the top part of the card.
  const words = (data.words || [])
    .filter(w => w.bbox.y0 < height * 0.3 && w.confidence > 40)
    .map(w => ({ t: w.text.replace(/[^A-Za-zÀ-ÿ'.\-]/g, ''), size: w.bbox.y1 - w.bbox.y0 }))
    .filter(w => w.t.length >= 3 && !STOP.has(w.t.toLowerCase()));
  words.sort((a, b) => b.size - a.size);
  const names = [...new Set(words.map(w => w.t))].slice(0, 3);
  return { names, number, total };
}

// Small text reads better enlarged and in high contrast, so OCR crops of the card.
const bottomStrip = (src, mode) => enhancedCrop(src, 0, 0.86, 1, 1, 2400, mode); // collector number
const leftBottomStrip = (src, mode) => enhancedCrop(src, 0, 0.88, 0.5, 0.99, 1800, mode); // set code + number, bottom left
const tallLeftStrip = (src, mode) => enhancedCrop(src, 0, 0.83, 0.6, 0.97, 1800, mode); // same, if the card sits a little high

/**
 * Read everything useful off a card: name words (English), and every "number/size" and set code
 * the text reader can find. Nothing is trusted on its own – matchScan() checks it all against
 * the card list. framed: the picture is just the card (camera frame), so skip the slow
 * whole-picture read and look straight at the name and number areas.
 */
async function readCard(canvas, language, framed) {
  const texts = [];
  let names = [];
  const eng = await getWorker('eng');
  const num = await getWorker('num');
  if (!framed) {
    // A photo: the card could be anywhere, so read the whole thing and zoom in on the number.
    status('Reading card…');
    const { data } = await eng.recognize(canvas);
    texts.push({ text: data.text, w: 1 });
    if (language === 'en') names = parseOcr(data, canvas.height).names;
    const hit = (data.words || []).find(w => /[0-9Oo]{1,3}\s*\/\s*[0-9Oo]{2,3}/.test(w.text));
    if (hit) {
      const h = Math.max(8, hit.bbox.y1 - hit.bbox.y0);
      const box = [
        Math.max(0, hit.bbox.x0 - h * 14) / canvas.width, Math.max(0, hit.bbox.y0 - h * 1.3) / canvas.height,
        Math.min(canvas.width, hit.bbox.x1 + h * 3) / canvas.width, Math.min(canvas.height, hit.bbox.y1 + h * 1.3) / canvas.height,
      ];
      for (const mode of ['contrast', 'threshold']) texts.push({ text: (await num.recognize(enhancedCrop(canvas, ...box, 1800, mode))).data.text, w: 3 });
    }
  } else if (language === 'en') {
    status('Reading name…');
    names = nameWordsFrom((await eng.recognize(enhancedCrop(canvas, 0.04, 0.02, 0.8, 0.12, 1400))).data.text);
  }
  status('Reading card number…');
  const strips = language === 'ja' ? [leftBottomStrip, bottomStrip, tallLeftStrip] : [bottomStrip, leftBottomStrip];
  for (const strip of strips) {
    for (const mode of ['contrast', 'threshold']) texts.push({ text: (await num.recognize(strip(canvas, mode))).data.text, w: 2 });
  }
  return { texts, names };
}

const nameWordsFrom = text => [...new Set(text.split(/\s+/)
  .map(w => w.replace(/[^A-Za-zÀ-ÿ'.\-]/g, ''))
  .filter(w => w.length >= 3 && !STOP.has(w.toLowerCase())))].slice(0, 5);

// ---------- matching a scan against the card list ----------
// Look-alike characters the text reader mixes up count as half a mistake.
const LOOKALIKE = new Set(['0o', '08', '0d', '06', '09', '0a', 'oa', '1l', '1i', '17', '1|', 'il', '2z', '5s', '56', '38', '3e', '8b', '69', '4a']
  .flatMap(p => [p, p[1] + p[0]]));
function fuzzyDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]++;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      const sub = a[i - 1] === b[j - 1] ? 0 : LOOKALIKE.has(a[i - 1] + b[j - 1]) ? 0.5 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + sub);
      prev = cur;
    }
  }
  return row[b.length];
}

// "O25" → "25", "l05" → "105": digits-looking letters become digits (unless it's a prefix like "TG05").
function cleanNumber(s) {
  let t = s.toLowerCase();
  const m = t.match(/^([a-z]{2,})(.*)$/);
  const prefix = m && !/^[oidlqsbz|]+$/.test(m[1]) ? m[1] : '';
  let rest = prefix ? m[2] : t;
  rest = rest.replace(/[odq]/g, '0').replace(/[il|]/g, '1').replace(/z/g, '2').replace(/s/g, '5').replace(/b/g, '8');
  return prefix + (rest.replace(/^0+(?=.)/, ''));
}
const plainNumber = s => String(s).toLowerCase().replace(/^([a-z]*)0+(?=\d)/, '$1');

/** Score every card in the list against what was read; best matches first. */
async function matchScan({ texts, names, language }) {
  const [pool, sets] = await Promise.all([catalog.cards(language), getSets()]);

  // Every "number/size" pair in every reading, weighted by how much we trust that reading.
  const pairs = new Map();
  for (const { text, w } of texts) {
    for (const m of text.matchAll(/([0-9A-Za-z|]{1,5})\s*[\/⁄]\s*([0-9A-Za-z|]{2,5})/g)) {
      const n = cleanNumber(m[1]), t = cleanNumber(m[2]);
      if (!/\d/.test(n) || !/\d/.test(t)) continue;
      const key = `${n}/${t}`;
      pairs.set(key, { n, t, w: (pairs.get(key)?.w || 0) + w });
    }
  }
  const readings = [...pairs.values()];
  // Loose 2–3 digit groups (the "/" didn't come through, e.g. "orz172"): weak evidence.
  const groups = new Map();
  for (const { text, w } of texts) {
    for (const g of text.split(/[^0-9A-Za-z|]+/).map(cleanNumber)) {
      if (/^\d{2,3}$/.test(g)) groups.set(g, (groups.get(g) || 0) + w);
    }
  }

  // Set codes printed on the card ("SV4a", "MEW").
  const tokens = new Set(texts.flatMap(({ text }) => text.split(/[^A-Za-z0-9.\-]+/))
    .filter(t => t.length >= 2 && t.length <= 7 && /[a-z]/i.test(t)).map(t => t.toLowerCase()));
  const codeScore = new Map();
  for (const s of language === 'ja' ? sets.ja : sets.en) {
    const code = s.code.toLowerCase();
    if (!code) continue;
    // Short codes ("LL") turn up by accident in misread text, so they need a digit to count.
    if (tokens.has(code) && (code.length >= 3 || /\d/.test(code))) codeScore.set(s.id, 5);
    // Longer Japanese codes misread by one character: "svda" for "SV4a".
    else if (code.length >= 4 && /\d/.test(code) && [...tokens].some(t => t.length === code.length && fuzzyDistance(t, code) <= 1)) codeScore.set(s.id, 2.5);
  }

  const words = names.map(n => nameKey(n)).flatMap(n => n.split(' ')).filter(w => w.length >= 3 && !STOP.has(w));
  const nameMemo = new Map();
  const nameScore = name => {
    if (!words.length) return 0;
    if (!nameMemo.has(name)) {
      const parts = nameKey(name).split(' ');
      nameMemo.set(name, parts.some(p => words.includes(p)) ? 6
        : parts.some(p => p.length >= 5 && words.some(w => w.length >= 5 && fuzzyDistance(p, w) <= 1)) ? 4 : 0);
    }
    return nameMemo.get(name);
  };

  const numMemo = new Map();
  const closeness = (a, b, exact, near, far) => {
    const key = `${a}|${b}`;
    if (!numMemo.has(key)) {
      const d = fuzzyDistance(a, b);
      numMemo.set(key, d === 0 ? exact : d <= 0.5 ? near : d <= 1 && a.length >= 2 ? far : 0);
    }
    return numMemo.get(key);
  };

  const scored = [];
  for (const card of pool) {
    const id = plainNumber(card.localId), total = plainNumber(card.total);
    let s = 0;
    for (const r of readings) {
      const ns = closeness(id, r.n, 3, 2.2, 1.2);
      if (ns) s += (ns + (total ? closeness(total, r.t, 2, 1.4, 0.8) : 0)) * r.w;
    }
    const loose = (groups.get(id) || 0) * 0.6 + (total ? (groups.get(total) || 0) * 0.4 : 0);
    const name = nameScore(card.name);
    // The set code only helps a card whose number also fits.
    const code = s || groups.has(id) ? codeScore.get(card.setId) || 0 : 0;
    if (!s && !name && !code) continue;
    s += loose;
    s += name * 2 + code * 2;
    scored.push([card, s]);
  }
  const variant = c => (/[([]/.test(c.name) ? 1 : 0);
  scored.sort((a, b) => b[1] - a[1] || variant(a[0]) - variant(b[0]) || b[0].pid - a[0].pid);  return scored.slice(0, 40).map(([card, score]) => ({ card, score }));
}

// ---------- picture check ----------
// The text reading gives a shortlist; then the scan is compared with each shortlisted card's
// picture (fetched through the relay, since TCGplayer's image server doesn't let pages read
// pixels) and the one that looks most alike wins. Fingerprint = a tiny greyscale version of
// the whole card (layout, artwork shapes) + the colours of the artwork.
const RELAY = location.hostname === 'localhost' ? '/card-image' : CARD_IMAGE_RELAY;
const GW = 16, GH = 22; // greyscale fingerprint size (card-shaped)
const ART = [0.08, 0.1, 0.92, 0.5]; // artwork box on most cards: x0, y0, x1, y1

function fingerprint(src, width, height, inset = 0) {
  const x0 = width * inset, y0 = height * inset, w = width * (1 - 2 * inset), h = height * (1 - 2 * inset);
  const c = document.createElement('canvas');
  c.width = GW; c.height = GH;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, x0, y0, w, h, 0, 0, GW, GH);
  const px = ctx.getImageData(0, 0, GW, GH).data;
  const grey = new Float32Array(GW * GH);
  let mean = 0;
  for (let i = 0; i < grey.length; i++) { grey[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]; mean += grey[i]; }
  mean /= grey.length;
  let sd = 0;
  for (let i = 0; i < grey.length; i++) { grey[i] -= mean; sd += grey[i] ** 2; }
  sd = Math.sqrt(sd / grey.length) || 1;
  for (let i = 0; i < grey.length; i++) grey[i] /= sd;

  const AW = 24, AH = 14;
  c.width = AW; c.height = AH;
  ctx.drawImage(src, x0 + w * ART[0], y0 + h * ART[1], w * (ART[2] - ART[0]), h * (ART[3] - ART[1]), 0, 0, AW, AH);
  const art = ctx.getImageData(0, 0, AW, AH).data;
  const hist = new Float32Array(64); // 4×4×4 colour bins
  for (let i = 0; i < art.length; i += 4) hist[(art[i] >> 6) * 16 + (art[i + 1] >> 6) * 4 + (art[i + 2] >> 6)] += 1 / (AW * AH);
  return { grey, hist };
}

function likeness(a, b) {
  let ncc = 0;
  for (let i = 0; i < a.grey.length; i++) ncc += a.grey[i] * b.grey[i];
  ncc /= a.grey.length; // -1…1
  let overlap = 0;
  for (let i = 0; i < 64; i++) overlap += Math.min(a.hist[i], b.hist[i]); // 0…1
  return 0.65 * (ncc + 1) / 2 + 0.35 * overlap;
}

const printCache = new Map();
function cardPrint(card) {
  if (!printCache.has(card.pid)) {
    printCache.set(card.pid, (async () => {
      const r = await fetch(`${RELAY}?pid=${card.pid}`);
      if (!r.ok) throw new Error(`picture relay ${r.status}`);
      const bmp = await createImageBitmap(await r.blob());
      const print = fingerprint(bmp, bmp.width, bmp.height);
      bmp.close();
      return print;
    })().catch(err => { printCache.delete(card.pid); throw err; }));
  }
  return printCache.get(card.pid);
}

/** Re-rank text matches by how much each card's picture looks like the scan. */
async function pictureCheck(canvas, matches) {
  const shortlist = matches.filter(m => m.card.image).slice(0, 24);
  if (shortlist.length < 2) return null;
  status('Comparing pictures…');
  // The camera frame leaves a little table around the card: try a few crops, keep the best.
  const scans = [0, 0.03, 0.06].map(inset => fingerprint(canvas, canvas.width, canvas.height, inset));
  const prints = [];
  for (let i = 0; i < shortlist.length; i += 8) { // a few at a time
    prints.push(...await Promise.all(shortlist.slice(i, i + 8).map(m => cardPrint(m.card).catch(() => null))));
    if (i === 0 && prints.every(p => !p)) return null; // relay not set up / offline: keep the text ranking
  }
  const top = Math.max(...shortlist.map(m => m.score)) || 1;
  const ranked = shortlist.map((m, i) => {
    const look = prints[i] ? Math.max(...scans.map(s => likeness(s, prints[i]))) : 0;
    return { ...m, look, final: 0.35 * (m.score / top) + 0.65 * look };
  }).sort((a, b) => b.final - a.final);
  // Special versions ("Pikachu (Poke Ball Pattern)", "(Mirror Holofoil)") look almost the same as
  // the regular card; unless one clearly looks more alike, put the regular card first.
  const baseName = c => c.name.replace(/\s*[([].*$/, '');
  const plain = ranked.findIndex(m => !/[([]/.test(m.card.name) && m.card.setId === ranked[0].card.setId &&
    m.card.number === ranked[0].card.number && baseName(m.card) === baseName(ranked[0].card));
  if (plain > 0 && ranked[0].final - ranked[plain].final < 0.04) ranked.unshift(...ranked.splice(plain, 1));
  const rest = matches.filter(m => !shortlist.includes(m));
  // Sure = clearly ahead of the next *different* card (other versions of the same card don't count).
  const sameCard = m => m.card.number === ranked[0].card.number && baseName(m.card) === baseName(ranked[0].card);
  const runnerUp = ranked.slice(1).find(m => !sameCard(m));
  const sure = ranked[0].look >= 0.62 && ranked[0].final - (runnerUp?.final ?? 0) >= 0.05;
  return { matches: [...ranked, ...rest], sure };
}

// mode 'contrast': grey with boosted contrast; 'threshold': pure black & white (helps with glare).
function enhancedCrop(src, x0, y0, x1, y1, width, mode = 'contrast') {
  const sx = Math.round(src.width * x0), sy = Math.round(src.height * y0);
  const sw = Math.max(1, Math.round(src.width * x1) - sx), sh = Math.max(1, Math.round(src.height * y1) - sy);
  const scale = Math.max(1, width / sw);
  const c = document.createElement('canvas');
  c.width = Math.round(sw * scale);
  c.height = Math.round(sh * scale);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const grey = new Uint8ClampedArray(d.length / 4);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) grey[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  const cut = mode === 'threshold' ? otsu(grey) : 0;
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const v = mode === 'threshold' ? (grey[j] > cut ? 255 : 0) : (grey[j] - 128) * 1.8 + 128;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// Otsu's method: the grey level that best splits text from background.
function otsu(grey) {
  const hist = new Array(256).fill(0);
  for (const g of grey) hist[g]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, cut = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = grey.length - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; cut = t; }
  }
  return cut;
}

// Decode a photo onto a canvas no bigger than maxSide (phone photos are huge).
async function fileToCanvas(file, maxSide) {
  const img = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  img.close();
  return canvas;
}

// ---------- add cards tab ----------
function status(msg, isError = false) {
  const el = $('#scan-status');
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

const targetBinder = () => store.binder(localStorage.getItem(TARGET_KEY)) || store.binders()[0];
function renderTarget() {
  const t = targetBinder();
  $('#target').innerHTML = store.binders()
    .map(b => `<option value="${esc(b.id)}"${b.id === t?.id ? ' selected' : ''}>${esc(b.name)}</option>`).join('');
}
$('#target').addEventListener('change', e => localStorage.setItem(TARGET_KEY, e.target.value));

$('#photo').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    await scanCanvas(await fileToCanvas(file, 1600), URL.createObjectURL(file));
  } catch (err) {
    console.error(err);
    status(`Something went wrong: ${err.message}`, true);
  }
});

async function scanCanvas(canvas, previewUrl, framed = false) {
  ui.lastScan = canvas;
  $('#preview').src = previewUrl;
  $('.preview-wrap').hidden = false;
  $('#results-head').textContent = '';
  $('#results').innerHTML = '';
  const language = lang;
  const read = await readCard(canvas, language, framed);
  status('Checking the card list…');
  let matches = await matchScan({ ...read, language });
  // Compare pictures when the scan is just the card (camera frame, or a photo cropped to the card).
  const cardShaped = framed || Math.abs(canvas.width / canvas.height - 63 / 88) < 0.08;
  const checked = cardShaped && matches.length > 1 ? await pictureCheck(canvas, matches).catch(() => null) : null;
  if (checked) matches = checked.matches;
  if (!matches.length) {
    status(language === 'ja'
      ? "Couldn't read the card. Try again closer, with less glare on the bottom-left corner (e.g. “SV4a 065/190”) – or type it below."
      : "Couldn't read the card. Try again closer, with less glare – or type the name below.", true);
    return;
  }
  const best = matches[0].card;
  const code = setsCache?.byId.get(best.setId)?.code;
  $('#q-name').value = language === 'en' ? best.name : '';
  $('#q-number').value = [code, best.number].filter(Boolean).join(' ');
  // Clear winner, or a few close ones for you to choose from?
  const sure = checked ? checked.sure : matches.length === 1 || matches[0].score >= matches[1].score * 1.5;
  status(sure
    ? `Best match: ${best.name} · ${[code, best.number].filter(Boolean).join(' ')}. Tap it to add, or pick another below.`
    : `Closest matches from the card list – tap yours. Not there? Fix the number below and press Find.`);
  ui.lastQuery = { names: read.names, language, scan: true };
  ui.results = matches.map(m => m.card);
  ui.bestId = sure ? best.id : null;
  renderResults();
}

// ---------- live camera with a card-shaped frame ----------
// Capturing only what's inside the frame means the card fills the picture, so the
// number is always in the bottom corner where the reader looks for it.
let camStream = null;

$('#scan-btn').addEventListener('click', async () => {
  if (!navigator.mediaDevices?.getUserMedia) return $('#photo').click();
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
    });
  } catch {
    toast('Camera not available – choose a photo instead');
    return $('#photo').click();
  }
  const video = $('#cam-video');
  video.srcObject = camStream;
  $('#camera').hidden = false;
  document.body.classList.add('camera-open');
  $('#cam-corner').classList.toggle('right', lang !== 'ja');
  const track = camStream.getVideoTracks()[0];
  try { await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch {}
  $('#cam-torch').hidden = !track.getCapabilities?.().torch;
  await video.play().catch(() => {});
});

function closeCamera() {
  camStream?.getTracks().forEach(t => t.stop());
  camStream = null;
  $('#cam-video').srcObject = null;
  $('#camera').hidden = true;
  document.body.classList.remove('camera-open');
}
$('#cam-close').addEventListener('click', closeCamera);

let torchOn = false;
$('#cam-torch').addEventListener('click', async () => {
  torchOn = !torchOn;
  try { await camStream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: torchOn }] }); } catch {}
});

$('#cam-shoot').addEventListener('click', async () => {
  const canvas = captureFrame();
  if (!canvas) return toast('Camera is still starting – try again');
  closeCamera();
  window.scrollTo(0, 0);
  try {
    await scanCanvas(canvas, canvas.toDataURL('image/jpeg', 0.8), true);
  } catch (err) {
    console.error(err);
    status(`Something went wrong: ${err.message}`, true);
  }
});

// Copy the part of the video that's inside the on-screen frame (the video fills the screen
// with object-fit: cover, so screen positions have to be mapped back to video pixels).
function captureFrame() {
  const video = $('#cam-video');
  if (!video.videoWidth) return null;
  const vr = video.getBoundingClientRect();
  const fr = $('#cam-frame').getBoundingClientRect();
  const scale = Math.max(vr.width / video.videoWidth, vr.height / video.videoHeight);
  const offX = (vr.width - video.videoWidth * scale) / 2;
  const offY = (vr.height - video.videoHeight * scale) / 2;
  const sx = Math.max(0, (fr.left - vr.left - offX) / scale);
  const sy = Math.max(0, (fr.top - vr.top - offY) / scale);
  const sw = Math.min(video.videoWidth - sx, fr.width / scale);
  const sh = Math.min(video.videoHeight - sy, fr.height / scale);
  const up = Math.max(1, 1100 / sh); // small video frames read better enlarged
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw * up);
  canvas.height = Math.round(sh * up);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  // A camera that's still starting up gives black frames – don't try to read those.
  const probe = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let bright = 0;
  for (let i = 0; i < probe.length; i += 4 * 97) bright = Math.max(bright, probe[i] + probe[i + 1] + probe[i + 2]);
  return bright > 60 ? canvas : null;
}

$('#search-form').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('#q-name').value.trim();
  let numberText = $('#q-number').value.trim();
  let setCode = '';
  // "SV4a 065/190" or "MEW 025/165" – a set code before the number pins down the card.
  const m = numberText.match(/^([A-Za-z][A-Za-z0-9.\-]*)\s+(\S+)$/);
  if (m) {
    const set = (await getSets().catch(() => null))?.byCode[lang].get(m[1].toLowerCase());
    if (set) { setCode = set.id; numberText = m[2]; }
  }
  const [number = '', total = ''] = numberText.split('/').map(s => s.trim().replace(/^0+(?=\d)/, ''));
  if (!name && !number) return;
  runSearch({ names: name ? [name] : [], number, total, setCode, language: lang });
});

// EN / JP switch
function renderLang() {
  $$('[data-lang]').forEach(b => b.classList.toggle('on', b.dataset.lang === lang));
  $('#q-name').placeholder = lang === 'ja' ? 'Search Japanese cards' : 'Search cards';
  $('#q-number').placeholder = lang === 'ja' ? 'SV4a 065' : 'No.';
}
$$('[data-lang]').forEach(b => b.addEventListener('click', () => {
  lang = b.dataset.lang;
  localStorage.setItem(LANG_KEY, lang);
  renderLang();
  if (ui.lastQuery && ($('#q-name').value.trim() || $('#q-number').value.trim())) $('#search-form').requestSubmit();
}));

async function runSearch(q) {
  $('#results-head').textContent = 'Searching…';
  $('#results').innerHTML = '';
  ui.results = null;
  ui.bestId = null;
  ui.lastQuery = q;
  try {
    const results = await findCards(q);
    if (ui.lastQuery !== q) return; // a newer search started meanwhile
    ui.results = results;
    renderResults();
  } catch (err) {
    if (ui.lastQuery === q) $('#results-head').textContent = `Search failed: ${err.message}`;
  }
}

function renderResults() {
  if (!ui.results) return;
  $('#results-head').innerHTML = (ui.results.length
    ? ui.lastQuery?.scan ? 'Best matches from the card list:'
    : `Tap the card that matches yours${ui.results.length >= 150 ? ' (first 150 – add a number to narrow it down)' : ''}:`
    : `No matches. Check the spelling, try just the name, or switch between English and Japanese cards.`) +
    ` <button class="linkish" id="manual-add">Can't find it? Add it yourself</button>`;
  $('#results').innerHTML = ui.results.map(c => tile(c, { showSet: true, best: c.id === ui.bestId })).join('');
}

// ---------- add a card by hand (for cards missing from the database) ----------
$('#results-head').addEventListener('click', e => { if (e.target.id === 'manual-add') openManual(); });

function openManual() {
  const q = ui.lastQuery || {};
  const set = q.setCode ? setsCache?.byId.get(q.setCode) : null;
  const target = targetBinder();
  ui.modal = { type: 'manual', photo: ui.lastScan ? scanThumb(ui.lastScan) : null };
  $('#modal-body').innerHTML = `<form class="manual" data-manual>
    <h3>Add a card yourself</h3>
    <p class="meta">For the rare card that isn't in the card list (some promos and very old cards).</p>
    <div class="manual-photo" id="manual-photo"></div>
    <label class="chip" for="manual-file">📷 ${ui.modal.photo ? 'Use a different photo' : 'Add a photo'}</label>
    <input type="file" id="manual-file" accept="image/*" capture="environment" hidden>
    <label class="editor-label" for="m-name">Card name</label>
    <input id="m-name" required maxlength="60" value="${esc($('#q-name').value)}">
    <div class="manual-row">
      <div><label class="editor-label" for="m-set">Set</label>
        <input id="m-set" maxlength="60" placeholder="${lang === 'ja' ? 'e.g. SV2a' : 'e.g. Base Set'}" value="${esc(set ? set.label : '')}"></div>
      <div><label class="editor-label" for="m-number">Number</label>
        <input id="m-number" maxlength="12" placeholder="025/165" value="${esc($('#q-number').value)}"></div>
    </div>
    <label class="editor-label" for="m-lang">Language</label>
    <select id="m-lang"><option value="ja"${lang === 'ja' ? ' selected' : ''}>🇯🇵 Japanese</option><option value="en"${lang === 'en' ? ' selected' : ''}>🇬🇧 English</option><option value="other">Other</option></select>
    <label class="editor-label" for="m-binder">Binder</label>
    <select id="m-binder">${store.binders().map(b => `<option value="${esc(b.id)}"${b.id === target?.id ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}</select>
    <div class="editor-actions"><span></span><button class="btn primary">Add to binder</button></div>
  </form>`;
  drawManualPhoto();
  showModal();
}

// A small JPEG of the scan to use as the card's picture (~15 KB, syncs quickly).
function scanThumb(canvas) {
  const scale = Math.min(1, 320 / canvas.width);
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * scale);
  c.height = Math.round(canvas.height * scale);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.75);
}

function drawManualPhoto() {
  $('#manual-photo').innerHTML = ui.modal.photo ? `<img src="${ui.modal.photo}" alt="Card photo">` : '<span>No photo</span>';
}

$('#modal-body').addEventListener('change', async e => {
  if (ui.modal?.type !== 'manual' || e.target.id !== 'manual-file') return;
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try { ui.modal.photo = scanThumb(await fileToCanvas(file, 1200)); drawManualPhoto(); }
  catch { toast("Couldn't open that photo"); }
});

$('#modal-body').addEventListener('submit', e => {
  if (!e.target.matches('[data-manual]')) return;
  e.preventDefault();
  const setText = $('#m-set').value.trim() || 'Other cards';
  const language = $('#m-lang').value;
  const card = {
    id: `custom:${crypto.randomUUID?.() || Date.now().toString(36) + Math.random().toString(36).slice(2)}`,
    name: $('#m-name').value.trim(),
    localId: $('#m-number').value.trim().split('/')[0] || '—',
    image: ui.modal.photo || '',
    setId: `custom:${language}:${setText.toLowerCase()}`,
    setName: `${language === 'ja' ? '🇯🇵 ' : ''}${setText}`,
  };
  const binderId = $('#m-binder').value;
  localStorage.setItem(TARGET_KEY, binderId);
  store.setQty(binderId, card, 1);
  $('#modal').close();
  toast(`Added ${card.name} to ${store.binder(binderId).name}`);
});

// ---------- grades & prices ----------
// Grading scales, best first. PSA and ARS use whole grades; BGS, CGC and SGC go in half steps;
// TAG has half steps except between 9 and 10.
const steps = (hi, lo, step) => Array.from({ length: Math.round((hi - lo) / step) + 1 }, (_, i) => String(+(hi - i * step).toFixed(1)));
const GRADERS = {
  PSA: steps(10, 1, 1),
  BGS: ['10 Black Label', '10 Pristine', ...steps(9.5, 1, 0.5)],
  CGC: ['10 Pristine', '10', ...steps(9.5, 1, 0.5)],
  SGC: ['10 Pristine', '10', ...steps(9.5, 1, 0.5)],
  TAG: ['10 Pristine', '10', ...steps(9, 1, 0.5)],
  ARS: ['10+', ...steps(10, 1, 1)],
};
const CERT_LINKS = {
  PSA: c => `https://www.psacard.com/cert/${encodeURIComponent(c)}`,
  CGC: c => `https://www.cgccards.com/certlookup/${encodeURIComponent(c)}/`,
};
const CUR_KEY = 'pkbinder.currency';
const money = (amount, cur) => (cur === 'USD'
  ? `$${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  : `฿${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
const gradeLabel = copy => (copy.grader ? `${copy.grader} ${copy.grade}` : 'Raw');
// "10 Black Label" / "10 Pristine" / "10+" rank just above a plain 10.
const gradeValue = copy => parseFloat(copy.grade) + (/[a-z+]/i.test(copy.grade) ? 0.25 : 0);
function bestGrade(cardId) {
  const graded = store.copiesOf(cardId).map(x => x.copy).filter(c => c.grader);
  if (!graded.length) return '';
  return gradeLabel(graded.sort((a, b) => gradeValue(b) - gradeValue(a))[0]).replace(/ (Black Label|Pristine)$/, ' ★');
}

// ---------- tiles & card modal ----------
// qty: number on the badge (defaults to copies across all binders); missing: grey out if not owned;
// showSet: label with the set code too, for lists that mix sets; addTo: binder the ＋ button adds to.
function tile(card, { qty = store.ownedTotal(card.id), missing = false, times = false, showSet = false, best = false, addTo = '', inert = false } = {}) {
  const src = imgUrl(card);
  const code = showSet ? setsCache?.byId.get(card.setId)?.code : '';
  const graded = qty ? bestGrade(card.id) : '';
  // The ＋ becomes "− n +" once the card is in the binder it adds to.
  const into = store.binder(addTo) || targetBinder();
  const here = into ? store.ownedTotal(card.id, into.id) : 0;
  const id = esc(card.id), bid = esc(into?.id || '');
  const opens = inert ? '' : ` role="button" tabindex="0" data-card="${esc(card.id)}"`;
  return `<div class="tile${missing && !qty ? ' missing' : ''}${best ? ' best' : ''}"${opens} title="${esc(card.name)}">
    ${src ? `<img src="${esc(src)}" alt="${esc(card.name)}" loading="lazy">` : `<span class="noimg"><b>${esc(card.name)}</b><small>No picture yet</small></span>`}
    ${qty && qty !== here ? `<span class="badge">${times ? '×' : '✓ '}${qty}</span>` : ''}
    ${graded ? `<span class="grade-tag">${esc(graded)}</span>` : ''}
    ${store.wanted(card.id) ? '<span class="want-tag" title="On your wishlist">★</span>' : ''}
    <span class="num">${langOfCard(card) === 'ja' ? '<i class="jp">JP</i>' : ''}${esc([code, card.localId].filter(Boolean).join(' '))}</span>
    ${inert ? '' : here
      ? `<div class="quick-step" title="Copies in ${esc(into.name)}">
          <button data-quick-dec="${id}" data-binder="${bid}" aria-label="Remove one from ${esc(into.name)}">−</button>
          <b>${here}</b>
          <button data-quick="${id}" data-binder="${bid}" aria-label="Add one to ${esc(into.name)}">+</button>
        </div>`
      : `<button class="quick-add" data-quick="${id}" data-binder="${bid}" aria-label="Add one to ${esc(into?.name || 'binder')}" title="Add 1 to ${esc(into?.name || 'binder')}">＋</button>`}
  </div>`;
}

document.addEventListener('click', e => {
  const dec = e.target.closest('[data-quick-dec]');
  if (dec) return quickRemove(dec.dataset.quickDec, dec.dataset.binder, e);
  const quick = e.target.closest('[data-quick]');
  if (quick) return quickAdd(quick.dataset.quick, quick.dataset.binder, e);
  const t = e.target.closest('[data-card]');
  if (t) openCard(t.dataset.card, t);
});
document.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.tile[data-card]')) {
    e.preventDefault();
    openCard(e.target.dataset.card, e.target);
  }
});

// ＋ on a tile: one more copy in the binder you're adding to (or the binder you're looking at).
function quickAdd(id, binderId, e) {
  const card = cardInfo(id);
  const b = store.binder(binderId) || targetBinder();
  if (!card || !b) return;
  store.addCopy(b.id, card);
  floatAt(e, '+1');
  bump(id);
  toast(`Added ${card.name} to ${b.name}`, { label: 'Undo', run: () => store.removeCopy(b.id, card.id) });
}

// − on a tile: one copy less. Plain copies go first; a copy with a grade or price needs a yes.
function quickRemove(id, binderId, e) {
  const card = cardInfo(id);
  const b = store.binder(binderId);
  if (!card || !b) return;
  const detailed = store.copiesOf(id).filter(x => x.binder.id === b.id).map(x => x.copy);
  if (store.ownedTotal(id, b.id) <= detailed.length) {
    const last = detailed[detailed.length - 1];
    const what = [gradeLabel(last), last.paid > 0 ? money(last.paid, last.cur) : ''].filter(Boolean).join(', ');
    if (!confirm(`Remove your ${what} copy of ${card.name} from ${b.name}?`)) return;
    store.removeCopy(b.id, id, last.id);
  } else {
    store.removeCopy(b.id, id);
    toast(`Removed one ${card.name} from ${b.name}`, { label: 'Undo', run: () => store.addCopy(b.id, card) });
  }
  floatAt(e, '−1', true);
  bump(id);
}

// Little "+1" / "−1" that floats up from where you tapped.
function floatAt(e, text, minus = false) {
  if (!e?.clientX && !e?.clientY) return;
  const el = Object.assign(document.createElement('span'), { className: `float-count${minus ? ' minus' : ''}`, textContent: text });
  el.style.left = `${e.clientX}px`;
  el.style.top = `${e.clientY - 12}px`;
  document.body.append(el);
  // Remove it when the float-up ends – and after a second regardless, in case the animation never runs.
  el.addEventListener('animationend', () => el.remove());
  setTimeout(() => el.remove(), 1000);
}

// Make the count on the card's tiles pop (tiles were just redrawn with the new number).
function bump(id) {
  $$(`.tile[data-card="${CSS.escape(id)}"] .quick-step b`).forEach(el => el.classList.add('bump'));
}

// A few catalog pictures are missing on TCGplayer's side: show the name instead of a broken image.
document.addEventListener('error', e => {
  const img = e.target;
  if (img.tagName !== 'IMG' || !img.closest('.tile')) return;
  img.replaceWith(Object.assign(document.createElement('span'), {
    className: 'noimg', innerHTML: `<b>${esc(img.alt)}</b><small>No picture yet</small>`,
  }));
}, true);

function cardInfo(id) {
  const c = catalog.cardById(id) || seen.get(id) || store.storedCard(id);
  if (!c) return null;
  const set = setsCache?.byId.get(c.setId);
  return {
    id, pid: c.pid, name: c.name, localId: c.localId, image: c.image || '', rarity: c.rarity || '',
    setId: c.setId, setName: c.setName || set?.label || '', lang: langOfCard(c),
  };
}

function openCard(id, fromTile = null) {
  if (!cardInfo(id) || flying) return;
  let cur = 'THB';
  try { cur = localStorage.getItem(CUR_KEY) === 'USD' ? 'USD' : 'THB'; } catch {}
  ui.modal = { type: 'card', id, form: { graded: false, grader: 'PSA', grade: '10', cert: '', paid: '', cur } };
  drawCard();
  loadPrice(id);
  if (fromTile) flyOpen(fromTile);
  else showModal();
}

// ---------- card animation: out of the grid, to the middle, flip over to the details ----------
const FLIP = 'perspective(1400px)';
let flying = false;

// Wait for an animation – but never longer than it should take, so a paused page
// (hidden tab, power saving) can't leave the card stuck halfway.
async function done(anim) {
  const ms = (anim.effect?.getTiming().duration || 0) + 150;
  await Promise.race([anim.finished.catch(() => {}), new Promise(r => setTimeout(r, ms))]);
  if (anim.playState !== 'finished') { try { anim.finish(); } catch {} } // jump to the end state
}

function shade() {
  const el = Object.assign(document.createElement('div'), { className: 'fly-shade' });
  document.body.append(el);
  return el;
}

// Where the big card sits in the middle of the screen.
function centreBox() {
  const w = Math.min(300, innerWidth * 0.72), h = w * 88 / 63;
  return { x: (innerWidth - w) / 2, y: (innerHeight - h) / 2, w, h };
}

function flyingCard(src, box) {
  const el = Object.assign(document.createElement('div'), { className: 'fly-card' });
  Object.assign(el.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
  if (src) el.append(Object.assign(new Image(), { src, alt: '' }));
  document.body.append(el);
  return el;
}

// Transform that puts a centre-box-sized element exactly over a tile.
function overTile(rect, box) {
  const dx = rect.left + rect.width / 2 - (box.x + box.w / 2);
  const dy = rect.top + rect.height / 2 - (box.y + box.h / 2);
  return `translate(${dx}px, ${dy}px) scale(${rect.width / box.w})`;
}

async function flyOpen(tile) {
  const img = tile.querySelector('img');
  const rect = tile.getBoundingClientRect();
  if (!img || !rect.width) return showModal();
  flying = true;
  const box = centreBox();
  const bg = shade();
  const card = flyingCard(img.currentSrc || img.src, box);
  const hi = $('#modal-body .detail-img');
  tile.classList.add('lifted');
  try {
    done(bg.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 380, fill: 'forwards' }));
    // 1. lift out of the grid and fly to the middle, with a little overshoot
    await done(card.animate([
      { transform: overTile(rect, box), boxShadow: '0 2px 6px rgb(0 0 0 / .2)' },
      { transform: 'translateY(-6px) scale(1.07)', offset: 0.7 },
      { transform: 'none', boxShadow: '0 30px 60px rgb(0 0 0 / .5)' },
    ], { duration: 460, easing: 'cubic-bezier(.2, .8, .25, 1)' }));
    // 2. flip over: the card turns away…
    await done(card.animate([{ transform: `${FLIP} rotateY(0deg)` }, { transform: `${FLIP} rotateY(90deg)` }],
      { duration: 170, easing: 'ease-in', fill: 'forwards' }));
    // …and the details turn into view on its back.
    showModal();
    done($('#modal').animate([{ transform: `${FLIP} rotateY(-90deg)` }, { transform: `${FLIP} rotateY(0deg)` }],
      { duration: 240, easing: 'cubic-bezier(.2, .9, .3, 1.15)' }));
  } finally {
    card.remove();
    bg.remove();
    tile.classList.remove('lifted');
    flying = false;
  }
  if (hi && !hi.complete) hi.decode?.().catch(() => {});
}

// Close the card the other way round: flip back, fly home into its spot in the grid.
async function closeCard() {
  const dialog = $('#modal');
  const id = ui.modal?.id;
  if (flying) return;
  const tile = [...document.querySelectorAll(`.tile[data-card="${CSS.escape(id || '')}"]`)].find(t => t.offsetParent && t.querySelector('img'));
  const rect = tile?.getBoundingClientRect();
  const onScreen = rect && rect.bottom > 0 && rect.top < innerHeight;
  flying = true;
  try {
    await done(dialog.animate([{ transform: `${FLIP} rotateY(0deg)` }, { transform: `${FLIP} rotateY(90deg)` }],
      { duration: 170, easing: 'ease-in', fill: 'forwards' }));
    dialog.close();
    dialog.getAnimations().forEach(a => a.cancel());
    if (!onScreen) return;
    const box = centreBox();
    const bg = shade();
    const card = flyingCard(tile.querySelector('img').currentSrc || tile.querySelector('img').src, box);
    tile.classList.add('lifted');
    try {
      await done(card.animate([{ transform: `${FLIP} rotateY(-90deg)` }, { transform: `${FLIP} rotateY(0deg)` }],
        { duration: 170, easing: 'ease-out' }));
      done(bg.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 380, fill: 'forwards' }));
      await done(card.animate([
        { transform: 'none', boxShadow: '0 30px 60px rgb(0 0 0 / .5)' },
        { transform: overTile(rect, box), boxShadow: '0 2px 6px rgb(0 0 0 / .2)' },
      ], { duration: 380, easing: 'cubic-bezier(.4, 0, .2, 1)' }));
    } finally {
      card.remove();
      bg.remove();
      tile.classList.remove('lifted');
    }
  } finally {
    flying = false;
  }
}

function closeModal() {
  if (ui.modal?.type === 'card') return closeCard();
  $('#modal').close();
}
$('#modal-close').addEventListener('click', closeModal);
$('#modal').addEventListener('cancel', e => { e.preventDefault(); closeModal(); }); // Esc key
// Tap outside the box to close.
$('#modal').addEventListener('click', e => {
  if (e.target !== $('#modal')) return;
  const r = $('#modal').getBoundingClientRect();
  if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeModal();
});

function drawCard() {
  const { id, form } = ui.modal;
  const card = cardInfo(id);
  const own = store.ownership(id);
  const total = own.reduce((n, x) => n + x.qty, 0);
  const target = targetBinder();
  const want = store.wanted(id);
  const copies = store.copiesOf(id);
  const paid = {};
  for (const { copy } of copies) if (copy.paid > 0) paid[copy.cur] = (paid[copy.cur] || 0) + copy.paid;
  const chip = (attr, value, on, label = value) => `<button class="chip${on ? ' on' : ''}" ${attr}="${esc(value)}">${esc(label)}</button>`;
  $('#modal-body').innerHTML = `<div class="detail">
    ${card.image ? `<img class="detail-img" src="${esc(imgUrl(card, 'high'))}" alt="${esc(card.name)}">` : ''}
    <h3>${esc(card.name)}</h3>
    <p class="meta">${card.lang === 'ja' ? '🇯🇵 ' : ''}${esc(card.setName)} · #${esc(card.localId)}${id.startsWith('custom:') ? ' · added by you' : ''}</p>
    <p class="price">${esc(priceText.get(id) || card.rarity)}</p>
    <div class="detail-links">
      <button class="btn ghost want-btn${want ? ' on' : ''}" data-act="want">${want ? '★ On your wishlist' : '☆ Add to wishlist'}</button>
      ${card.pid ? `<a class="btn ghost" href="${esc(catalog.productUrl(card.pid))}" target="_blank" rel="noopener">TCGplayer ↗</a>` : ''}
    </div>
    ${own.length ? `<div class="own-list">
      <p class="owned-note">✓ You have ${total}</p>
      ${own.map(({ binder, qty }) => `<div class="own-row">
        <span class="own-name">${swatch(binder)}${esc(binder.name)}</span>
        <div class="stepper">
          <button class="btn" data-act="dec" data-binder="${esc(binder.id)}" aria-label="One less">−</button>
          <b>${qty}</b>
          <button class="btn" data-act="inc" data-binder="${esc(binder.id)}" aria-label="One more">+</button>
        </div>
      </div>
      ${copies.filter(x => x.binder.id === binder.id).map(({ copy }) => `<div class="copy-row">
        <span class="copy-grade${copy.grader ? ' graded' : ''}">${esc(gradeLabel(copy))}</span>
        <span class="copy-info">${[copy.paid > 0 ? money(copy.paid, copy.cur) : '', copy.date].filter(Boolean).map(esc).join(' · ')}
          ${copy.cert ? (CERT_LINKS[copy.grader]
            ? ` · <a href="${esc(CERT_LINKS[copy.grader](copy.cert))}" target="_blank" rel="noopener">#${esc(copy.cert)} ↗</a>`
            : ` · #${esc(copy.cert)}`) : ''}</span>
        <button class="copy-remove" data-act="rmcopy" data-binder="${esc(binder.id)}" data-copy="${esc(copy.id)}" aria-label="Remove this copy">✕</button>
      </div>`).join('')}`).join('')}
      ${Object.keys(paid).length ? `<p class="paid-total">You paid: ${Object.entries(paid).map(([cur, sum]) => money(sum, cur)).join(' + ')}</p>` : ''}
    </div>` : ''}
    <div class="add-box">
      <div class="add-line">
        <label for="add-to">Add to</label>
        <select id="add-to">${store.binders().map(b =>
          `<option value="${esc(b.id)}"${b.id === target?.id ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}</select>
      </div>
      <div class="chips">${chip('data-cond', 'raw', !form.graded, 'Raw')}${chip('data-cond', 'graded', form.graded, 'Graded')}</div>
      ${form.graded ? `
        <div class="chips">${Object.keys(GRADERS).map(g => chip('data-grader', g, g === form.grader)).join('')}</div>
        <div class="chips grades">${GRADERS[form.grader].map(g => chip('data-grade', g, g === form.grade)).join('')}</div>
        <input id="add-cert" inputmode="numeric" maxlength="20" placeholder="Cert number (optional)" value="${esc(form.cert)}">` : ''}
      <label class="add-label" for="add-paid">How much you got it for <small>(optional)</small></label>
      <div class="price-row">
        <input id="add-paid" type="number" min="0" step="0.01" inputmode="decimal" placeholder="0" value="${esc(form.paid)}">
        <div class="chips">${chip('data-cur', 'THB', form.cur === 'THB', '฿ THB')}${chip('data-cur', 'USD', form.cur === 'USD', '$ USD')}</div>
      </div>
      <button class="btn primary add-btn" data-act="add">${own.length ? 'Add another' : 'Add to binder'}</button>
    </div>
  </div>`;
}

$('#modal-body').addEventListener('input', e => {
  if (ui.modal?.type !== 'card') return;
  if (e.target.id === 'add-paid') ui.modal.form.paid = e.target.value;
  else if (e.target.id === 'add-cert') ui.modal.form.cert = e.target.value.trim();
});

$('#modal-body').addEventListener('click', e => {
  if (ui.modal?.type !== 'card') return;
  const { form } = ui.modal;
  const t = e.target.closest('button');
  if (!t) return;
  // Add-box choices: just redraw with the new choice.
  if (t.dataset.cond) { form.graded = t.dataset.cond === 'graded'; return drawCard(); }
  if (t.dataset.grader) { form.grader = t.dataset.grader; form.grade = GRADERS[form.grader][0]; return drawCard(); }
  if (t.dataset.grade) { form.grade = t.dataset.grade; return drawCard(); }
  if (t.dataset.cur) {
    form.cur = t.dataset.cur;
    try { localStorage.setItem(CUR_KEY, form.cur); } catch {}
    return drawCard();
  }
  const act = t.dataset.act;
  if (!act) return;
  const card = cardInfo(ui.modal.id);
  if (act === 'add') {
    const binderId = $('#add-to').value;
    localStorage.setItem(TARGET_KEY, binderId);
    const price = parseFloat(form.paid);
    const details = {};
    if (form.graded) Object.assign(details, { grader: form.grader, grade: form.grade }, form.cert ? { cert: form.cert } : {});
    if (price > 0) Object.assign(details, { paid: price, cur: form.cur });
    store.addCopy(binderId, card, Object.keys(details).length ? details : null);
    Object.assign(form, { paid: '', cert: '' });
    const what = [details.grader && `${details.grader} ${details.grade}`, details.paid && money(details.paid, details.cur)].filter(Boolean).join(', ');
    toast(`Added ${card.name}${what ? ` (${what})` : ''} to ${store.binder(binderId).name}`);
  } else if (act === 'inc') {
    store.addCopy(t.dataset.binder, card);
  } else if (act === 'dec') {
    store.removeCopy(t.dataset.binder, card.id); // removes a copy without details first
  } else if (act === 'rmcopy') {
    store.removeCopy(t.dataset.binder, card.id, t.dataset.copy);
  } else if (act === 'want') {
    const want = !store.wanted(card.id);
    store.setWanted(card, want);
    toast(want ? `Added ${card.name} to your wishlist` : 'Removed from your wishlist');
  }
});

const priceText = new Map();
async function loadPrice(id) {
  const card = cardInfo(id);
  const usd = await catalog.price(card).catch(() => null);
  if (usd == null) return;
  priceText.set(id, [card.rarity, `≈ $${usd.toFixed(2)} (TCGplayer market)`].filter(Boolean).join(' — '));
  if (ui.modal?.type === 'card' && ui.modal.id === id) $('#modal-body .price').textContent = priceText.get(id);
}

function showModal() { if (!$('#modal').open) $('#modal').showModal(); }
$('#modal').addEventListener('close', () => { ui.modal = null; });

let toastTimer;
// action: optional { label, run } button, e.g. Undo.
function toast(msg, action = null) {
  document.querySelector('.toast')?.remove();
  const el = Object.assign(document.createElement('div'), { className: 'toast' });
  el.append(msg);
  if (action) {
    const btn = Object.assign(document.createElement('button'), { className: 'toast-action', textContent: action.label });
    btn.addEventListener('click', () => { action.run(); el.remove(); });
    el.append(btn);
  }
  ($('#modal').open ? $('#modal') : document.body).append(el); // dialogs sit above the page
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), action ? 4500 : 2200);
}

// ---------- binder covers ----------
const STICKERS = ['', '⚡', '🔥', '💧', '🌿', '⭐', '💎', '👑', '🌙', '❤️', '🐉', '👻'];
const PATTERN_NAMES = { ball: 'Poké Ball', plain: 'Plain', stripes: 'Stripes', dots: 'Dots', holo: 'Holo', grid: 'Grid' };

function coverOf(b) {
  const c = { color: store.COLORS[0], pattern: 'ball', sticker: '', art: null, ...(b.cover || {}) };
  if (!/^#[0-9a-f]{6}$/i.test(c.color)) c.color = store.COLORS[0];
  if (!store.PATTERNS.includes(c.pattern)) c.pattern = 'ball';
  return c;
}

function coverHTML(b, extra = '') {
  const c = coverOf(b);
  const art = c.art?.type === 'photo' ? `<img class="cover-photo" src="${esc(c.art.src)}" alt="">`
    : c.art?.type === 'card' ? `<img class="cover-card" src="${esc(c.art.src)}" alt="">` : '';
  return `<div class="cover pat-${c.pattern}${c.art?.type === 'photo' ? ' has-photo' : ''} ${extra}" style="--cover:${c.color}">
    ${art}
    <div class="cover-plate">${c.sticker ? `<span class="cover-sticker">${esc(c.sticker)}</span>` : ''}<span class="cover-title">${esc(b.name)}</span></div>
  </div>`;
}
const swatch = b => `<span class="swatch-dot" style="--cover:${coverOf(b).color}"></span>`;

// ---------- binders tab ----------
function countIn(binderId) { return store.cardsIn(binderId).reduce((n, c) => n + c.qty, 0); }

function renderShelf() {
  $('#shelf').innerHTML = store.binders().map(b => {
    const n = countIn(b.id);
    return `<button class="shelf-item" data-binder="${esc(b.id)}">
      ${coverHTML(b)}
      <span class="shelf-count">${n} card${n === 1 ? '' : 's'}</span>
    </button>`;
  }).join('') + `<button class="shelf-item new-binder" id="new-binder"><span class="plus">＋</span>New binder</button>`;
}

$('#shelf').addEventListener('click', e => {
  if (e.target.closest('#new-binder')) return openCoverEditor(null);
  const item = e.target.closest('[data-binder]');
  if (item) { ui.binderId = item.dataset.binder; showView('binder'); }
});

const byNumber = (a, b) => String(a.localId).localeCompare(String(b.localId), undefined, { numeric: true });
// Default order for cards not placed yet: oldest set first, then by number.
const setDate = c => setsCache?.byId.get(c.setId)?.date || '9999';
const defaultOrder = (a, b) => setDate(a).localeCompare(setDate(b)) || String(a.setName).localeCompare(String(b.setName)) || byNumber(a, b);

// ---------- binder pages ----------
// A binder's layout: { size: 2 | 3 | 4 pockets per side, slots: [cardId | null, …], planned: { cardId: card } }.
// slots says which card sits in which pocket (null = empty pocket). Planned cards are ones you
// don't own yet, shown greyed in their pocket. Pages start empty: cards in the binder that
// aren't on a page yet wait in the "Not on a page yet" tray until you put them in a pocket.
const binderUi = {}; // per binder: { mode, page, arrange, pick } – pick: pocket index or 't:<cardId>' (from the tray)
const SIZES = [2, 3, 4];

function binderLayout(b) {
  const size = SIZES.includes(b.layout?.size) ? b.layout.size : 3;
  const per = size * size;
  const owned = new Map(store.cardsIn(b.id).map(c => [c.id, c]));
  const planned = b.layout?.planned || {};
  const slots = (b.layout?.slots || []).map(id => (id && (owned.has(id) || planned[id]) ? id : null));
  const placed = new Set(slots.filter(Boolean));
  let last = slots.length;
  while (last && !slots[last - 1]) last--;
  const all = slots.slice(0, last);
  let pages = Math.max(1, Math.ceil(all.length / per));
  while (all.length < pages * per) all.push(null);
  if (!all.slice(-per).includes(null)) { pages++; while (all.length < pages * per) all.push(null); } // always a free pocket
  const unplaced = [...owned.values()].filter(c => !placed.has(c.id)).sort(defaultOrder);
  return { size, per, all, owned, planned, pages, unplaced };
}

function saveLayout(b, all, size, planned) {
  let last = all.length;
  while (last && !all[last - 1]) last--;
  const slots = all.slice(0, last);
  const owned = new Set(store.cardsIn(b.id).map(c => c.id));
  // Only keep planned cards that still sit in a pocket and aren't owned yet.
  const keep = Object.fromEntries(Object.entries(planned).filter(([id]) => slots.includes(id) && !owned.has(id)));
  store.setLayout(b.id, { size, slots, planned: keep });
}

const spreadSize = () => (innerWidth >= 900 ? 2 : 1); // two pages side by side on wide screens

function pocketHTML(b, L, st, id, idx) {
  const picked = st.pick === idx ? ' picked' : '';
  if (!id) {
    return `<div class="pocket vacant${picked}" data-slot="${idx}"><span class="plan-plus" title="Put a card here">＋</span></div>`;
  }
  const own = L.owned.get(id);
  const card = own || L.planned[id];
  return `<div class="pocket${own ? '' : ' planned'}${picked}" data-slot="${idx}">
    ${tile(card, { qty: own?.qty || 0, missing: true, times: true, addTo: b.id, inert: st.arrange })}
    ${own ? '' : '<span class="planned-tag">Planned</span>'}
    ${st.arrange ? `<button class="unplan" data-unplan="${idx}" aria-label="${own ? 'Take off the page' : 'Remove planned card'}" title="${own ? 'Take off the page' : 'Remove planned card'}">✕</button>` : ''}
  </div>`;
}

function pagesHTML(b, L, st) {
  const span = spreadSize();
  st.page = Math.max(0, Math.min(st.page - (st.page % span), (L.pages - 1) - ((L.pages - 1) % span)));
  const shown = Array.from({ length: span }, (_, i) => st.page + i).filter(p => p < L.pages);
  const label = shown.length > 1 ? `Pages ${shown[0] + 1}–${shown.at(-1) + 1}` : `Page ${shown[0] + 1}`;
  return `<div class="pages${st.arrange ? ' arranging' : ''}">
    <div class="page-nav">
      <button class="page-btn" data-page="-1" aria-label="Previous page"${st.page === 0 ? ' disabled' : ''}>‹</button>
      <span>${label} <small>of ${L.pages}</small></span>
      <button class="page-btn" data-page="1" aria-label="Next page"${st.page + span >= L.pages ? ' disabled' : ''}>›</button>
    </div>
    <div class="spread" id="spread" style="--pages:${span}">
      ${shown.map(p => `<div class="page s${L.size}" style="--size:${L.size}">
        ${L.all.slice(p * L.per, (p + 1) * L.per).map((id, i) => pocketHTML(b, L, st, id, p * L.per + i)).join('')}
      </div>`).join('')}
    </div>
    ${st.arrange ? `<p class="arrange-hint">${st.pick == null
      ? 'Drag cards between pockets or from the tray below (or tap one, then tap where it goes). Hold at the edge to change page. ✕ takes a card off the page.'
      : 'Now tap the pocket it should go in (or the same card to cancel).'}</p>` : ''}
    ${trayHTML(b, L, st)}
  </div>`;
}

// Cards in this binder that aren't on a page yet.
function trayHTML(b, L, st) {
  if (!L.unplaced.length) {
    return L.owned.size ? '<p class="tray-done">✓ Every card in this binder is on a page.</p>' : '';
  }
  return `<div class="tray" id="tray">
    <h4>Not on a page yet <small>${L.unplaced.length}</small></h4>
    <p class="meta">${st.arrange ? 'Drag one onto an empty pocket, or tap it and then tap a pocket.'
      : 'Tap ＋ in an empty pocket to put one there, or use ✋ Arrange to drag them in.'}</p>
    <div class="tray-grid">${L.unplaced.map(c => `<div class="tray-card${st.pick === `t:${c.id}` ? ' picked' : ''}" data-tray="${esc(c.id)}">
      ${tile(c, { qty: c.qty, times: true, addTo: b.id, inert: st.arrange })}
    </div>`).join('')}</div>
  </div>`;
}

function binderListHTML(b, all, f) {
  const cards = all.filter(c => !f || c.name.toLowerCase().includes(f) || (c.setName || '').toLowerCase().includes(f));
  const groups = new Map();
  cards.forEach(c => { if (!groups.has(c.setId)) groups.set(c.setId, []); groups.get(c.setId).push(c); });
  return [...groups].map(([setId, list]) => {
    const s = setsCache?.byId.get(setId);
    return `<div class="set-group">
      <h3><span>${esc(s?.label || list[0].setName || setId)} <small>${list.length}${s ? ` / ${s.cards}` : ''}</small></span>
        ${s ? `<button class="linkish" data-open-set="${esc(setId)}">Checklist →</button>` : ''}</h3>
      <div class="grid">${list.sort(byNumber).map(c => tile(c, { qty: c.qty, times: true, addTo: b.id })).join('')}</div>
    </div>`;
  }).join('') || `<div class="empty">No cards match “${esc(f)}”.</div>`;
}

function renderBinderView() {
  const b = store.binder(ui.binderId);
  const el = $('#view-binder');
  if (!b) return showView('shelf');
  const st = (binderUi[b.id] ||= { mode: 'pages', page: 0, arrange: false, pick: null });
  const filterValue = $('#binder-filter')?.value || '';
  const f = filterValue.trim().toLowerCase();
  const all = store.cardsIn(b.id);
  remember(all);
  const L = binderLayout(b);
  remember(Object.values(L.planned));
  const planned = L.all.filter(id => id && !L.owned.has(id)).length;
  const waiting = L.unplaced.length;
  const toggle = (attr, items, current) => `<div class="pill-toggle">${items.map(([v, label]) =>
    `<button class="chip${String(v) === String(current) ? ' on' : ''}" ${attr}="${v}">${label}</button>`).join('')}</div>`;

  const hadFocus = document.activeElement?.id === 'binder-filter';
  el.innerHTML = `
    <div class="binder-head">
      <button class="btn ghost back" data-nav="shelf">← Binders</button>
      <button class="btn ghost" data-edit="${esc(b.id)}">🎨 Edit cover</button>
    </div>
    <div class="binder-hero">
      ${coverHTML(b, 'mini')}
      <div><h2>${esc(b.name)}</h2>
        <p class="meta">${all.length} unique · ${countIn(b.id)} total${planned ? ` · ${planned} planned` : ''}${waiting && st.mode === 'pages' ? ` · ${waiting} not on a page` : ''}</p></div>
    </div>
    <div class="binder-tools">
      ${toggle('data-mode', [['pages', 'Pages'], ['list', 'List']], st.mode)}
      ${st.mode === 'pages' ? `
        ${toggle('data-size', SIZES.map(n => [n, `${n}×${n}`]), L.size)}
        <button class="chip arrange-btn${st.arrange ? ' on' : ''}" data-arrange>${st.arrange ? '✓ Done' : '✋ Arrange'}</button>` : ''}
    </div>
    ${st.mode === 'pages'
      ? pagesHTML(b, L, st)
      : !all.length
        ? `<div class="empty">This binder is empty.<br>Go to <b>Add cards</b>, pick <b>${esc(b.name)}</b> and scan a card.</div>`
        : `<input id="binder-filter" class="filter" placeholder="Filter this binder…" autocomplete="off" value="${esc(filterValue)}">
           ${binderListHTML(b, all, f)}`}`;
  if (hadFocus) {
    const input = $('#binder-filter');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

// Turn the page: the new page slides in from the side it came from, with a slight page-turn tilt.
async function turnPage(b, dir) {
  const st = binderUi[b.id];
  const L = binderLayout(b);
  const next = st.page + dir * spreadSize();
  if (next < 0 || next >= L.pages) return;
  st.page = next;
  st.pick = null;
  renderBinderView();
  const spread = $('#spread');
  if (spread) {
    done(spread.animate([
      { transform: `perspective(1600px) translateX(${dir * 60}px) rotateY(${dir * -14}deg)`, opacity: 0 },
      { transform: 'none', opacity: 1 },
    ], { duration: 320, easing: 'cubic-bezier(.2, .8, .25, 1)' }));
  }
}

$('#view-binder').addEventListener('input', e => { if (e.target.id === 'binder-filter') renderBinderView(); });
$('#view-binder').addEventListener('click', e => {
  if (e.target.closest('[data-nav="shelf"]')) return showView('shelf');
  const edit = e.target.closest('[data-edit]');
  if (edit) return openCoverEditor(edit.dataset.edit);
  const set = e.target.closest('[data-open-set]');
  if (set) return openSetChecklist(set.dataset.openSet);

  const b = store.binder(ui.binderId);
  const st = b && binderUi[b.id];
  if (!st) return;
  const t = e.target.closest('button');
  if (t?.dataset.mode) { st.mode = t.dataset.mode; st.arrange = false; st.pick = null; return renderBinderView(); }
  if (t?.dataset.size) {
    const L = binderLayout(b);
    saveLayout(b, L.all, +t.dataset.size, L.planned);
    st.page = 0;
    return;
  }
  if (t?.hasAttribute('data-arrange')) { st.arrange = !st.arrange; st.pick = null; return renderBinderView(); }
  if (t?.dataset.page) return turnPage(b, +t.dataset.page);

  const L = binderLayout(b);
  if (!st.arrange) {
    const empty = e.target.closest('.pocket.vacant');
    if (empty) openPlanPicker(b, +empty.dataset.slot);
    return;
  }
  const fromTray = e.target.closest('[data-tray]');
  if (fromTray) {
    const key = `t:${fromTray.dataset.tray}`;
    st.pick = st.pick === key ? null : key;
    return renderBinderView();
  }
  const unplan = e.target.closest('[data-unplan]');
  if (unplan) {
    L.all[+unplan.dataset.unplan] = null;
    st.pick = null;
    return saveLayout(b, L.all, L.size, L.planned);
  }
  const pocket = e.target.closest('.pocket');
  if (!pocket) return;
  const idx = +pocket.dataset.slot;
  if (st.pick == null) {
    if (L.all[idx]) { st.pick = idx; return renderBinderView(); }
    return openPlanPicker(b, idx);
  }
  if (st.pick === idx) { st.pick = null; return renderBinderView(); }
  if (typeof st.pick === 'string') L.all[idx] = st.pick.slice(2); // from the tray (whatever was there goes back to it)
  // Swap the two pockets (moving onto an empty pocket just moves the card).
  else [L.all[st.pick], L.all[idx]] = [L.all[idx], L.all[st.pick]];
  st.pick = null;
  saveLayout(b, L.all, L.size, L.planned);
  requestAnimationFrame(() => {
    const landed = $(`#view-binder .pocket[data-slot="${idx}"]`);
    if (landed) done(landed.animate([{ transform: 'scale(.85)' }, { transform: 'scale(1.06)' }, { transform: 'none' }], { duration: 260, easing: 'ease-out' }));
  });
});

// Swipe left / right to turn pages.
let swipeX = null;
$('#view-binder').addEventListener('pointerdown', e => {
  if (e.target.closest('#spread') && !binderUi[ui.binderId]?.arrange) swipeX = e.clientX;
});
$('#view-binder').addEventListener('pointerup', e => {
  if (swipeX == null) return;
  const dx = e.clientX - swipeX;
  swipeX = null;
  const b = store.binder(ui.binderId);
  if (b && Math.abs(dx) > 60) turnPage(b, dx < 0 ? 1 : -1);
});
let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (ui.tab === 'binders' && ui.view === 'binder') renderBinderView(); }, 200);
});

// ---------- drag & drop (Arrange mode) ----------
// Browsers let you drag pictures out of a page; that would hijack our drag, so turn it off here.
$('#view-binder').addEventListener('dragstart', e => e.preventDefault());
// Works with mouse and finger: grab a card, it follows the pointer, the pocket underneath lights
// up, drop to move/swap. Hold it at the left/right edge to turn the page while dragging.
// A press that doesn't move is still a tap (tap-a-card, tap-a-pocket keeps working).
let drag = null;

$('#view-binder').addEventListener('pointerdown', e => {
  const b = store.binder(ui.binderId);
  const st = b && binderUi[b.id];
  if (!st?.arrange || e.button > 0 || e.target.closest('[data-unplan]')) return;
  const tray = e.target.closest('[data-tray]');
  const pocket = tray || e.target.closest('.pocket');
  if (!pocket || pocket.classList.contains('vacant')) return;
  // from: a pocket index, or 't:<cardId>' for a card coming from the tray
  const from = tray ? `t:${tray.dataset.tray}` : +pocket.dataset.slot;
  drag = { b, from, pocket, pointer: e.pointerId, x0: e.clientX, y0: e.clientY, started: false };
});

addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.pointer) return;
  if (!drag.started) {
    if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6) return;
    startDrag();
  }
  moveDrag(e.clientX, e.clientY);
});
addEventListener('pointerup', e => { if (drag && e.pointerId === drag.pointer) endDrag(); });
addEventListener('pointercancel', () => { if (drag) endDrag(true); });

function startDrag() {
  const rect = drag.pocket.getBoundingClientRect();
  const ghost = Object.assign(document.createElement('div'), { className: 'drag-ghost' });
  ghost.append(drag.pocket.querySelector('.tile').cloneNode(true));
  Object.assign(ghost.style, { width: `${rect.width}px`, height: `${rect.height}px` });
  document.body.append(ghost);
  Object.assign(drag, { started: true, ghost, home: rect, offX: drag.x0 - rect.left, offY: drag.y0 - rect.top });
  drag.pocket.classList.add('drag-from');
  document.body.classList.add('dragging');
  binderUi[drag.b.id].pick = null;
  $$('#view-binder .pocket.picked').forEach(p => p.classList.remove('picked'));
}

// What's under the pointer: a pocket, or the tray (to take a card off the page).
function pocketAt(x, y) {
  return document.elementFromPoint(x, y)?.closest('#view-binder .pocket, #tray') || null;
}

function moveDrag(x, y) {
  drag.x = x;
  drag.y = y;
  drag.ghost.style.transform = `translate(${x - drag.offX}px, ${y - drag.offY}px) rotate(4deg) scale(1.06)`;
  const target = pocketAt(x, y);
  if (target !== drag.target) {
    drag.target?.classList.remove('drop-target');
    const same = target && (target.id === 'tray' ? typeof drag.from === 'string' : +target.dataset.slot === drag.from);
    if (target && !same) target.classList.add('drop-target');
    drag.target = target;
  }
  // Holding at the edge of the pages turns the page (to drag a card to another page).
  const spread = $('#spread')?.getBoundingClientRect();
  const dir = !spread ? 0 : x < spread.left + 28 ? -1 : x > spread.right - 28 ? 1 : 0;
  if (dir !== drag.edgeDir) {
    clearTimeout(drag.edgeTimer);
    drag.edgeDir = dir;
    if (dir) {
      drag.edgeTimer = setTimeout(async () => {
        if (!drag) return;
        await turnPage(drag.b, dir);
        if (drag) { drag.edgeDir = 0; moveDrag(drag.x, drag.y); }
      }, 650);
    }
  }
}

async function endDrag(cancelled = false) {
  const d = drag;
  drag = null;
  if (!d.started) return; // a plain tap: the click handler takes it from here
  clearTimeout(d.edgeTimer);
  document.body.classList.remove('dragging');
  d.target?.classList.remove('drop-target');
  // The press ended as a drag, not a tap: swallow the click that may follow (but only right now,
  // so it can never eat a later tap).
  const swallow = ev => { ev.stopPropagation(); ev.preventDefault(); };
  addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => removeEventListener('click', swallow, { capture: true }), 80);

  const fromTray = typeof d.from === 'string';
  const onTray = !cancelled && d.target?.id === 'tray';
  const to = !cancelled && d.target && !onTray ? +d.target.dataset.slot : null;
  const from = d.ghost.getBoundingClientRect();
  if (onTray && !fromTray) {
    // Dropped on the tray: take the card off the page.
    const L = binderLayout(d.b);
    L.all[d.from] = null;
    d.ghost.remove();
    return saveLayout(d.b, L.all, L.size, L.planned);
  }
  if (to == null || to === d.from) {
    // Dropped outside: slide back home (if home is still on screen), then tidy up.
    const home = (fromTray ? $(`#view-binder [data-tray="${CSS.escape(d.from.slice(2))}"]`)
      : $(`#view-binder .pocket[data-slot="${d.from}"]`))?.getBoundingClientRect();
    if (home) {
      await done(d.ghost.animate([{ transform: d.ghost.style.transform }, { transform: `translate(${home.left}px, ${home.top}px)` }],
        { duration: 220, easing: 'ease-out', fill: 'forwards' }));
    }
    d.ghost.remove();
    $$('#view-binder .drag-from').forEach(p => p.classList.remove('drag-from'));
    return;
  }
  const L = binderLayout(d.b);
  if (fromTray) L.all[to] = d.from.slice(2); // whatever was there goes back to the tray
  else [L.all[d.from], L.all[to]] = [L.all[to], L.all[d.from]];
  const dest = d.target.getBoundingClientRect();
  // Settle the ghost into its new pocket, then save (which redraws the page).
  await done(d.ghost.animate([
    { transform: `translate(${from.left}px, ${from.top}px) rotate(4deg) scale(1.06)` },
    { transform: `translate(${dest.left}px, ${dest.top}px) scale(${dest.width / from.width * 1.06})` },
  ], { duration: 180, easing: 'ease-out', fill: 'forwards' }));
  saveLayout(d.b, L.all, L.size, L.planned);
  d.ghost.remove();
  const landed = $(`#view-binder .pocket[data-slot="${to}"]`);
  if (landed) done(landed.animate([{ transform: 'scale(1.08)' }, { transform: 'none' }], { duration: 220, easing: 'ease-out' }));
}

// ＋ in an empty pocket: put one of this binder's cards there – or plan a card you don't own yet.
function openPlanPicker(b, idx) {
  const L = binderLayout(b);
  ui.modal = { type: 'plan', binderId: b.id, idx, lang, results: [], waiting: L.unplaced };
  $('#modal-body').innerHTML = `<div class="plan-picker">
    <h3>Put a card here</h3>
    <p class="meta">Page ${Math.floor(idx / L.per) + 1}, pocket ${idx % L.per + 1}</p>
    ${L.unplaced.length ? `<h4 class="picker-h">From this binder</h4>
      <div class="plan-results"><div class="grid">${L.unplaced.map((c, i) => `<button class="pick-card" data-own="${i}" title="${esc(c.name)}">
        ${c.image ? `<img src="${esc(imgUrl(c))}" alt="${esc(c.name)}" loading="lazy">` : `<span>${esc(c.name)}</span>`}
        <small>${esc([setsCache?.byId.get(c.setId)?.code, c.localId].filter(Boolean).join(' '))}${c.qty > 1 ? ` · ×${c.qty}` : ''}</small>
      </button>`).join('')}</div></div>`
      : `<p class="meta picker-note">Every card in this binder is already on a page.</p>`}
    <h4 class="picker-h">Plan a card you don’t have yet</h4>
    <p class="meta">It shows greyed in this pocket until you get it.</p>
    <form class="searchbar" data-plan-search>
      <svg class="sb-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>
      <input id="plan-q" placeholder="Card name, e.g. Umbreon" autocomplete="off" enterkeyhint="search">
      <input id="plan-n" class="sb-number" placeholder="No." autocomplete="off" enterkeyhint="search">
      <button type="submit" class="sr-only">Find</button>
    </form>
    <div class="pill-toggle plan-lang">${['en', 'ja'].map(l =>
      `<button class="chip${l === lang ? ' on' : ''}" data-plan-lang="${l}">${l === 'en' ? 'EN' : 'JP'}</button>`).join('')}</div>
    <div class="plan-results" id="plan-results"></div>
  </div>`;
  showModal();
  $('#plan-q').focus();
}

async function runPlanSearch() {
  const m = ui.modal;
  const name = $('#plan-q').value.trim();
  const [number = '', total = ''] = $('#plan-n').value.trim().split('/').map(s => s.trim().replace(/^0+(?=\d)/, ''));
  if (!name && !number) return;
  $('#plan-results').innerHTML = '<p class="meta">Searching…</p>';
  const results = await findCards({ names: name ? [name] : [], number, total, language: m.lang });
  if (ui.modal !== m) return;
  m.results = results.slice(0, 60);
  $('#plan-results').innerHTML = m.results.length
    ? `<div class="grid">${m.results.map((c, i) => `<button class="pick-card" data-pick="${i}" title="${esc(c.name)}">
        ${c.image ? `<img src="${esc(imgUrl(c))}" alt="${esc(c.name)}" loading="lazy">` : `<span>${esc(c.name)}</span>`}
        <small>${esc([setsCache?.byId.get(c.setId)?.code, c.localId].filter(Boolean).join(' '))}</small>
      </button>`).join('')}</div>`
    : '<p class="meta">No cards found.</p>';
}

$('#modal-body').addEventListener('submit', e => {
  if (!e.target.matches('[data-plan-search]')) return;
  e.preventDefault();
  runPlanSearch();
});
$('#modal-body').addEventListener('click', e => {
  if (ui.modal?.type !== 'plan') return;
  const m = ui.modal;
  const l = e.target.closest('[data-plan-lang]')?.dataset.planLang;
  if (l) {
    m.lang = l;
    $$('[data-plan-lang]').forEach(x => x.classList.toggle('on', x.dataset.planLang === l));
    return runPlanSearch();
  }
  const own = e.target.closest('[data-own]');
  if (own) {
    const card = m.waiting[+own.dataset.own];
    const b = store.binder(m.binderId);
    const L = binderLayout(b);
    L.all[m.idx] = card.id;
    $('#modal').close();
    saveLayout(b, L.all, L.size, L.planned);
    toast(`Put ${card.name} on page ${Math.floor(m.idx / L.per) + 1}`);
    return;
  }
  const pick = e.target.closest('[data-pick]');
  if (!pick) return;
  const card = m.results[+pick.dataset.pick];
  const b = store.binder(m.binderId);
  const L = binderLayout(b);
  L.all[m.idx] = card.id;
  const planned = { ...L.planned };
  if (!L.owned.has(card.id)) {
    planned[card.id] = { id: card.id, name: card.name, localId: card.localId, image: card.image, setId: card.setId, setName: card.setName, lang: card.lang };
  }
  // A card can only sit in one pocket: if it was planned elsewhere, that pocket empties.
  L.all.forEach((id, i) => { if (id === card.id && i !== m.idx) L.all[i] = null; });
  $('#modal').close();
  saveLayout(b, L.all, L.size, planned);
  toast(`Planned ${card.name} on page ${Math.floor(m.idx / L.per) + 1}`);
});

// ---------- cover editor ----------
function openCoverEditor(binderId) {
  const b = binderId ? store.binder(binderId) : null;
  const draft = {
    name: b?.name || '',
    cover: b ? structuredClone(coverOf(b)) : { color: store.COLORS[store.binders().length % store.COLORS.length], pattern: 'ball', sticker: '', art: null },
  };
  ui.modal = { type: 'cover', binderId, draft };
  const cardChoices = (binderId ? store.cardsIn(binderId) : store.allEntries().map(x => x.card))
    .filter((c, i, arr) => c.image && arr.findIndex(x => x.id === c.id) === i).slice(0, 60);

  $('#modal-body').innerHTML = `<div class="editor">
    <h3>${b ? 'Edit binder' : 'New binder'}</h3>
    <div class="editor-preview" id="cover-preview"></div>

    <label class="editor-label" for="cover-name">Name</label>
    <input id="cover-name" maxlength="40" placeholder="e.g. Charizard Hunt" value="${esc(draft.name)}">

    <span class="editor-label">Color</span>
    <div class="swatches">${store.COLORS.map(c =>
      `<button class="swatch" data-color="${c}" style="--cover:${c}" aria-label="Color ${c}"></button>`).join('')}
      <label class="swatch custom" title="Custom color"><input type="color" id="cover-color" value="${draft.cover.color}">🎨</label>
    </div>

    <span class="editor-label">Pattern</span>
    <div class="chips">${store.PATTERNS.map(p => `<button class="chip" data-pattern="${p}">${PATTERN_NAMES[p]}</button>`).join('')}</div>

    <span class="editor-label">Sticker</span>
    <div class="chips">${STICKERS.map(s => `<button class="chip sticker" data-sticker="${s}">${s || 'None'}</button>`).join('')}</div>

    <span class="editor-label">Cover art</span>
    <div class="chips">
      <button class="chip" data-art="none">None</button>
      <button class="chip" data-art="card">A card</button>
      <label class="chip" for="cover-photo">📷 My photo</label>
      <input type="file" id="cover-photo" accept="image/*" hidden>
    </div>
    <div id="art-cards" class="art-cards" hidden>
      ${cardChoices.length
        ? cardChoices.map(c => `<button class="art-card" data-art-card="${esc(imgUrl(c, 'high'))}"><img src="${esc(imgUrl(c))}" alt="${esc(c.name)}" loading="lazy"></button>`).join('')
        : `<p class="hint">Add some cards to ${b ? 'this binder' : 'a binder'} first, then pick one as the cover.</p>`}
    </div>

    <div class="editor-actions">
      ${b ? `<button class="btn ghost danger" data-cover="delete">Delete binder</button>` : '<span></span>'}
      <button class="btn primary" data-cover="save">${b ? 'Save' : 'Create binder'}</button>
    </div>
  </div>`;
  drawCoverPreview();
  showModal();
  if (!b) $('#cover-name').focus();
}

function drawCoverPreview() {
  const { draft } = ui.modal;
  $('#cover-preview').innerHTML = coverHTML({ name: draft.name || 'My Binder', cover: draft.cover });
  $$('[data-color]').forEach(el => el.classList.toggle('on', el.dataset.color === draft.cover.color));
  $$('[data-pattern]').forEach(el => el.classList.toggle('on', el.dataset.pattern === draft.cover.pattern));
  $$('[data-sticker]').forEach(el => el.classList.toggle('on', el.dataset.sticker === draft.cover.sticker));
  const art = draft.cover.art?.type || 'none';
  $$('[data-art]').forEach(el => el.classList.toggle('on', el.dataset.art === art));
  $('label[for="cover-photo"]').classList.toggle('on', art === 'photo');
  $$('[data-art-card]').forEach(el => el.classList.toggle('on', draft.cover.art?.src === el.dataset.artCard));
}

$('#modal-body').addEventListener('click', e => {
  if (ui.modal?.type !== 'cover') return;
  const { draft } = ui.modal;
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.color) draft.cover.color = t.dataset.color;
  else if (t.dataset.pattern) draft.cover.pattern = t.dataset.pattern;
  else if (t.dataset.sticker !== undefined) draft.cover.sticker = t.dataset.sticker;
  else if (t.dataset.art === 'none') { draft.cover.art = null; $('#art-cards').hidden = true; }
  else if (t.dataset.art === 'card') { $('#art-cards').hidden = !$('#art-cards').hidden; return; }
  else if (t.dataset.artCard) draft.cover.art = { type: 'card', src: t.dataset.artCard };
  else if (t.dataset.cover === 'save') return saveCover();
  else if (t.dataset.cover === 'delete') return deleteBinder();
  else return;
  drawCoverPreview();
});

$('#modal-body').addEventListener('input', e => {
  if (ui.modal?.type !== 'cover') return;
  if (e.target.id === 'cover-name') ui.modal.draft.name = e.target.value;
  else if (e.target.id === 'cover-color') ui.modal.draft.cover.color = e.target.value;
  else return;
  drawCoverPreview();
});

$('#modal-body').addEventListener('change', async e => {
  if (ui.modal?.type !== 'cover' || e.target.id !== 'cover-photo') return;
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    // Shrink the photo so it syncs quickly (a ~40 KB JPEG).
    const canvas = await fileToCanvas(file, 600);
    ui.modal.draft.cover.art = { type: 'photo', src: canvas.toDataURL('image/jpeg', 0.78) };
    $('#art-cards').hidden = true;
    drawCoverPreview();
  } catch {
    toast("Couldn't open that photo");
  }
});

function saveCover() {
  const { binderId, draft } = ui.modal;
  const name = draft.name.trim() || 'My Binder';
  if (binderId) {
    store.updateBinder(binderId, { name, cover: draft.cover });
  } else {
    const b = store.createBinder(name);
    store.updateBinder(b.id, { cover: draft.cover });
    localStorage.setItem(TARGET_KEY, b.id);
    ui.binderId = b.id;
    showView('binder');
    toast(`Created ${name}`);
  }
  $('#modal').close();
}

function deleteBinder() {
  const { binderId } = ui.modal;
  const b = store.binder(binderId);
  const n = countIn(binderId);
  if (!confirm(`Delete “${b.name}”${n ? ` and the ${n} card${n === 1 ? '' : 's'} in it` : ''}? This can't be undone.`)) return;
  store.deleteBinder(binderId);
  $('#modal').close();
  showView('shelf');
  toast(`Deleted ${b.name}`);
}

// ---------- checklists & wishlist ----------
// A checklist is a saved search over the whole catalog: every card of a Pokémon ("Umbreon",
// English/Japanese/both) or a whole set. Owned cards show in colour, missing ones greyed out.
const LANG_NAMES = { both: 'English + Japanese', en: 'English', ja: 'Japanese' };

async function checklistCards(spec) {
  if (spec.type === 'set') return catalog.setCards(spec.setId);
  if (spec.type === 'name') {
    const key = nameKey(spec.query);
    // Newest first. TCGplayer's product ids grow over time, so they follow release order
    // better than its dates (promo sets get re-dated whenever something is added to them).
    return (await catalog.allCards(spec.lang || 'both')).filter(c => nameKey(c.name).includes(key)).sort((a, b) => b.pid - a.pid);
  }
  if (spec.type === 'wishlist') {
    const wanted = Object.values(store.wishlist()?.spec.cards || {});
    if (wanted.some(c => c.id.startsWith('tp:'))) await catalog.allCards('both');
    return wanted.sort((a, b) => (b.added || 0) - (a.added || 0)).map(c => catalog.cardById(c.id) || c);
  }
  return [];
}

const listSpec = l => (l.kind === 'wishlist' ? { type: 'wishlist' } : l.spec);
const progress = (cards, scope) => {
  const have = cards.filter(c => store.ownedTotal(c.id, scope)).length;
  return { have, total: cards.length, pct: cards.length ? Math.round((have / cards.length) * 100) : 0 };
};

function renderLists() {
  const wl = store.wishlist();
  const wishCount = Object.keys(wl?.spec.cards || {}).length;
  const saved = store.lists().filter(l => l.kind === 'checklist');
  $('#lists').innerHTML = `
    <button class="list-card wish" data-list="wishlist">
      <span class="list-icon">⭐</span>
      <span class="list-body"><b>Wishlist</b><small id="prog-wishlist">${wishCount ? `${wishCount} card${wishCount === 1 ? '' : 's'}` : 'Tap ☆ on any card to add it here'}</small>
      <span class="bar"><span id="bar-wishlist"></span></span></span>
    </button>
    ${saved.map(l => `<button class="list-card" data-list="${esc(l.id)}">
      <span class="list-icon">${l.spec.type === 'set' ? '📦' : '🔎'}</span>
      <span class="list-body"><b>${esc(l.name)}</b><small id="prog-${esc(l.id)}">Counting…</small>
      <span class="bar"><span id="bar-${esc(l.id)}"></span></span></span>
    </button>`).join('')}
    <button class="list-card new-list" id="new-list">
      <span class="list-icon">＋</span>
      <span class="list-body"><b>New checklist</b><small>Every card of a Pokémon, or a whole set</small></span>
    </button>`;
  const counted = [...(wishCount ? [{ ...wl, key: 'wishlist' }] : []), ...saved.map(l => ({ ...l, key: l.id }))];
  for (const l of counted) {
    const label = () => $(`#prog-${CSS.escape(l.key)}`);
    checklistCards(listSpec(l)).then(cards => {
      const p = progress(cards);
      if (!label()) return;
      label().textContent = `${p.have} of ${p.total} owned (${p.pct}%)`;
      $(`#bar-${CSS.escape(l.key)}`).style.width = `${p.pct}%`;
    }).catch(() => { if (label()) label().textContent = "Couldn't load the card list"; });
  }
}

$('#lists').addEventListener('click', e => {
  if (e.target.closest('#new-list')) return openNewChecklist();
  const item = e.target.closest('[data-list]');
  if (!item) return;
  const key = item.dataset.list;
  const l = store.list(key);
  ui.list = key === 'wishlist'
    ? { key, name: 'Wishlist', spec: { type: 'wishlist' }, saved: true }
    : { key, id: l.id, name: l.name, spec: l.spec, saved: true };
  showView('list');
});

function openSetChecklist(setId) {
  const set = setsCache?.byId.get(setId);
  const saved = store.lists().find(l => l.kind === 'checklist' && l.spec.type === 'set' && l.spec.setId === setId);
  ui.list = saved
    ? { key: saved.id, id: saved.id, name: saved.name, spec: saved.spec, saved: true }
    : { key: `set:${setId}`, name: set?.label || 'Set', spec: { type: 'set', setId }, saved: false };
  if (ui.tab !== 'binders') $('[data-tab="binders"]').click();
  showView('list');
}

async function renderListView() {
  const l = ui.list;
  const el = $('#view-list');
  if (!l) return showView('lists');
  const head = `<div class="binder-head">
      <button class="btn ghost" data-nav="lists">← Checklists</button>
      ${!l.saved ? '<button class="btn primary" data-list-act="save">＋ Save checklist</button>'
        : l.id ? '<button class="btn ghost danger" data-list-act="delete">Delete</button>' : ''}
    </div>`;
  if (el.dataset.key !== l.key) { el.dataset.key = l.key; el.innerHTML = `${head}<div class="empty">Loading cards…</div>`; }
  try {
    const cards = await checklistCards(l.spec);
    if (ui.list !== l) return;
    remember(cards);
    const scope = l.scope || undefined;
    const p = progress(cards, scope);
    const shown = cards.filter(c => !l.missingOnly || !store.ownedTotal(c.id, scope));
    const sub = l.spec.type === 'name' ? ` · ${LANG_NAMES[l.spec.lang || 'both']}` : '';
    el.innerHTML = `${head}
      <div class="progress">
        <div class="row"><div><b>${esc(l.name)}</b><br><small>${p.have} of ${p.total} owned (${p.pct}%)${sub}</small></div></div>
        <div class="bar"><span style="width:${p.pct}%"></span></div>
      </div>
      <div class="checklist-opts">
        <label>Count cards in
          <select id="list-scope"><option value="">All binders</option>${store.binders().map(b =>
            `<option value="${esc(b.id)}"${b.id === l.scope ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}</select>
        </label>
        <label class="check"><input type="checkbox" id="list-missing"${l.missingOnly ? ' checked' : ''}> Missing only</label>
      </div>
      ${!cards.length
        ? `<div class="empty">${l.spec.type === 'wishlist' ? 'Your wishlist is empty.<br>Open any card and tap <b>☆ Add to wishlist</b>.' : 'No cards found.'}</div>`
        : `<div class="grid">${shown.map(c => tile(c, { qty: store.ownedTotal(c.id, scope), missing: true, times: true, showSet: l.spec.type !== 'set' })).join('')
          || '<div class="empty">You have them all! 🎉</div>'}</div>`}`;
  } catch (err) {
    el.innerHTML = `${head}<div class="empty">Couldn't load the card list: ${esc(err.message)}</div>`;
  }
}

$('#view-list').addEventListener('change', e => {
  if (!ui.list) return;
  if (e.target.id === 'list-missing') ui.list.missingOnly = e.target.checked;
  else if (e.target.id === 'list-scope') ui.list.scope = e.target.value;
  else return;
  renderListView();
});

$('#view-list').addEventListener('click', e => {
  if (e.target.closest('[data-nav="lists"]')) return showView('lists');
  const act = e.target.closest('[data-list-act]')?.dataset.listAct;
  if (act === 'save') {
    const l = store.createList('checklist', ui.list.name, ui.list.spec);
    Object.assign(ui.list, { id: l.id, key: l.id, saved: true });
    $('#view-list').dataset.key = l.id;
    toast('Checklist saved');
    renderListView();
  } else if (act === 'delete') {
    if (!confirm(`Delete the checklist “${ui.list.name}”? Your cards stay in your binders.`)) return;
    store.deleteList(ui.list.id);
    toast('Checklist deleted');
    showView('lists');
  }
});

async function openNewChecklist() {
  ui.modal = { type: 'newlist', kind: 'name' };
  $('#modal-body').innerHTML = `<form class="newlist" data-newlist>
    <h3>New checklist</h3>
    <div class="segmented small">
      <button type="button" class="seg active" data-nl="name">A Pokémon</button>
      <button type="button" class="seg" data-nl="set">A whole set</button>
    </div>
    <div id="nl-name">
      <label class="editor-label" for="nl-query">Pokémon or card name</label>
      <input id="nl-query" placeholder="e.g. Umbreon, Sylveon, Charizard" autocomplete="off">
      <label class="editor-label" for="nl-lang">Cards from</label>
      <select id="nl-lang">${Object.entries(LANG_NAMES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
    </div>
    <div id="nl-set" hidden>
      <label class="editor-label" for="nl-setsel">Set</label>
      <select id="nl-setsel"><option value="">Loading sets…</option></select>
    </div>
    <p class="status error" id="nl-status"></p>
    <div class="editor-actions"><span></span><button class="btn primary">Create checklist</button></div>
  </form>`;
  showModal();
  $('#nl-query').focus();
  try {
    const sets = await getSets();
    const opt = s => `<option value="${esc(s.id)}">${esc(s.label)}${s.date ? ` (${s.date.slice(0, 4)})` : ''}</option>`;
    const newest = list => [...list].sort((a, b) => b.date.localeCompare(a.date)).map(opt).join('');
    if ($('#nl-setsel')) $('#nl-setsel').innerHTML = `<option value="">Choose a set…</option>
      <optgroup label="🇬🇧 English sets (newest first)">${newest(sets.en)}</optgroup>
      <optgroup label="🇯🇵 Japanese sets (newest first)">${newest(sets.ja)}</optgroup>`;
  } catch (err) {
    if ($('#nl-status')) $('#nl-status').textContent = `Couldn't load sets: ${err.message}`;
  }
}

$('#modal-body').addEventListener('click', e => {
  const kind = e.target.closest('[data-nl]')?.dataset.nl;
  if (!kind || ui.modal?.type !== 'newlist') return;
  ui.modal.kind = kind;
  $$('[data-nl]').forEach(b => b.classList.toggle('active', b.dataset.nl === kind));
  $('#nl-name').hidden = kind !== 'name';
  $('#nl-set').hidden = kind !== 'set';
});

$('#modal-body').addEventListener('submit', async e => {
  if (!e.target.matches('[data-newlist]')) return;
  e.preventDefault();
  let spec, name;
  if (ui.modal.kind === 'set') {
    const setId = $('#nl-setsel').value;
    if (!setId) return ($('#nl-status').textContent = 'Choose a set first.');
    spec = { type: 'set', setId };
    name = setsCache?.byId.get(setId)?.label || 'Set';
  } else {
    let query = $('#nl-query').value.trim();
    if (!query) return ($('#nl-status').textContent = 'Type a Pokémon name first.');
    if (hasJapanese(query)) query = (await englishName(query)) || query; // the card list uses English names
    const langChoice = $('#nl-lang').value;
    spec = { type: 'name', query, lang: langChoice };
    name = `All ${query}${langChoice === 'both' ? '' : langChoice === 'ja' ? ' (Japanese)' : ' (English)'}`;
  }
  const l = store.createList('checklist', name, spec);
  $('#modal').close();
  ui.list = { key: l.id, id: l.id, name, spec, saved: true };
  showView('list');
});

// ---------- views & tabs ----------
function showView(view) {
  ui.view = view;
  const seg = { binder: 'shelf', list: 'lists' }[view] || view;
  $$('#binder-seg .seg').forEach(b => b.classList.toggle('active', b.dataset.view === seg));
  $('#view-shelf').hidden = view !== 'shelf';
  $('#view-binder').hidden = view !== 'binder';
  $('#view-lists').hidden = view !== 'lists';
  $('#view-list').hidden = view !== 'list';
  window.scrollTo(0, 0);
  if (view === 'shelf') renderShelf();
  else if (view === 'binder') renderBinderView();
  else if (view === 'lists') renderLists();
  else renderListView();
}
$$('#binder-seg .seg').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));

$$('.tabbtn').forEach(b => b.addEventListener('click', () => {
  ui.tab = b.dataset.tab;
  $$('.tabbtn').forEach(x => x.classList.toggle('active', x === b));
  $$('.tab').forEach(t => t.classList.toggle('active', t.id === `tab-${ui.tab}`));
  if (ui.tab === 'binders') showView(ui.view);
  window.scrollTo(0, 0);
}));

// ---------- upgrade cards saved before the catalog existed ----------
// Older versions stored TCGdex ids; find the same card in the catalog and switch over,
// keeping quantities, so checklists count them.
let upgrading = false;
async function upgradeLegacyCards() {
  const legacy = [...store.allEntries().map(x => x.card), ...Object.values(store.wishlist()?.spec.cards || {})]
    .filter((c, i, arr) => isLegacy(c.id) && arr.findIndex(x => x.id === c.id) === i);
  if (!legacy.length || upgrading) return;
  upgrading = true;
  try {
    const sets = await getSets();
    for (const old of legacy) {
      const ja = old.id.startsWith('ja:');
      const pool = await catalog.cards(ja ? 'ja' : 'en');
      let match = [];
      if (ja) {
        const code = old.id.slice(3, old.id.lastIndexOf('-'));
        const set = sets.byCode.ja.get(code.toLowerCase());
        if (set) match = pool.filter(c => c.setId === set.id && sameNumber(c.localId, old.localId));
      } else {
        const key = nameKey(old.name);
        match = pool.filter(c => nameKey(c.name) === key && sameNumber(c.localId, old.localId));
        if (match.length > 1 && old.setName) {
          const bySet = match.filter(c => nameKey(c.setName).includes(nameKey(old.setName)));
          if (bySet.length) match = bySet;
        }
      }
      // Several versions with the same number (e.g. "Pikachu" and "Pikachu (Master Ball Mirror)"):
      // the plain one – shortest name – is the regular card.
      match.sort((a, b) => a.name.length - b.name.length);
      if (match.length && (match.length === 1 || match[0].name.length < match[1].name.length)) store.replaceCard(old.id, match[0]);
    }
  } catch (err) {
    console.warn('Card upgrade skipped', err);
  } finally {
    upgrading = false;
  }
}

// Re-draw whatever is on screen when binder data changes (here or on another device).
function render() {
  renderAccount();
  renderTarget();
  renderResults();
  if (ui.tab === 'binders') {
    if (ui.view === 'shelf') renderShelf();
    else if (ui.view === 'binder') renderBinderView();
    else if (ui.view === 'lists') renderLists();
    else renderListView();
  }
  if (ui.modal?.type === 'card') drawCard();
  clearTimeout(upgradeTimer);
  upgradeTimer = setTimeout(upgradeLegacyCards, 1500);
}
let upgradeTimer;
store.onChange(render);

// ---------- account ----------
function renderAccount() {
  const btn = $('#account');
  if (!store.user) { btn.textContent = 'Sign in'; btn.className = 'account-btn'; return; }
  const label = { saving: '⟳ Saving', saved: '☁ Synced', offline: '⚠ Offline' }[store.syncStatus] || '☁';
  btn.textContent = label;
  btn.className = `account-btn signed-in ${store.syncStatus}`;
  if (ui.modal?.type === 'account') drawAccount();
}

$('#account').addEventListener('click', () => { ui.modal = { type: 'account', mode: 'signin' }; drawAccount(); showModal(); });

function drawAccount(message = '', isError = false) {
  const { mode } = ui.modal;
  const note = message ? `<p class="status${isError ? ' error' : ''}">${esc(message)}</p>` : '';
  if (mode === 'newpass') {
    $('#modal-body').innerHTML = `<form class="account" data-form="newpass">
      <h3>Choose a new password</h3>
      <input type="password" id="acc-pass" autocomplete="new-password" placeholder="New password (6+ characters)" minlength="6" required>
      ${note}<button class="btn primary">Save password</button></form>`;
    return;
  }
  if (store.user) {
    const status = { saving: 'Saving changes…', saved: 'All changes saved to the cloud.', offline: "Offline – changes are saved on this device and will sync when you're back online." }[store.syncStatus] || '';
    $('#modal-body').innerHTML = `<div class="account">
      <h3>Your account</h3>
      <p>Signed in as <b>${esc(store.user.email)}</b></p>
      <p class="meta">${esc(status)}</p>
      <p class="meta">Sign in with the same email on your phone and PC and they'll show the same binders.</p>
      ${note}<button class="btn ghost" data-account="signout">Sign out</button>
    </div>`;
    return;
  }
  const signup = mode === 'signup';
  $('#modal-body').innerHTML = `<form class="account" data-form="${mode}">
    <h3>${signup ? 'Create an account' : 'Sign in'}</h3>
    <p class="meta">Your binders sync between your phone and PC when you're signed in.</p>
    <input type="email" id="acc-email" autocomplete="email" placeholder="Email" required>
    <input type="password" id="acc-pass" autocomplete="${signup ? 'new-password' : 'current-password'}" placeholder="Password${signup ? ' (6+ characters)' : ''}" minlength="6" required>
    ${note}
    <button class="btn primary">${signup ? 'Create account' : 'Sign in'}</button>
    <p class="switch">${signup
      ? `Already have an account? <button type="button" class="linkish" data-account="signin">Sign in</button>`
      : `New here? <button type="button" class="linkish" data-account="signup">Create an account</button>
         · <button type="button" class="linkish" data-account="forgot">Forgot password?</button>`}</p>
  </form>`;
}

$('#modal-body').addEventListener('click', async e => {
  const act = e.target.closest('[data-account]')?.dataset.account;
  if (!act || ui.modal?.type !== 'account') return;
  if (act === 'signout') { await store.signOut(); $('#modal').close(); toast('Signed out'); return; }
  if (act === 'forgot') {
    const email = $('#acc-email').value.trim();
    if (!email) return drawAccount('Type your email above first, then press "Forgot password?"', true);
    try { await store.resetPassword(email); drawAccount('Check your email for a link to reset your password.'); }
    catch (err) { drawAccount(err.message, true); }
    return;
  }
  ui.modal.mode = act;
  drawAccount();
});

$('#modal-body').addEventListener('submit', async e => {
  const form = e.target.closest('[data-form]');
  if (!form || ui.modal?.type !== 'account') return;
  e.preventDefault();
  const button = form.querySelector('.btn.primary');
  button.disabled = true;
  const email = $('#acc-email')?.value.trim();
  const password = $('#acc-pass').value;
  try {
    if (form.dataset.form === 'signin') {
      await store.signIn(email, password);
      $('#modal').close();
      toast('Signed in – syncing your binders');
    } else if (form.dataset.form === 'signup') {
      const { needsConfirm } = await store.signUp(email, password);
      if (needsConfirm) { ui.modal.mode = 'signin'; drawAccount('Almost done! Open the confirmation email we just sent, then sign in here.'); }
      else { $('#modal').close(); toast('Account created'); }
    } else if (form.dataset.form === 'newpass') {
      await store.updatePassword(password);
      $('#modal').close();
      toast('Password updated');
    }
  } catch (err) {
    drawAccount(err.message, true);
  } finally {
    button.disabled = false;
  }
});

// Arriving from a "reset password" email link.
store.sb.auth.onAuthStateChange(event => {
  if (event === 'PASSWORD_RECOVERY') setTimeout(() => { ui.modal = { type: 'account', mode: 'newpass' }; drawAccount(); showModal(); }, 0);
});

// ---------- what's new ----------
const SEEN_KEY = 'pkbinder.seenVersion';
const latest = CHANGELOG[0].version;
function renderVersion() {
  let seen = null;
  try { seen = localStorage.getItem(SEEN_KEY); } catch {}
  const btn = $('#whats-new');
  btn.textContent = `v${latest}`;
  btn.classList.toggle('unseen', seen !== latest);
  btn.title = seen !== latest ? 'New update – see what’s new' : 'What’s new';
}
$('#whats-new').addEventListener('click', () => {
  ui.modal = { type: 'changelog' };
  $('#modal-body').innerHTML = `<div class="changelog">
    <h3>What’s new</h3>
    ${CHANGELOG.map(c => `<section>
      <div class="cl-head"><span class="cl-version">v${esc(c.version)}</span><b>${esc(c.title)}</b><small>${esc(c.date)}</small></div>
      <ul>${c.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>
    </section>`).join('')}
  </div>`;
  showModal();
  try { localStorage.setItem(SEEN_KEY, latest); } catch {}
  renderVersion();
});

// ---------- backup ----------
// The ⋯ menu closes after picking something, or when tapping elsewhere.
document.addEventListener('click', e => {
  const menu = $('#more-menu');
  if (menu.open && (!menu.contains(e.target) || e.target.closest('.menu'))) setTimeout(() => menu.removeAttribute('open'), 0);
});

$('#export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(store.exportData(), null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `pokebinder-${new Date().toISOString().slice(0, 10)}.json`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#import').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!confirm('Merge this backup into your binders?')) return;
    const n = store.importData(data);
    toast(`Imported ${n} cards`);
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  }
});

renderLang();
renderVersion();
render();
getSets().then(render).catch(() => {}); // set names for binder headings

// Test hook for local development only.
if (location.hostname === 'localhost') window.__pb = { readCard, matchScan, pictureCheck, findCards, fileToCanvas, getSets, catalog, store };
