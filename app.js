// PokéBinder – scan Pokémon cards and keep digital binders, a wishlist and checklists.
// Card list & pictures: TCGplayer's catalog (via TCGCSV), built into ./catalog by tools/build_catalog.py.
// OCR: Tesseract.js, runs entirely in the browser.
import * as store from './data.js?v=7';
import * as catalog from './catalog.js?v=7';

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

// Set code printed on the card: Japanese "SV2a" (bottom left), newer English cards "MEW".
// OCR often gets one character of a Japanese code wrong ("sv20"), so allow one mistake
// when the set size also fits.
function findSetCode(text, sets, total, language) {
  const pool = language === 'ja' ? sets.ja : sets.en;
  const fits = s => !!total && s.totals.some(t => sameNumber(t, total));
  const tokens = text.split(/[^A-Za-z0-9.\-]+/).filter(t => t.length >= 2 && t.length <= 7 && /[a-z]/i.test(t));
  for (const t of tokens) {
    const set = sets.byCode[language].get(t.toLowerCase());
    // English codes are plain words, so only trust them when the set size agrees.
    if (set && (fits(set) || (language === 'ja' && /\d/.test(t)))) return set.id;
  }
  if (language !== 'ja' || !total) return '';
  const coded = tokens.filter(t => /\d/.test(t));
  let best = null;
  for (const s of pool) {
    if (!s.code || !fits(s)) continue;
    const d = Math.min(...coded.map(t => editDistance(t.toLowerCase(), s.code.toLowerCase())), 9);
    if (d <= 1 && (!best || d < best.d)) best = { d, id: s.id };
  }
  if (best) return best.id;
  const bySize = pool.filter(fits); // no readable code, but only one set has this many cards
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
const bottomStrip = (src, mode) => enhancedCrop(src, 0, 0.86, 1, 1, 2400, mode); // collector number
const leftBottomStrip = (src, mode) => enhancedCrop(src, 0, 0.88, 0.5, 0.99, 1800, mode); // set code + number, bottom left

/**
 * Read the collector number ("65/190") and, for Japanese cards, the set code ("SV4a").
 * The photo may show the table around the card, so first look for the number anywhere,
 * then zoom in on that line; also read the usual bottom strips. Every reading votes.
 */
async function readCardNumber(canvas, language) {
  const sets = await getSets();
  const pool = language === 'ja' ? sets.ja : sets.en;
  // A reading only counts if some set really has that many cards ("077/972" can't be right).
  const sizes = new Set(pool.flatMap(s => s.totals.map(t => String(+t))));
  const plausible = (number, total) => sizes.has(String(+total)) && +number <= 450;
  // Every "number/size" found in every reading votes; number and set size are voted on
  // separately so one misread digit doesn't sink an otherwise good reading.
  const numVotes = new Map(), totalVotes = new Map();
  const bump = (m, k, w) => m.set(k, (m.get(k) || 0) + w);
  const fix = s => s.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1');
  const texts = [];
  const readings = text => [...text.matchAll(/([0-9OoIl|]{1,3})\s*[\/⁄]\s*([0-9OoIl|]{2,3})(?![0-9])/g)]
    .map(m => [String(parseInt(fix(m[1]), 10)), String(parseInt(fix(m[2]), 10))])
    .filter(([n, t]) => +n > 0 && plausible(n, t));
  const read = (text, weight) => {
    texts.push(text);
    for (const [n, t] of readings(text)) { bump(numVotes, n, weight); bump(totalVotes, t, weight); }
  };

  status('Reading card…');
  const eng = await getWorker('eng');
  const num = await getWorker('num');
  // The whole card gives us English names, and tells us where the number is.
  const { data } = await eng.recognize(canvas);
  read(data.text, 1);

  status('Reading card number…');
  const crops = [];
  const hit = (data.words || []).find(w => readings(w.text).length);
  if (hit) { // zoom in on wherever the number was spotted
    const h = Math.max(8, hit.bbox.y1 - hit.bbox.y0);
    const x0 = Math.max(0, hit.bbox.x0 - h * 14), x1 = Math.min(canvas.width, hit.bbox.x1 + h * 3);
    const y0 = Math.max(0, hit.bbox.y0 - h * 1.3), y1 = Math.min(canvas.height, hit.bbox.y1 + h * 1.3);
    crops.push([3, mode => enhancedCrop(canvas, x0 / canvas.width, y0 / canvas.height, x1 / canvas.width, y1 / canvas.height, 1800, mode)]);
  }
  if (language === 'ja') crops.push([2, mode => leftBottomStrip(canvas, mode)]); // set code + number, bottom left
  crops.push([2, mode => bottomStrip(canvas, mode)]);
  for (const [weight, crop] of crops) {
    for (const mode of ['contrast', 'threshold']) read((await num.recognize(crop(mode))).data.text, weight);
  }

  const ranked = m => [...m].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const number = ranked(numVotes)[0] || '';
  let total = ranked(totalVotes).find(t => plausible(number, t)) || '';
  const setCode = findSetCode(texts.join('\n'), sets, total, language);
  // Trust a clearly-read set code over a misread set size.
  const set = setCode && sets.byId.get(setCode);
  if (set && total && set.totals.length && !set.totals.some(t => sameNumber(t, total))) total = String(+set.totals[0]);
  return { number, total, setCode, data, texts, numVotes, totalVotes };
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

async function scanCanvas(canvas, previewUrl) {
  ui.lastScan = canvas;
  $('#preview').src = previewUrl;
  $('.preview-wrap').hidden = false;
  $('#results-head').textContent = '';
  $('#results').innerHTML = '';
  const language = lang;
  const { number, total, setCode, data } = await readCardNumber(canvas, language);
  // Japanese names can't be read reliably (stylised fonts), so Japanese cards are found by
  // set code + number – the same way collectors look them up. English names read fine.
  const names = language === 'ja' ? [] : parseOcr(data, canvas.height).names;
  const code = setCode && setsCache?.byId.get(setCode)?.code;
  const numberText = number ? (total ? `${number.padStart(3, '0')}/${total}` : number) : '';

  $('#q-name').value = names[0] || '';
  $('#q-number').value = [code, numberText].filter(Boolean).join(' ');
  if (!names.length && !number) {
    status(language === 'ja'
      ? "Couldn't read the card number. Try again closer, with less glare on the bottom-left corner (e.g. “SV4a 065/190”) – or type it below."
      : "Couldn't read this card. Try again closer, with less glare – or type the name below.", true);
    return;
  }
  status(`Read: ${[names[0], code, numberText && `#${numberText}`].filter(Boolean).join(' · ')}. If that's wrong, fix it below and press Find.`);
  await runSearch({ names, number, total, setCode, language });
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
    await scanCanvas(canvas, canvas.toDataURL('image/jpeg', 0.8));
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
  $('#q-name').placeholder = lang === 'ja' ? 'Pikachu or ピカチュウ' : 'e.g. Pikachu';
  $('#q-number').placeholder = lang === 'ja' ? 'SV4a 065/190' : '25/165';
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
  $('#results-head').innerHTML = (ui.results.length
    ? `Tap the card that matches yours${ui.results.length >= 150 ? ' (first 150 – add a number to narrow it down)' : ''}:`
    : `No matches. Check the spelling, try just the name, or switch between English and Japanese cards.`) +
    ` <button class="linkish" id="manual-add">Can't find it? Add it yourself</button>`;
  $('#results').innerHTML = ui.results.map(c => tile(c, { showSet: true })).join('');
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

// ---------- tiles & card modal ----------
// qty: number on the badge (defaults to copies across all binders); missing: grey out if not owned;
// showSet: label with the set code too, for lists that mix sets.
function tile(card, { qty = store.ownedTotal(card.id), missing = false, times = false, showSet = false } = {}) {
  const src = imgUrl(card);
  const code = showSet ? setsCache?.byId.get(card.setId)?.code : '';
  return `<button class="tile${missing && !qty ? ' missing' : ''}" data-card="${esc(card.id)}" title="${esc(card.name)}">
    ${src ? `<img src="${esc(src)}" alt="${esc(card.name)}" loading="lazy">` : `<span class="noimg"><b>${esc(card.name)}</b><small>No picture yet</small></span>`}
    ${qty ? `<span class="badge">${times ? '×' : '✓ '}${qty}</span>` : ''}
    ${store.wanted(card.id) ? '<span class="want-tag" title="On your wishlist">★</span>' : ''}
    <span class="num">${esc([code, card.localId].filter(Boolean).join(' '))}</span>
    ${langOfCard(card) === 'ja' ? '<span class="lang-tag">JP</span>' : ''}
  </button>`;
}

document.addEventListener('click', e => {
  const t = e.target.closest('[data-card]');
  if (t) openCard(t.dataset.card);
});

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

function openCard(id) {
  if (!cardInfo(id)) return;
  ui.modal = { type: 'card', id };
  drawCard();
  loadPrice(id);
  showModal();
}

function drawCard() {
  const { id } = ui.modal;
  const card = cardInfo(id);
  const own = store.ownership(id);
  const total = own.reduce((n, x) => n + x.qty, 0);
  const target = targetBinder();
  const want = store.wanted(id);
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
          <h3><span>${esc(s?.label || list[0].setName || setId)} <small>${list.length}${s ? ` / ${s.cards}` : ''}</small></span>
            ${s ? `<button class="linkish" data-open-set="${esc(setId)}">Checklist →</button>` : ''}</h3>
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
  if (set) openSetChecklist(set.dataset.openSet);
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
getSets().then(render).catch(() => {}); // set names for binder headings

// Test hook for local development only.
if (location.hostname === 'localhost') window.__pb = { readCardNumber, findCards, fileToCanvas, getSets, catalog, store };
