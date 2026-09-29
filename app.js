// PokéBinder – scan Pokémon cards and keep digital binders.
// Card data & images: TCGdex (https://tcgdex.dev), free, no API key.
// OCR: Tesseract.js, runs entirely in the browser.
import * as store from './data.js';

const API = 'https://api.tcgdex.net/v2';
const SETS_KEY = 'pkbinder.sets.v2';
const TARGET_KEY = 'pkbinder.target';
const LANG_KEY = 'pkbinder.lang';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Card ids: English cards use TCGdex ids as-is ("sv03.5-025"), Japanese ones are
// prefixed ("ja:SV2a-025"), and cards added by hand are "custom:<uuid>".
const langOf = id => id.startsWith('ja:') ? 'ja' : id.startsWith('custom:') ? 'custom' : 'en';
const rawId = id => id.replace(/^(ja|custom):/, '');
const setIdOf = id => {
  const raw = rawId(id);
  const set = raw.slice(0, raw.lastIndexOf('-'));
  return langOf(id) === 'ja' ? `ja:${set}` : set;
};
const imgUrl = (card, q = 'low') => !card.image ? '' : card.image.startsWith('data:') ? card.image : `${card.image}/${q}.webp`;
const hasJapanese = s => /[぀-ヿ一-鿿]/.test(s);

const ui = { tab: 'add', view: 'shelf', binderId: null, results: null, modal: null, lastQuery: null, lastScan: null };
let lang = localStorage.getItem(LANG_KEY) === 'ja' ? 'ja' : 'en';

// Every card we've seen from the API, so tiles can open the detail modal.
const seen = new Map();
const remember = cards => cards.forEach(c => seen.set(c.id, { ...seen.get(c.id), ...c }));

// ---------- card database ----------
async function api(path, language = 'en') {
  const r = await fetch(`${API}/${language}${path}`);
  if (!r.ok) throw new Error(`Card database error (${r.status})`);
  return r.json();
}

let setsCache = null;
async function getSets() {
  if (setsCache) return setsCache;
  let c = null;
  try { c = JSON.parse(localStorage.getItem(SETS_KEY)); } catch {}
  if (!c || Date.now() - c.t > 3 * 864e5) {
    const [sets, pocket, ja] = await Promise.all([api('/sets'), api('/series/tcgp'), api('/sets', 'ja')]);
    c = { t: Date.now(), sets, ja, pocket: pocket.sets.map(s => s.id) };
    localStorage.setItem(SETS_KEY, JSON.stringify(c));
  }
  const pocket = new Set(c.pocket); // TCG Pocket is digital-only – hide it
  const en = c.sets.filter(s => !pocket.has(s.id)).map(s => ({ ...s, code: s.id, lang: 'en' }));
  const ja = c.ja.map(s => ({ ...s, id: `ja:${s.id}`, code: s.id, lang: 'ja' }));
  return (setsCache = {
    en, ja, pocket,
    byId: new Map([...en, ...ja].map(s => [s.id, s])),
    jaByCode: new Map(ja.map(s => [s.code.toLowerCase(), s])), // "sv2a" → set, for set codes read off cards
  });
}

const setDetailCache = new Map();
function getSet(id) {
  if (!setDetailCache.has(id)) {
    const language = langOf(id) === 'ja' ? 'ja' : 'en';
    const load = api(`/sets/${encodeURIComponent(rawId(id))}`, language).then(set => {
      set.cards = (set.cards || []).map(c => ({ ...c, id: language === 'ja' ? `ja:${c.id}` : c.id }));
      return set;
    });
    setDetailCache.set(id, load.catch(err => { setDetailCache.delete(id); throw err; }));
  }
  return setDetailCache.get(id);
}

// English name → National Pokédex numbers, so "Pikachu" can find ピカチュウ.
const dexCache = new Map();
async function dexIdsFor(name) {
  const key = name.toLowerCase();
  if (!dexCache.has(key)) {
    dexCache.set(key, (async () => {
      const base = name.replace(/\s+(ex|gx|v|vmax|vstar|break|lv\.?\s*x|prime|legend)$/i, '');
      const en = await api('/cards?' + new URLSearchParams({ name: base })).catch(() => []);
      const pick = en.find(c => c.name.toLowerCase() === base.toLowerCase()) || en[0];
      if (!pick) return [];
      const full = await api(`/cards/${encodeURIComponent(pick.id)}`).catch(() => null);
      return full?.dexId || [];
    })());
  }
  return dexCache.get(key);
}

