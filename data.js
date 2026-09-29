// Binders, wishlist and checklists: kept in this browser (works offline / without an account)
// and, when signed in, synced to Supabase so every device shows the same collection.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const KEY = 'pkbinder.v2';
const QUEUE_KEY = 'pkbinder.queue.v1';

export const COLORS = ['#e3350d', '#2a75bb', '#3c8d40', '#7b4bb3', '#1d1d24', '#f2b705', '#e75a9c', '#1a9a9a', '#8a5a3b', '#9aa3ad'];
export const PATTERNS = ['ball', 'plain', 'stripes', 'dots', 'holo', 'grid'];

export let user = null;
export let syncStatus = 'guest'; // guest | saving | saved | offline

const listeners = new Set();
export const onChange = fn => listeners.add(fn);
const emit = () => listeners.forEach(fn => fn());

let state = loadLocal();
let queue = load(QUEUE_KEY, []);
let version = 0; // bumps on every local change, so a slow download can't overwrite newer edits

// ---------- local storage ----------
function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function blank(owner = null) { return { owner, binders: [], cards: {}, lists: [] }; }
function loadLocal() {
  const s = load(KEY, null);
  if (s?.binders) { s.lists ||= []; return s; }
  const fresh = blank();
  const old = load('pkbinder.v1', null); // first version had a single binder
  if (old?.cards && Object.keys(old.cards).length) {
    const b = makeBinder('My Binder', 0);
    fresh.binders.push(b);
    fresh.cards[b.id] = old.cards;
  }
  return fresh;
}
const saveLocal = () => localStorage.setItem(KEY, JSON.stringify(state));
const saveQueue = () => localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function makeBinder(name, i) {
  return {
    id: uuid(), name, position: i, created: new Date().toISOString(),
    cover: { color: COLORS[i % COLORS.length], pattern: 'ball', sticker: '', art: null },
  };
}

// ---------- reading ----------
export const binders = () => [...state.binders].sort((a, b) => a.position - b.position || a.created.localeCompare(b.created));
export const binder = id => state.binders.find(b => b.id === id);
export const cardsIn = id => Object.values(state.cards[id] || {});
export const allEntries = () => binders().flatMap(b => cardsIn(b.id).map(c => ({ binder: b, card: c })));
export function ownership(cardId) {
  return binders().map(b => ({ binder: b, qty: state.cards[b.id]?.[cardId]?.qty || 0 })).filter(x => x.qty);
}
export const ownedTotal = (cardId, binderId) =>
  binderId ? state.cards[binderId]?.[cardId]?.qty || 0 : ownership(cardId).reduce((n, x) => n + x.qty, 0);
export function storedCard(cardId) {
  for (const b of state.binders) if (state.cards[b.id]?.[cardId]) return state.cards[b.id][cardId];
  return wishlist()?.spec.cards?.[cardId] || null;
}

// Lists: one wishlist (kind 'wishlist', spec.cards = { id: card }) and any number of
// checklists (kind 'checklist', spec = { type: 'name', query, lang } or { type: 'set', setId }).
export const lists = () => [...state.lists].sort((a, b) => a.position - b.position || a.created.localeCompare(b.created));
export const list = id => state.lists.find(l => l.id === id);
export const wishlist = () => state.lists.find(l => l.kind === 'wishlist');
export const wanted = cardId => !!wishlist()?.spec.cards?.[cardId];

// ---------- writing ----------
const binderRow = b => ({ id: b.id, name: b.name, cover: b.cover, position: b.position });
const listRow = l => ({ id: l.id, kind: l.kind, name: l.name, spec: l.spec, position: l.position });
const cardMeta = c => ({ id: c.id, name: c.name, localId: c.localId, image: c.image || '', setId: c.setId, setName: c.setName });
const cardRow = (binderId, c) => ({
  binder_id: binderId, card_id: c.id, name: c.name, local_id: c.localId, image: c.image,
  set_id: c.setId, set_name: c.setName, qty: c.qty, added_at: new Date(c.added).toISOString(),
});

function commit(...ops) {
  version++;
  saveLocal();
  emit();
  if (!user) return;
  queue.push(...ops);
  saveQueue();
  flush();
}

export function createBinder(name) {
  const b = makeBinder(name, state.binders.reduce((m, x) => Math.max(m, x.position + 1), 0));
  state.binders.push(b);
  state.cards[b.id] = {};
  commit({ t: 'binder', row: binderRow(b) });
  return b;
}

export function updateBinder(id, patch) {
  const b = binder(id);
  if (!b) return;
  Object.assign(b, patch);
  commit({ t: 'binder', row: binderRow(b) });
}

