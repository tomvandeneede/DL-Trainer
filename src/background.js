// Service worker: stores the captured words, determines base forms,
// removes duplicates and exports the list as JSON.
import { lemmatize, LANG } from './lemmatizer.js';

const SEP = '\u0001';
const LEMMA_VERSION = 2; // bump when lemmatization changes -> everything is redone

let state = null; // { courses, lemmaCache, overrides, settings }
let saveTimer = null;
let running = false;

async function load() {
  if (state) return state;
  const s = await chrome.storage.local.get(['courses', 'lemmaCache', 'overrides', 'settings']);
  // Keep Russian courses only.
  const courses = Object.fromEntries(Object.entries(s.courses || {}).filter(([, c]) => c.learningLanguage === LANG));
  state = {
    courses,
    lemmaCache: s.lemmaCache || {},
    overrides: s.overrides || {},
    settings: s.settings || {},
  };
  return state;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 800);
}
async function saveNow() {
  clearTimeout(saveTimer);
  if (state) await chrome.storage.local.set(state);
}

const courseKeyOf = (c) => `${c.learningLanguage}_${c.fromLanguage || 'xx'}`;
const langName = () => 'Russian';

// ---------- Receiving words ------------------------------------------------------
async function addLexemes(course, items) {
  await load();
  // Russian only. Without language info (e.g. read from the HTML) we assume Russian.
  if (course && course.learningLanguage && course.learningLanguage !== LANG) return { ok: false, error: 'Not a Russian course' };
  const c = { learningLanguage: LANG, fromLanguage: course?.fromLanguage || state.settings.lastCourse?.fromLanguage || 'en' };
  const key = courseKeyOf(c);
  const entry = (state.courses[key] ||= { learningLanguage: c.learningLanguage, fromLanguage: c.fromLanguage || null, lexemes: {} });
  if (!entry.fromLanguage && c.fromLanguage) entry.fromLanguage = c.fromLanguage;
  state.settings.lastCourse = { learningLanguage: entry.learningLanguage, fromLanguage: entry.fromLanguage };

  let added = 0;
  for (const it of items || []) {
    const text = String(it.text || '').normalize('NFC').trim().replace(/\s+/g, ' ');
    if (!text) continue;
    const ex = entry.lexemes[text];
    if (ex) {
      ex.translations = [...new Set([...(ex.translations || []), ...(it.translations || [])])];
    } else {
      entry.lexemes[text] = { text, translations: [...new Set(it.translations || [])], firstSeen: Date.now() };
      added++;
    }
    // The old Duolingo endpoint included the infinitive itself: cache it right away.
    const ck = entry.learningLanguage + SEP + text;
    if (it.infinitive && !state.lemmaCache[ck]) {
      state.lemmaCache[ck] = { lemma: it.infinitive, pos: 'verb', status: 'inflected', via: 'duolingo', v: LEMMA_VERSION };
    }
  }
  scheduleSave();
  processQueue();
  broadcast();
  return { ok: true, added, course: key };
}

// ---------- Lemmatizing -------------------------------------------------------------
function pendingKeys() {
  const out = [];
  for (const c of Object.values(state.courses)) {
    if (c.learningLanguage !== LANG) continue;
    for (const text of Object.keys(c.lexemes)) {
      const k = c.learningLanguage + SEP + text;
      const e = state.lemmaCache[k];
      if (!e || e.v !== LEMMA_VERSION || (e.status === 'error' && !e.retried)) out.push(k);
    }
  }
  return [...new Set(out)];
}

async function processQueue() {
  if (running) return;
  running = true;
  try {
    await load();
    for (let round = 0; round < 10000; round++) {
      const pending = pendingKeys();
      if (!pending.length) break;
      const batch = pending.slice(0, 3); // Wiktionary request rate is limited in lemmatizer.js
      await Promise.all(batch.map(async (k) => {
        const [lang, text] = k.split(SEP);
        const prev = state.lemmaCache[k];
        const translations = Object.values(state.courses).filter((c) => c.learningLanguage === lang)
          .flatMap((c) => c.lexemes[text]?.translations || []);
        try {
          state.lemmaCache[k] = { ...(await lemmatize(text, translations)), v: LEMMA_VERSION };
        } catch (e) {
          state.lemmaCache[k] = { lemma: text, pos: null, status: 'error', error: String(e?.message || e), retried: prev?.status === 'error', v: LEMMA_VERSION };
        }
      }));
      scheduleSave();
      if (round % 5 === 0) broadcast();
          }
  } finally {
    running = false;
    await saveNow();
    broadcast();
  }
}