/**
 * Find candidate cards.
 * names: possible card names (from OCR or typed), number: collector number ("25"),
 * total: printed set size ("165") used to pick the right set,
 * setCode: Japanese set code read off the card ("ja:SV2a").
 */
async function findCards({ names = [], number = '', total = '', setCode = '', language = 'en' }) {
  const sets = await getSets();
  const ja = language === 'ja';
  const found = new Map();
  const add = list => list.forEach(c => { if (!sets.pocket.has(setIdOf(c.id))) found.set(c.id, c); });
  const query = params => api('/cards?' + new URLSearchParams(params), language)
    .then(list => ja ? list.map(c => ({ ...c, id: `ja:${c.id}` })) : list)
    .catch(() => []);
  const setMatches = c => {
    const s = sets.byId.get(setIdOf(c.id));
    return !!s && (s.cardCount.official == total || s.cardCount.total == total);
  };
  const sameNumber = c => parseInt(c.localId, 10) === parseInt(number, 10) || c.localId.toLowerCase() === number.toLowerCase();

  // Japanese cards print their set code (e.g. "SV2a"), which pins down the exact card.
  if (setCode && number) {
    const set = await getSet(setCode).catch(() => null);
    add((set?.cards || []).filter(sameNumber).map(c => ({ ...c, setName: set.name })));
  }

  for (const name of names) {
    const p = number ? { localId: number } : {};
    if (ja && !hasJapanese(name)) {
      // English name typed for a Japanese card: search by Pokédex number instead.
      for (const dex of (await dexIdsFor(name)).slice(0, 2)) add(await query({ ...p, dexId: `eq:${dex}` }));
    } else {
      let hits = await query({ ...p, name });
      if (!hits.length && ja) {
        // Misread Japanese name: the name search matches parts of names, so try it with a few
        // characters dropped from the front ("ヒビカチュウ" → "カチュウ") or one stray character removed
        // ("マンツキー" → "マンキー").
        const variants = new Set();
        for (let i = 1; i <= 3; i++) variants.add(name.slice(i));
        if (name.length <= 8) for (let i = 0; i < name.length; i++) variants.add(name.slice(0, i) + name.slice(i + 1));
        const tries = [...variants].filter(v => v.length >= 3 && v !== name);
        hits = (await Promise.all(tries.map(v => query({ ...p, name: v })))).flat();
      }
      add(hits);
    }
  }
  // Name unreadable/wrong but we have the number: search by number, narrow by set size.
  if (number && ![...found.values()].some(c => !total || setMatches(c))) {
    const byNumber = await query({ localId: number });
    add(total ? byNumber.filter(setMatches) : byNumber.slice(0, 60));
  }

  let results = [...found.values()];
  if (number) { // the database matches "50" inside "550" – keep exact numbers when there are any
    const exact = results.filter(sameNumber);
    if (exact.length) results = exact;
  }
  const lower = names.map(n => n.toLowerCase());
  const score = c =>
    (setCode && setIdOf(c.id) === setCode ? 8 : 0) +
    (total && setMatches(c) ? 4 : 0) +
    (lower.includes(c.name.toLowerCase()) ? 2 : 0) +
    (c.image ? 1 : 0);
  results.sort((a, b) => score(b) - score(a));
  results = results.slice(0, 60);
  results.forEach(c => {
    const s = sets.byId.get(setIdOf(c.id));
    c.setName = s && (s.lang === 'ja' ? `${s.code} ${s.name}` : s.name);
  });
  remember(results);
  return results;
}

// ---------- OCR ----------
const workers = new Map();
function getWorker(language = 'eng') {
  if (!workers.has(language)) {
    workers.set(language, Tesseract.createWorker(language, 1, {
      logger: m => {
        if (m.status === 'recognizing text') status(`Reading card… ${Math.round(m.progress * 100)}%`);
        else if (m.status?.startsWith('loading')) status(`Loading ${language === 'jpn' ? 'Japanese ' : ''}text reader (first time only)…`);
      },
    }));
  }
  return workers.get(language);
}