export function deleteBinder(id) {
  state.binders = state.binders.filter(b => b.id !== id);
  delete state.cards[id];
  commit({ t: 'delBinder', id });
  ensureDefault();
}

/** card: { id, name, localId, image, setId, setName } */
export function setQty(binderId, card, qty) {
  const cards = (state.cards[binderId] ||= {});
  if (qty <= 0) {
    delete cards[card.id];
    commit({ t: 'delCard', binder_id: binderId, card_id: card.id });
    return;
  }
  const entry = cards[card.id] || {
    id: card.id, name: card.name, localId: card.localId, image: card.image || '',
    setId: card.setId, setName: card.setName, added: Date.now(),
  };
  entry.qty = qty;
  cards[card.id] = entry;
  commit({ t: 'card', row: cardRow(binderId, entry) });
}

export function createList(kind, name, spec) {
  const l = {
    id: uuid(), kind, name, spec, created: new Date().toISOString(),
    position: state.lists.reduce((m, x) => Math.max(m, x.position + 1), 0),
  };
  state.lists.push(l);
  commit({ t: 'list', row: listRow(l) });
  return l;
}

export function updateList(id, patch) {
  const l = list(id);
  if (!l) return;
  Object.assign(l, patch);
  commit({ t: 'list', row: listRow(l) });
}

export function deleteList(id) {
  state.lists = state.lists.filter(l => l.id !== id);
  commit({ t: 'delList', id });
}

export function setWanted(card, want) {
  let w = wishlist();
  if (!w) {
    if (!want) return;
    w = createList('wishlist', 'Wishlist', { cards: {} });
  }
  const cards = { ...(w.spec.cards || {}) };
  if (want) cards[card.id] = { ...cardMeta(card), added: Date.now() };
  else delete cards[card.id];
  updateList(w.id, { spec: { ...w.spec, cards } });
}

/** Swap an old card id for a catalog card everywhere (binders and wishlist), keeping quantities. */
export function replaceCard(oldId, card) {
  for (const b of state.binders) {
    const old = state.cards[b.id]?.[oldId];
    if (!old) continue;
    setQty(b.id, card, (state.cards[b.id][card.id]?.qty || 0) + old.qty);
    setQty(b.id, { id: oldId }, 0);
  }
  if (wanted(oldId)) { setWanted({ id: oldId }, false); setWanted(card, true); }
}

function ensureDefault() {
  if (!state.binders.length) createBinder('My Binder');
}

// ---------- backup ----------
export const exportData = () => ({ app: 'pokebinder', version: 3, binders: state.binders, cards: state.cards, lists: state.lists });

export function importData(data) {
  const ops = [];
  let count = 0;
  const addCards = (binderId, cards) => {
    const into = (state.cards[binderId] ||= {});
    for (const c of Object.values(cards || {})) {
      if (!c?.id || !(c.qty > 0)) continue;
      const mine = into[c.id];
      into[c.id] = mine ? { ...mine, qty: Math.max(mine.qty, c.qty) } : { ...c };
      ops.push({ t: 'card', row: cardRow(binderId, into[c.id]) });
      count++;
    }
  };
  if (Array.isArray(data?.binders)) {
    for (const b of data.binders) {
      if (!b?.id || !b.name) continue;
      if (!binder(b.id)) {
        state.binders.push({ ...makeBinder(b.name, state.binders.length), ...b });
        ops.push({ t: 'binder', row: binderRow(binder(b.id)) });
      }
      addCards(b.id, data.cards?.[b.id]);
    }
  } else if (data?.cards) { // backup from the first version (one binder)
    const b = createBinder('Imported');
    addCards(b.id, data.cards);
  } else {
    throw new Error('Not a PokéBinder backup');
  }
  for (const l of Array.isArray(data?.lists) ? data.lists : []) {
    if (!l?.id || !l.kind || list(l.id) || (l.kind === 'wishlist' && wishlist())) continue;
    state.lists.push({ position: state.lists.length, created: new Date().toISOString(), ...l });
    ops.push({ t: 'list', row: listRow(list(l.id)) });
  }
  commit(...ops);
  return count;
}

// ---------- sync ----------
function setSync(s) { if (syncStatus !== s) { syncStatus = s; emit(); } }