// ---------- Building the list (deduplicated) --------------------------------------
function resolve(lang, text) {
  const k = lang + SEP + text;
  if (state.overrides[k]) return { lemma: state.overrides[k], pos: state.lemmaCache[k]?.pos || null, status: 'manual' };
  const e = state.lemmaCache[k];
  if (!e) return { lemma: text, pos: null, status: 'pending' };
  return e;
}

function buildList(courseKey) {
  const c = state.courses[courseKey];
  if (!c) return null;
  const lang = c.learningLanguage;
  const groups = new Map();
  for (const lx of Object.values(c.lexemes)) {
    const r = resolve(lang, lx.text);
    const lemma = String(r.lemma || lx.text).normalize('NFC').trim();
    let g = groups.get(lemma);
    if (!g) {
      g = { word: lemma, partOfSpeech: null, translations: [], forms: [], status: r.status };
      groups.set(lemma, g);
    }
    if (!g.partOfSpeech && r.pos) g.partOfSpeech = r.pos;
    // Translations of the base form itself first, then those of inflected forms.
    if (lx.text === lemma) g.translations = [...new Set([...(lx.translations || []), ...g.translations])];
    else g.translations = [...new Set([...g.translations, ...(lx.translations || [])])];
    if (!g.forms.includes(lx.text)) g.forms.push(lx.text);
    const rank = { manual: 5, lemma: 4, inflected: 3, unknown: 2, error: 1, pending: 0 };
    if ((rank[r.status] ?? 0) > (rank[g.status] ?? 0)) g.status = r.status;
  }
  const collator = new Intl.Collator('ru', { sensitivity: 'base' });
  const words = [...groups.values()].sort((a, b) => collator.compare(a.word, b.word) || a.word.localeCompare(b.word));
  return {
    source: 'Duolingo',
    learningLanguage: lang,
    fromLanguage: c.fromLanguage,
    exportedAt: new Date().toISOString(),
    totalSeen: Object.keys(c.lexemes).length,
    count: words.length,
    words,
  };
}

function currentCourseKey() {
  const lc = state.settings.lastCourse;
  if (lc && state.courses[courseKeyOf(lc)]) return courseKeyOf(lc);
  return Object.keys(state.courses)[0] || null;
}

async function getStatus() {
  await load();
  const pending = pendingKeys().length;
  const courses = Object.entries(state.courses).map(([key, c]) => {
    const list = buildList(key);
    return { key, label: langName(c.learningLanguage), raw: list.totalSeen, unique: list.count };
  });
  const cur = currentCourseKey();
  const gb = (await chrome.storage.local.get('guidebook')).guidebook;
  return { courses, current: courses.find((c) => c.key === cur) || null, currentKey: cur, pending, running,
           guidebook: gb ? { count: gb.count, units: gb.units, exportedAt: gb.exportedAt } : null, gbProgress };
}

let broadcastTimer = null;
function broadcast() {
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(async () => {
    const status = await getStatus();
    chrome.runtime.sendMessage({ type: 'statusUpdate', status }).catch(() => {});
    const tabs = await chrome.tabs.query({ url: 'https://www.duolingo.com/*' });
    for (const t of tabs) chrome.tabs.sendMessage(t.id, { type: 'status', status }).catch(() => {});
  }, 300);
}

// ---------- Export -------------------------------------------------------------------
async function exportJson(courseKey, saveAs = false) {
  await load();
  const key = courseKey || currentCourseKey();
  const list = key && buildList(key);
  if (!list) return { ok: false, error: 'No words captured yet' };
  const json = JSON.stringify(list, null, 2);
  const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(json);
  const filename = 'duolingo-wordlist/russian-words.json';
  await chrome.downloads.download({ url, filename, conflictAction: 'overwrite', saveAs });
  return { ok: true, filename, count: list.count, pending: pendingKeys().length };
}

// ---------- Start fetching from the popup -------------------------------------------
const WORDS_URL = 'https://www.duolingo.com/practice-hub/words';