// Japanese name: the longest run of kana/kanji in the name area (skipping words like たね/進化).
const JP_STOP = /^(たね|進化|1進化|2進化|ポケモン|トレーナーズ|グッズ|サポート|スタジアム|エネルギー|HP)$/;
function parseJpName(text) {
  const clean = text.replace(/\s+/g, '');
  const runs = [
    ...(clean.match(/[゠-ヿー]{3,}/g) || []), // katakana – most Pokémon names
    ...(clean.match(/[゠-ヿ぀-ゟ一-鿿ー]{2,}/g) || []),
  ].filter(r => !JP_STOP.test(r));
  return [...new Set(runs)].slice(0, 2);
}

// Japanese set code printed at the bottom left, e.g. "SV2a" → "ja:SV2a".
// OCR often gets one character wrong ("sv20"), so allow one mistake when the set size also fits.
function findSetCode(text, sets, total) {
  const tokens = text.split(/[^A-Za-z0-9.\-]+/).filter(t => /[a-z]/i.test(t) && /\d/.test(t) && t.length <= 7);
  for (const t of tokens) {
    const set = sets.jaByCode.get(t.toLowerCase());
    if (set) return set.id;
  }
  const fits = s => total && (s.cardCount.official == total || s.cardCount.total == total);
  let best = null;
  for (const s of sets.ja) {
    const d = Math.min(...tokens.map(t => editDistance(t.toLowerCase(), s.code.toLowerCase())), 9);
    if (d <= 1 && fits(s) && (!best || d < best.d)) best = { d, id: s.id };
  }
  if (best) return best.id;
  const bySize = sets.ja.filter(fits); // no readable code, but only one set has this many cards
  return bySize.length === 1 ? bySize[0].id : '';
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
const bottomStrip = src => enhancedCrop(src, 0, 0.86, 1, 1, 2400); // collector number
const jpBottomStrip = src => enhancedCrop(src, 0, 0.88, 0.5, 0.99, 1800); // set code + number (Japanese layout)
const nameStrip = src => enhancedCrop(src, 0, 0.02, 0.78, 0.15, 1600); // card name (Japanese layout)
function enhancedCrop(src, x0, y0, x1, y1, width) {
  const sx = Math.round(src.width * x0), sy = Math.round(src.height * y0);
  const sw = Math.round(src.width * x1) - sx, sh = Math.round(src.height * y1) - sy;
  const scale = Math.max(1, width / sw);
  const c = document.createElement('canvas');
  c.width = Math.round(sw * scale);
  c.height = Math.round(sh * scale);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const v = Math.max(0, Math.min(255, (g - 128) * 1.8 + 128));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return c;
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
    const canvas = await fileToCanvas(file, 1600);
    ui.lastScan = canvas;
    $('#preview').src = URL.createObjectURL(file);
    $('.preview-wrap').hidden = false;
    status('Reading card…');
    const language = lang;
    const eng = await getWorker('eng');
    let names = [], number = '', total = '', setCode = '';

    if (language === 'ja') {
      const sets = await getSets();
      let strip = await eng.recognize(jpBottomStrip(canvas));
      ({ number, total } = parseOcr({ text: strip.data.text, words: [] }, 0));
      if (!number) { // older layouts print the number further right
        strip = await eng.recognize(bottomStrip(canvas));
        ({ number, total } = parseOcr({ text: strip.data.text, words: [] }, 0));
      }
      setCode = findSetCode(strip.data.text, sets, total);
      status('Reading Japanese name…');
      const top = await (await getWorker('jpn')).recognize(nameStrip(canvas));
      names = parseJpName(top.data.text);
    } else {
      const { data } = await eng.recognize(canvas);
      ({ names, number, total } = parseOcr(data, canvas.height));
      if (!total) {
        status('Reading card number…');
        const strip = await eng.recognize(bottomStrip(canvas));
        const n = parseOcr({ text: strip.data.text, words: [] }, 0);
        if (n.number) ({ number, total } = n);
      }
    }

    $('#q-name').value = names[0] || '';
    $('#q-number').value = number ? (total ? `${number}/${total}` : number) : '';
    if (!names.length && !number) {
      status("Couldn't read this card. Try a closer photo with less glare, or type the name below.", true);
      return;
    }
    const code = setCode && setsCache?.byId.get(setCode)?.code;
    status(`Read: ${[names[0], code, number && (total ? `#${number}/${total}` : `#${number}`)].filter(Boolean).join(' · ')}. If that's wrong, fix it below and press Find.`);
    await runSearch({ names, number, total, setCode, language });
  } catch (err) {
    console.error(err);
    status(`Something went wrong: ${err.message}`, true);
  }
});