let flushing = false;
export async function flush() {
  if (flushing || !user || !queue.length) { if (user && !queue.length && !flushing) setSync('saved'); return; }
  flushing = true;
  setSync('saving');
  try {
    while (queue.length) {
      const op = queue[0];
      let res;
      if (op.t === 'binder') res = await sb.from('binders').upsert(op.row);
      else if (op.t === 'delBinder') res = await sb.from('binders').delete().eq('id', op.id);
      else if (op.t === 'card') res = await sb.from('binder_cards').upsert(op.row);
      else if (op.t === 'delCard') res = await sb.from('binder_cards').delete().eq('binder_id', op.binder_id).eq('card_id', op.card_id);
      else if (op.t === 'list') res = await sb.from('lists').upsert(op.row);
      else if (op.t === 'delList') res = await sb.from('lists').delete().eq('id', op.id);
      if (res?.error) {
        // Database said no (not a network problem): skip this change instead of retrying forever.
        if (res.error.code) { console.warn('Sync rejected', op, res.error); }
        else throw res.error;
      }
      queue.shift();
      saveQueue();
    }
    setSync('saved');
  } catch (err) {
    console.warn('Sync failed, will retry', err);
    setSync('offline');
  } finally {
    flushing = false;
  }
}

async function selectAll(table) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select('*').range(from, from + 999);
    if (error) throw error;
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

export async function pull() {
  if (!user || queue.length) return;
  const v = version;
  const [bRows, cRows, lRows] = await Promise.all([
    selectAll('binders'), selectAll('binder_cards'),
    selectAll('lists').catch(() => null), // table missing (setup step not run yet): keep lists on this device
  ]);
  if (v !== version || queue.length || !user) return; // something changed meanwhile – next pull will catch up
  const s = blank(user.id);
  s.lists = lRows ? lRows.map(r => ({ id: r.id, kind: r.kind, name: r.name, spec: r.spec || {}, position: r.position, created: r.created_at })) : state.lists;
  s.binders = bRows.map(r => ({ id: r.id, name: r.name, cover: r.cover || {}, position: r.position, created: r.created_at }));
  s.binders.forEach(b => { s.cards[b.id] = {}; });
  for (const r of cRows) {
    (s.cards[r.binder_id] ||= {})[r.card_id] = {
      id: r.card_id, name: r.name, localId: r.local_id, image: r.image, setId: r.set_id,
      setName: r.set_name, qty: r.qty, added: Date.parse(r.added_at),
    };
  }
  state = s;
  saveLocal();
  emit();
}

let channel = null;
let pullTimer;
const schedulePull = () => { clearTimeout(pullTimer); pullTimer = setTimeout(() => pull().catch(() => setSync('offline')), 700); };
function subscribe() {
  channel?.unsubscribe();
  channel = sb.channel('binder-sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'binders' }, schedulePull)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'binder_cards' }, schedulePull)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'lists' }, schedulePull)
    .subscribe();
}

// ---------- accounts ----------
let started = false;
async function handleUser(u) {
  if (started && (u?.id ?? null) === (user?.id ?? null)) return;
  started = true;
  const prev = state;
  user = u;

  if (!u) {
    channel?.unsubscribe();
    channel = null;
    if (prev.owner) state = blank(); // signed out: don't leave someone's binders on this device
    queue = [];
    saveQueue();
    setSync('guest');
    ensureDefault();
    saveLocal();
    emit();
    return;
  }

  if (prev.owner !== u.id) {
    queue = [];
    const guestCards = !prev.owner && (prev.lists.length || prev.binders.some(b => Object.keys(prev.cards[b.id] || {}).length));
    if (guestCards && confirm('Copy the binders and lists saved on this device into your account?')) {
      for (const b of prev.binders) {
        queue.push({ t: 'binder', row: binderRow(b) });
        for (const c of Object.values(prev.cards[b.id] || {})) queue.push({ t: 'card', row: cardRow(b.id, c) });
      }
      for (const l of prev.lists) queue.push({ t: 'list', row: listRow(l) });
    }
    state = blank(u.id);
    saveQueue();
  }
  emit();
  await flush();
  try {
    await pull();
    if (!state.binders.length) ensureDefault();
  } catch (err) {
    console.warn(err);
    setSync('offline');
  }
  subscribe();
}

// Supabase warns against awaiting its own calls inside this callback, so defer.
sb.auth.onAuthStateChange((_event, session) => setTimeout(() => handleUser(session?.user ?? null), 0));

export async function signIn(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
}
export async function signUp(email, password) {
  const { data, error } = await sb.auth.signUp({
    email, password, options: { emailRedirectTo: location.origin + location.pathname },
  });
  if (error) throw error;
  return { needsConfirm: !data.session };
}
export async function resetPassword(email) {
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  if (error) throw error;
}
export async function updatePassword(password) {
  const { error } = await sb.auth.updateUser({ password });
  if (error) throw error;
}
export const signOut = () => sb.auth.signOut();

// Retry / refresh when the app comes back to the foreground or the network returns.
addEventListener('online', () => flush().then(pull).catch(() => {}));
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && user) flush().then(pull).catch(() => {});
});