async function startFetch() {
  let [tab] = await chrome.tabs.query({ url: WORDS_URL + '*' });
  if (!tab) {
    const [other] = await chrome.tabs.query({ url: 'https://www.duolingo.com/*', active: true, currentWindow: true });
    tab = other ? await chrome.tabs.update(other.id, { url: WORDS_URL }) : await chrome.tabs.create({ url: WORDS_URL });
    await new Promise((resolve) => {
      const listener = (id, info) => {
        if (id === tab.id && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(listener); resolve(); }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(resolve, 20000);
    });
    await new Promise((r) => setTimeout(r, 3000)); // let Duolingo load the list itself first
  } else {
    await chrome.tabs.update(tab.id, { active: true });
  }
  await chrome.tabs.sendMessage(tab.id, { type: 'fetchAll' }).catch(() => null);
  return { ok: true };
}

// ---------- Guidebook sentences ---------------------------------------------------------
let gbProgress = null;

async function startGuidebooks() {
  // Any Duolingo page will do; preferably the active tab.
  let [tab] = await chrome.tabs.query({ url: 'https://www.duolingo.com/*', active: true, currentWindow: true });
  if (!tab) [tab] = await chrome.tabs.query({ url: 'https://www.duolingo.com/*' });
  if (!tab) {
    tab = await chrome.tabs.create({ url: 'https://www.duolingo.com/learn' });
    await new Promise((resolve) => {
      const l = (id, info) => { if (id === tab.id && info.status === 'complete') { chrome.tabs.onUpdated.removeListener(l); resolve(); } };
      chrome.tabs.onUpdated.addListener(l);
      setTimeout(resolve, 20000);
    });
    await new Promise((r) => setTimeout(r, 1500));
  }
  gbProgress = { done: 0, total: null, sentences: 0 };
  await chrome.tabs.sendMessage(tab.id, { type: 'fetchGuidebooks' }).catch(() => null);
  return { ok: true };
}

async function saveGuidebook(data) {
  const gb = {
    source: 'Duolingo guidebooks',
    learningLanguage: LANG,
    fromLanguage: data.fromLanguage || 'en',
    exportedAt: new Date().toISOString(),
    units: data.units,
    count: data.sentences.length,
    sentences: data.sentences,
  };
  await chrome.storage.local.set({ guidebook: gb });
  gbProgress = { done: data.units, total: data.units, sentences: gb.count, finished: true };
  chrome.runtime.sendMessage({ type: 'guidebookUpdate', progress: gbProgress }).catch(() => {});
  return exportGuidebook(false, gb);
}

async function exportGuidebook(saveAs = false, gb = null) {
  gb ||= (await chrome.storage.local.get('guidebook')).guidebook;
  if (!gb) return { ok: false, error: 'No guidebook sentences fetched yet' };
  const url = 'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(gb, null, 2));
  const filename = 'duolingo-wordlist/russian-guidebook-sentences.json';
  await chrome.downloads.download({ url, filename, conflictAction: 'overwrite', saveAs });
  return { ok: true, filename, count: gb.count };
}

// ---------- Messages --------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    await load();
    switch (msg.type) {
      case 'lexemes': return addLexemes(msg.course, msg.items);
      case 'getStatus': processQueue(); return getStatus();
      case 'getList': return { list: buildList(msg.courseKey || currentCourseKey()), status: await getStatus() };
      case 'export': return exportJson(msg.courseKey, !!msg.saveAs);
      case 'startFetch': return startFetch();
      case 'startGuidebooks': return startGuidebooks();
      case 'guidebook': return saveGuidebook(msg.data);
      case 'guidebookProgress':
        gbProgress = msg; chrome.runtime.sendMessage({ type: 'guidebookUpdate', progress: msg }).catch(() => {});
        return { ok: true };
      case 'exportGuidebook': return exportGuidebook(!!msg.saveAs);
      case 'openList': await chrome.tabs.create({ url: chrome.runtime.getURL('words.html') }); return { ok: true };
      case 'setCurrent': {
        const c = state.courses[msg.courseKey];
        if (c) state.settings.lastCourse = { learningLanguage: c.learningLanguage, fromLanguage: c.fromLanguage };
        await saveNow(); broadcast(); return { ok: true };
      }
      case 'setOverride': {
        const c = state.courses[msg.courseKey];
        if (!c) return { ok: false };
        for (const form of msg.forms || []) {
          const k = c.learningLanguage + SEP + form;
          const val = String(msg.lemma || '').trim();
          if (!val || val === state.lemmaCache[k]?.lemma) delete state.overrides[k];
          else state.overrides[k] = val.normalize('NFC');
        }
        await saveNow(); broadcast(); return { ok: true };
      }
      case 'retry': {
        // Look up words without a result (or with an error) again.
        for (const [k, e] of Object.entries(state.lemmaCache)) {
          if (e.status === 'unknown' || e.status === 'error') delete state.lemmaCache[k];
        }
        await saveNow(); processQueue(); return { ok: true };
      }
      case 'clearCourse': {
        delete state.courses[msg.courseKey];
        if (state.settings.lastCourse && courseKeyOf(state.settings.lastCourse) === msg.courseKey) delete state.settings.lastCourse;
        await saveNow(); broadcast(); return { ok: true };
      }
      default: return { ok: false, error: 'unknown message' };
    }
  })().then(reply, (e) => reply({ ok: false, error: String(e?.message || e) }));
  return true;
});

chrome.runtime.onStartup.addListener(() => processQueue());
chrome.runtime.onInstalled.addListener(() => processQueue());