$('#search-form').addEventListener('submit', e => {
  e.preventDefault();
  const name = $('#q-name').value.trim();
  const [number = '', total = ''] = $('#q-number').value.trim().split('/').map(s => s.trim().replace(/^0+(?=\d)/, ''));
  if (!name && !number) return;
  runSearch({ names: name ? [name] : [], number, total, language: lang });
});

// EN / JP switch
function renderLang() {
  $$('[data-lang]').forEach(b => b.classList.toggle('on', b.dataset.lang === lang));
  $('#q-name').placeholder = lang === 'ja' ? 'ピカチュウ or Pikachu' : 'e.g. Pikachu';
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
  const ja = ui.lastQuery?.language === 'ja';
  const englishForJa = ja && ui.lastQuery.names.some(n => !hasJapanese(n));
  $('#results-head').innerHTML = (ui.results.length
    ? 'Tap the card that matches yours:'
    : `No matches. ${englishForJa ? 'Try the Japanese name (e.g. ピカチュウ) – Trainer cards need it.' : 'Check the spelling or try just the name.'}`) +
    ` <button class="linkish" id="manual-add">Can't find it? Add it yourself</button>`;
  $('#results').innerHTML = ui.results.map(c => tile(c)).join('');
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
    <p class="meta">For cards that aren't in the card database yet (common with older Japanese sets).</p>
    <div class="manual-photo" id="manual-photo"></div>
    <label class="chip" for="manual-file">📷 ${ui.modal.photo ? 'Use a different photo' : 'Add a photo'}</label>
    <input type="file" id="manual-file" accept="image/*" capture="environment" hidden>
    <label class="editor-label" for="m-name">Card name</label>
    <input id="m-name" required maxlength="60" value="${esc($('#q-name').value)}">
    <div class="manual-row">
      <div><label class="editor-label" for="m-set">Set</label>
        <input id="m-set" maxlength="60" placeholder="${lang === 'ja' ? 'e.g. SV2a' : 'e.g. Base Set'}" value="${esc(set ? `${set.code} ${set.name}` : '')}"></div>
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

// ---------- tiles & card modal ----------
// qty: number to show on the badge; defaults to copies across all binders.
function tile(card, { qty = store.ownedTotal(card.id), missing = false, times = false } = {}) {
  const src = imgUrl(card);
  return `<button class="tile${missing && !qty ? ' missing' : ''}" data-card="${esc(card.id)}" title="${esc(card.name)}">
    ${src ? `<img src="${esc(src)}" alt="${esc(card.name)}" loading="lazy">` : `<span class="noimg"><b>${esc(card.name)}</b><small>No picture yet</small></span>`}
    ${qty ? `<span class="badge">${times ? '×' : '✓ '}${qty}</span>` : ''}
    <span class="num">${esc(card.localId)}</span>
    ${langOf(card.id) === 'ja' || String(card.setId).startsWith('custom:ja:') ? '<span class="lang-tag">JP</span>' : ''}
  </button>`;
}

document.addEventListener('click', e => {
  const t = e.target.closest('[data-card]');
  if (t) openCard(t.dataset.card);
});

function cardInfo(id) {
  const c = seen.get(id) || store.storedCard(id);
  if (!c) return null;
  const setId = c.setId || setIdOf(id);
  const set = setsCache?.byId.get(setId);
  return {
    id, name: c.name, localId: c.localId, image: c.image || '',
    setId, setName: c.setName || (set ? (set.lang === 'ja' ? `${set.code} ${set.name}` : set.name) : setId),
  };
}

function openCard(id) {
  if (!cardInfo(id)) return;
  ui.modal = { type: 'card', id };
  drawCard();
  if (langOf(id) !== 'custom') loadPrice(id);
  showModal();
}

function drawCard() {
  const { id } = ui.modal;
  const card = cardInfo(id);
  const own = store.ownership(id);
  const total = own.reduce((n, x) => n + x.qty, 0);
  const target = targetBinder();
  $('#modal-body').innerHTML = `<div class="detail">
    ${card.image ? `<img class="detail-img" src="${esc(imgUrl(card, 'high'))}" alt="${esc(card.name)}">` : ''}
    <h3>${esc(card.name)}</h3>
    <p class="meta">${langOf(id) === 'ja' ? '🇯🇵 ' : ''}${esc(card.setName)} · #${esc(card.localId)}${langOf(id) === 'custom' ? ' · added by you' : ''}</p>
    <p class="price">${esc(priceText.get(id) || '')}</p>
    ${own.length ? `<div class="own-list">
      <p class="owned-note">✓ You have ${total}</p>
      ${own.map(({ binder, qty }) => `<div class="own-row">
        <span class="own-name">${swatch(binder)}${esc(binder.name)}</span>
        <div class="stepper">
          <button class="btn" data-act="dec" data-binder="${esc(binder.id)}" aria-label="One less">−</button>
          <b>${qty}</b>
          <button class="btn" data-act="inc" data-binder="${esc(binder.id)}" aria-label="One more">+</button>
        </div>
      </div>`).join('')}
    </div>` : ''}
    <div class="add-row">
      <select id="add-to" aria-label="Binder">${store.binders().map(b =>
        `<option value="${esc(b.id)}"${b.id === target?.id ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}</select>
      <button class="btn primary" data-act="add">${own.length ? 'Add another' : 'Add to binder'}</button>
    </div>
  </div>`;
}

$('#modal-body').addEventListener('click', e => {
  const btn = e.target.closest('[data-act]');
  if (!btn || ui.modal?.type !== 'card') return;
  const card = cardInfo(ui.modal.id);
  const act = btn.dataset.act;
  if (act === 'add') {
    const binderId = $('#add-to').value;
    localStorage.setItem(TARGET_KEY, binderId);
    store.setQty(binderId, card, store.ownedTotal(card.id, binderId) + 1);
    toast(`Added ${card.name} to ${store.binder(binderId).name}`);
  } else if (act === 'inc' || act === 'dec') {
    const binderId = btn.dataset.binder;
    store.setQty(binderId, card, store.ownedTotal(card.id, binderId) + (act === 'inc' ? 1 : -1));
  }
});

const priceCache = new Map();
const priceText = new Map();
async function loadPrice(id) {
  if (!priceCache.has(id)) priceCache.set(id, api(`/cards/${encodeURIComponent(rawId(id))}`, langOf(id)).catch(() => null));
  const full = await priceCache.get(id);
  if (!full) return;
  // Pricing layout varies between cards; grab the first TCGplayer market / Cardmarket trend price.
  let usd = null, eur = null;
  JSON.stringify(full, (k, v) => {
    if (k === 'marketPrice' && typeof v === 'number' && usd == null) usd = v;
    if (k === 'trend' && typeof v === 'number' && eur == null) eur = v;
    return v;
  });
  const parts = [];
  if (usd != null) parts.push(`$${usd.toFixed(2)} TCGplayer`);
  if (eur != null) parts.push(`€${eur.toFixed(2)} Cardmarket`);
  priceText.set(id, [full.rarity, parts.length ? `≈ ${parts.join(' · ')}` : ''].filter(Boolean).join(' — '));
  if (ui.modal?.type === 'card' && ui.modal.id === id) $('#modal-body .price').textContent = priceText.get(id);
}

function showModal() { if (!$('#modal').open) $('#modal').showModal(); }
$('#modal').addEventListener('close', () => { ui.modal = null; });

let toastTimer;
function toast(msg) {
  document.querySelector('.toast')?.remove();
  const el = Object.assign(document.createElement('div'), { className: 'toast', textContent: msg });
  ($('#modal').open ? $('#modal') : document.body).append(el); // dialogs sit above the page
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2200);
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

function renderBinderView() {
  const b = store.binder(ui.binderId);
  const el = $('#view-binder');
  if (!b) return showView('shelf');
  const filterValue = $('#binder-filter')?.value || '';
  const f = filterValue.trim().toLowerCase();
  const all = store.cardsIn(b.id);
  const cards = all.filter(c => !f || c.name.toLowerCase().includes(f) || (c.setName || '').toLowerCase().includes(f));
  remember(cards);
  const groups = new Map();
  cards.forEach(c => { if (!groups.has(c.setId)) groups.set(c.setId, []); groups.get(c.setId).push(c); });

  const hadFocus = document.activeElement?.id === 'binder-filter';
  el.innerHTML = `
    <div class="binder-head">
      <button class="btn ghost back" data-nav="shelf">← Binders</button>
      <button class="btn ghost" data-edit="${esc(b.id)}">🎨 Edit cover</button>
    </div>
    <div class="binder-hero">
      ${coverHTML(b, 'mini')}
      <div><h2>${esc(b.name)}</h2><p class="meta">${all.length} unique · ${countIn(b.id)} total</p></div>
    </div>
    ${all.length ? `<input id="binder-filter" class="filter" placeholder="Filter this binder…" autocomplete="off" value="${esc(filterValue)}">` : ''}
    ${!all.length
      ? `<div class="empty">This binder is empty.<br>Go to <b>Add cards</b>, pick <b>${esc(b.name)}</b> and scan a card.</div>`
      : [...groups].map(([setId, list]) => {
        const s = setsCache?.byId.get(setId);
        return `<div class="set-group">
          <h3><span>${esc(list[0].setName || setId)} <small>${list.length}${s ? ` / ${s.cardCount.official}` : ''}</small></span>
            ${setId.startsWith('custom:') ? '' : `<button class="linkish" data-open-set="${esc(setId)}">Checklist →</button>`}</h3>
          <div class="grid">${list.sort(byNumber).map(c => tile(c, { qty: c.qty, times: true })).join('')}</div>
        </div>`;
      }).join('') || `<div class="empty">No cards match “${esc(f)}”.</div>`}`;
  if (hadFocus) {
    const input = $('#binder-filter');
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

$('#view-binder').addEventListener('input', e => { if (e.target.id === 'binder-filter') renderBinderView(); });
$('#view-binder').addEventListener('click', e => {
  if (e.target.closest('[data-nav="shelf"]')) return showView('shelf');
  const edit = e.target.closest('[data-edit]');
  if (edit) return openCoverEditor(edit.dataset.edit);
  const set = e.target.closest('[data-open-set]');
  if (set) {
    $('#set-scope').dataset.want = ui.binderId;
    showView('checklist', set.dataset.openSet);
  }
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

// ---------- set checklist ----------
async function fillSetSelect() {
  const sets = await getSets();
  const mine = new Set(store.allEntries().map(x => x.card.setId));
  const opt = s => `<option value="${esc(s.id)}">${s.lang === 'ja' ? `${esc(s.code)} · ` : ''}${esc(s.name)} (${s.cardCount.official || s.cardCount.total})</option>`;
  const current = $('#set-select').value;
  $('#set-select').innerHTML = `<option value="">Choose a set…</option>` +
    (mine.size ? `<optgroup label="Sets you collect">${[...sets.en, ...sets.ja].filter(s => mine.has(s.id)).map(opt).join('')}</optgroup>` : '') +
    `<optgroup label="🇬🇧 English sets (newest first)">${[...sets.en].reverse().map(opt).join('')}</optgroup>` +
    `<optgroup label="🇯🇵 Japanese sets (newest first)">${[...sets.ja].reverse().map(opt).join('')}</optgroup>`;
  $('#set-select').value = current;
}

function fillScopeSelect() {
  const sel = $('#set-scope');
  const want = sel.dataset.want ?? sel.value;
  delete sel.dataset.want;
  sel.innerHTML = `<option value="">All binders</option>` +
    store.binders().map(b => `<option value="${esc(b.id)}">${esc(b.name)}</option>`).join('');
  sel.value = store.binder(want) ? want : '';
}

async function renderChecklist() {
  const id = $('#set-select').value;
  const el = $('#set-view');
  if (!id) { el.innerHTML = `<div class="empty">Pick a set to see which cards you have and which you're missing.</div>`; return; }
  if (!setDetailCache.has(id)) el.innerHTML = `<div class="empty">Loading set…</div>`;
  try {
    const set = await getSet(id);
    if ($('#set-select').value !== id) return;
    const setName = langOf(id) === 'ja' ? `${rawId(id)} ${set.name}` : set.name;
    if (!set.cards.length) {
      el.innerHTML = `<div class="empty"><b>${esc(setName)}</b><br>The card list for this set isn't in the card database yet.<br>You can still add these cards with <b>Add cards → Can't find it? Add it yourself</b>.</div>`;
      return;
    }
    set.cards.forEach(c => { c.setName = setName; });
    remember(set.cards);
    const scope = $('#set-scope').value || undefined;
    const qtyOf = c => store.ownedTotal(c.id, scope);
    const have = set.cards.filter(qtyOf).length;
    const official = set.cardCount.official || set.cards.length;
    const pct = Math.min(100, Math.round((have / official) * 100));
    const cards = set.cards.filter(c => !$('#missing-only').checked || !qtyOf(c));
    el.innerHTML = `<div class="progress">
        <div class="row">
          <div><b>${esc(setName)}</b><br><small>${have} of ${official} (${pct}%)${set.cards.length > official ? ` · ${set.cards.length} incl. secret rares` : ''}</small></div>
          ${set.logo ? `<img src="${esc(set.logo)}.webp" alt="">` : ''}
        </div>
        <div class="bar"><span style="width:${pct}%"></span></div>
      </div>
      <div class="grid">${cards.map(c => tile(c, { qty: qtyOf(c), missing: true, times: true })).join('') || '<div class="empty">You have them all! 🎉</div>'}</div>`;
  } catch (err) {
    el.innerHTML = `<div class="empty">Couldn't load set: ${esc(err.message)}</div>`;
  }
}

$('#set-select').addEventListener('change', renderChecklist);
$('#set-scope').addEventListener('change', renderChecklist);
$('#missing-only').addEventListener('change', renderChecklist);

// ---------- views & tabs ----------
async function showView(view, setId) {
  ui.view = view;
  $$('#binder-seg .seg').forEach(b => b.classList.toggle('active', b.dataset.view === (view === 'binder' ? 'shelf' : view)));
  $('#view-shelf').hidden = view !== 'shelf';
  $('#view-binder').hidden = view !== 'binder';
  $('#view-checklist').hidden = view !== 'checklist';
  window.scrollTo(0, 0);
  if (view === 'shelf') return renderShelf();
  if (view === 'binder') return renderBinderView();
  fillScopeSelect();
  try {
    await fillSetSelect();
    if (setId) $('#set-select').value = setId;
    await renderChecklist();
  } catch (err) {
    $('#set-view').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}
$$('#binder-seg .seg').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));

$$('.tabbtn').forEach(b => b.addEventListener('click', () => {
  ui.tab = b.dataset.tab;
  $$('.tabbtn').forEach(x => x.classList.toggle('active', x === b));
  $$('.tab').forEach(t => t.classList.toggle('active', t.id === `tab-${ui.tab}`));
  if (ui.tab === 'binders') showView(ui.view);
  window.scrollTo(0, 0);
}));

// Re-draw whatever is on screen when binder data changes (here or on another device).
function render() {
  renderAccount();
  renderTarget();
  renderResults();
  if (ui.tab === 'binders') {
    if (ui.view === 'shelf') renderShelf();
    else if (ui.view === 'binder') renderBinderView();
    else { fillScopeSelect(); renderChecklist(); }
  }
  if (ui.modal?.type === 'card') drawCard();
}
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

// ---------- backup ----------
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
render();
getSets().catch(() => {}); // warm the set list cache
