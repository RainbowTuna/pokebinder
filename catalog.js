// The card catalog: every English and Japanese card, from TCGplayer's catalog via TCGCSV.
// Built daily by tools/build_catalog.py (GitHub Actions) into ./catalog/*.json.
// Pictures are shown straight from TCGplayer's image server.

const BASE = new URL('./catalog/', import.meta.url);
const IMG = 'https://tcgplayer-cdn.tcgplayer.com/product/';

export const imageUrl = (pid, size = '200w') => `${IMG}${pid}_${size}.jpg`;
export const productUrl = pid => `https://www.tcgplayer.com/product/${pid}`;

const load = name => fetch(new URL(name, BASE)).then(r => {
  if (!r.ok) throw new Error(`Couldn't load the card list (${r.status})`);
  return r.json();
});

let setsPromise = null;
/** All sets: { list, en, ja, byId: Map('g123' → set), byCode: { en: Map, ja: Map } } */
export function sets() {
  return (setsPromise ||= load('sets.json').then(data => {
    const list = data.sets.map(s => ({
      ...s,
      gid: s.id,
      id: `g${s.id}`,
      label: s.lang === 'ja' && s.code ? `${s.code} ${s.name}` : s.name,
    }));
    const byCode = { en: new Map(), ja: new Map() };
    for (const s of list) if (s.code) byCode[s.lang].set(s.code.toLowerCase(), s);
    return {
      rarities: data.rarities, list,
      en: list.filter(s => s.lang === 'en'), ja: list.filter(s => s.lang === 'ja'),
      byId: new Map(list.map(s => [s.id, s])), byCode,
    };
  }).catch(err => { setsPromise = null; throw err; }));
}

// "Umbreon (13)" → "Umbreon" (also done by the builder; kept here for older catalog files).
const NUMBER_LABEL = /\s+\([A-Za-z]{0,5}\d+[a-z]?\)$/;

const cardsPromise = {};
const byId = new Map();
/** Every card in one language ('en' | 'ja'), newest sets first. */
export function cards(lang) {
  return (cardsPromise[lang] ||= Promise.all([sets(), load(`cards-${lang}.json`)]).then(([s, data]) => {
    const list = data.rows.map(([pid, name, number, gid, rarity, img]) => {
      const set = s.byId.get(`g${gid}`);
      const [localId, total = ''] = number.split('/');
      const card = {
        id: `tp:${pid}`, pid, name: name.replace(NUMBER_LABEL, ''), number, localId, total, lang,
        setId: `g${gid}`, setName: set?.label || '', date: set?.date || '',
        rarity: s.rarities[rarity] || '', image: img ? imageUrl(pid) : '',
      };
      byId.set(card.id, card);
      return card;
    });
    list.sort((a, b) => b.date.localeCompare(a.date) || String(a.localId).localeCompare(String(b.localId), undefined, { numeric: true }));
    return list;
  }).catch(err => { delete cardsPromise[lang]; throw err; }));
}

export const allCards = async (lang = 'both') =>
  lang === 'both' ? [...await cards('en'), ...await cards('ja')] : cards(lang);

/** A card already loaded from the catalog (undefined if its language isn't loaded yet). */
export const cardById = id => byId.get(id);

export async function setCards(setId) {
  const set = (await sets()).byId.get(setId);
  if (!set) return [];
  return (await cards(set.lang))
    .filter(c => c.setId === setId)
    .sort((a, b) => String(a.localId).localeCompare(String(b.localId), undefined, { numeric: true }));
}

const pricePromise = {};
export async function price(card) {
  if (!card?.pid) return null;
  const prices = await (pricePromise[card.lang] ||= load(`prices-${card.lang}.json`).catch(() => ({})));
  return prices[card.pid] ?? null;
}
