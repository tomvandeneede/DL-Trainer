// Determines the base form (lemma) of a Russian word via Wiktionary.
// The Wiktionary headword is exactly what we want:
//   nouns                    -> nominative singular          (соседи -> сосед, имени -> имя)
//   adjectives, pronouns     -> masculine nominative singular (твоей -> твой, нашей -> наш)
//   verbs                    -> infinitive                    (учусь -> учиться, будут -> быть)
// Feminine nouns for people that Wiktionary lists as "female equivalent of" a
// masculine word (студентка -> студент) also become masculine singular.

export const LANG = 'ru';
const API_UA = 'DuolingoRussianWordList/1.3 (Chrome extension)';

// Not an inflection but a different word / spelling: don't follow.
const SKIP_RE = /\b(alternative|alt|obsolete|archaic|dated|nonstandard|non-standard|rare|misspelling|eye[- ]dialect|pronunciation|superseded|deprecated|informal|colloquial|standard)\s+(spelling|form|case form|typography)s?\b|\b(abbreviation|initialism|acronym|clipping|diminutive|augmentative|endearing|pejorative|synonym|short for|contraction|ellipsis|romanization|transliteration|apocopic|elongated)\b/i;

const POS_MAP = {
  noun: 'noun', 'proper noun': 'proper noun', verb: 'verb', participle: 'verb', adjective: 'adjective',
  adverb: 'adverb', pronoun: 'pronoun', determiner: 'determiner', preposition: 'preposition',
  conjunction: 'conjunction', interjection: 'interjection', numeral: 'numeral', number: 'numeral',
  particle: 'particle', phrase: 'phrase', 'prepositional phrase': 'phrase', proverb: 'phrase',
  predicative: 'predicative',
};
const normPos = (p) => (p ? POS_MAP[String(p).toLowerCase().trim()] || String(p).toLowerCase().trim() : null);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
const stripTags = (html) => decodeEntities(String(html).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

// Remove stress marks (а́, о̀); ё stays ё.
export const stripStress = (s) => String(s).normalize('NFD').replace(/[̀́]/g, '').normalize('NFC');

export function cleanTitle(t) {
  if (!t) return null;
  let s = decodeEntities(t).replace(/_/g, ' ').split('#')[0].trim();
  s = s.replace(/^\[\[|\]\]$/g, '').replace(/'''?/g, '');
  if (/^(Reconstruction|Appendix|Category|Wiktionary|Citations|Thesaurus|Template):/i.test(s)) return null;
  s = stripStress(s);
  return s || null;
}

// ---------- REST-API: /api/rest_v1/page/definition/{word} ----------------------
const INFLECTION_HINT = /\b(singular|plural|nominative|genitive|dative|accusative|instrumental|locative|prepositional|vocative|partitive|inflection|participle|gerund|person|tense|present|past|future|imperative|infinitive|masculine|feminine|neuter|female equivalent|comparative|superlative|short|form)\b[^<]*\bof\s*$/i;

// undefined = real definition; string = lemma being referred to
export function restFormOfTarget(html) {
  const h = String(html);
  const linkIdx = h.indexOf('form-of-definition-link');
  let before, after;
  if (/form-of-definition/.test(h)) {
    before = stripTags(linkIdx >= 0 ? h.slice(0, h.lastIndexOf('<', linkIdx)) : h);
    after = linkIdx >= 0 ? h.slice(linkIdx) : h;
  } else {
    // Some templates lack the class: recognise "… plural of <a>…</a>".
    const re = /<a\b[^>]*\btitle="(?!Appendix:)[^"]*"/gi;
    const m = re.exec(h);
    if (!m) return undefined;
    before = stripTags(h.slice(0, m.index));
    if (!INFLECTION_HINT.test(before)) return undefined;
    after = h.slice(m.index);
  }
  if (SKIP_RE.test(before)) return undefined;
  const m = after.match(/<a\b[^>]*\btitle="([^"]+)"/i) || after.match(/<a\b[^>]*\bhref="\/wiki\/([^"#]+)/i);
  if (!m) return undefined;
  const raw = m[0].includes('title=') ? m[1] : decodeURIComponent(m[1]);
  return cleanTitle(raw) || undefined;
}

// Result: { lemmaEntries: [{pos,text}], targets: [{target,pos}] }
// A part-of-speech block with at least one "… of X" definition is an inflected
// form; the other lines in that block (e.g. "genitive/dative singular" or
// notes on a table) are then not meanings of their own.
export function analyzeRest(data) {
  const entries = data && data[LANG];
  if (!Array.isArray(entries) || !entries.length) return null;
  const lemmaEntries = [];
  const targets = [];
  for (const e of entries) {
    const defs = (e.definitions || []).map((d) => d.definition || '').filter((h) => stripTags(h));
    const tgs = defs.map(restFormOfTarget).filter(Boolean);
    if (tgs.length) {
      for (const t of tgs) if (!targets.some((x) => x.target === t)) targets.push({ target: t, pos: normPos(e.partOfSpeech) });
    } else if (defs.length) {
      lemmaEntries.push({ pos: normPos(e.partOfSpeech), text: defs.map(stripTags).join('; ') });
    }
  }
  if (!lemmaEntries.length && !targets.length) return null;
  return { lemmaEntries, targets };
}

// ---------- Fallback: wikitext via action=parse ---------------------------------
const POS_HEADINGS = new Set(Object.keys(POS_MAP));

export function wikitextTarget(line) {
  const re = /\{\{([^{}|]+)\|([^{}]*)\}\}/g;
  let m;
  while ((m = re.exec(line))) {
    const name = m[1].trim().toLowerCase();
    if (!/(\bof|form of)$/.test(name)) continue;
    if (SKIP_RE.test(name) || /^(alt|alter|syn|abbr|dim)/.test(name)) return undefined;
    const params = m[2].split('|').map((p) => p.trim()).filter((p) => !/^[\w-]+=/.test(p));
    let lemma;
    if (params[0] === LANG) lemma = params[1];
    else if (name.startsWith(LANG + '-')) lemma = params[0];
    else if (/^[a-z]{2,3}(-[a-z]+)?$/.test(params[0] || '') && params[1]) lemma = params[1];
    else lemma = params[0];
    const t = cleanTitle(lemma);
    if (t) return t;
  }
  return undefined;
}

export function analyzeWikitext(wt) {
  const all = String(wt || '');
  const m = /^==\s*Russian\s*==\s*$/m.exec(all);
  if (!m) return null;
  const rest = all.slice(m.index + m[0].length);
  const end = rest.search(/^==[^=].*==\s*$/m);
  const section = end >= 0 ? rest.slice(0, end) : rest;
  const blocks = [];
  let cur = null;
  for (const line of section.split('\n')) {
    const h = line.match(/^={3,}\s*([^=]+?)\s*={3,}\s*$/);
    if (h) { const p = h[1].toLowerCase(); cur = POS_HEADINGS.has(p) ? { pos: normPos(p), defs: [] } : null; if (cur) blocks.push(cur); continue; }
    const d = line.match(/^#(?![:*#])\s*(.+)$/);
    if (d && cur) cur.defs.push(d[1]);
  }
  const lemmaEntries = [];
  const targets = [];
  for (const b of blocks) {
    const tgs = b.defs.map(wikitextTarget).filter(Boolean);
    if (tgs.length) { for (const t of tgs) if (!targets.some((x) => x.target === t)) targets.push({ target: t, pos: b.pos }); }
    else if (b.defs.length) lemmaEntries.push({ pos: b.pos, text: b.defs.join('; ').replace(/\{\{[^{}]*\}\}|\[\[|\]\]/g, ' ') });
  }
  if (!lemmaEntries.length && !targets.length) return null;
  return { lemmaEntries, targets };
}

// ---------- Lookup ------------------------------------------------------------------
const memo = new Map();
let restBroken = false;

// Wiktionary refuses too many requests at once (HTTP 429): max. ~4 per second.
const MIN_GAP_MS = 250;
let nextSlot = 0;
async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_GAP_MS;
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

async function fetchWithRetry(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    await throttle();
    const res = await fetch(url, { headers: { 'Api-User-Agent': API_UA } });
    if (res.status === 429 || res.status === 503) {
      const ra = Number(res.headers.get('Retry-After'));
      const delay = (ra > 0 ? ra * 1000 : 2000 * 2 ** attempt);
      nextSlot = Date.now() + delay; // make the other requests wait too
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }
    return res;
  }
  throw new Error('Wiktionary is not responding (too many requests)');
}

async function lookupRest(title) {
  const res = await fetchWithRetry(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(title)}?redirect=false`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('REST ' + res.status);
  return analyzeRest(await res.json());
}

async function lookupWikitext(title) {
  const url = 'https://en.wiktionary.org/w/api.php?action=parse&format=json&formatversion=2&prop=wikitext&origin=*&page=' + encodeURIComponent(title);
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error('API ' + res.status);
  const j = await res.json();
  if (j.error) return null;
  return analyzeWikitext(j.parse?.wikitext);
}

export async function lookup(title) {
  if (memo.has(title)) return memo.get(title);
  let r = null;
  if (!restBroken) {
    try { r = await lookupRest(title); }
    catch (e) { restBroken = /REST (403|410|501)/.test(String(e)); }
  }
  // The fast REST API misses some pages (e.g. можно, должен): fall back to the regular page API.
  if (!r) r = await lookupWikitext(title);
  memo.set(title, r);
  return r;
}

const cap = (s) => s.charAt(0).toLocaleUpperCase('ru') + s.slice(1);

// ---------- Choosing between several options --------------------------------------
// Some words are both a word of their own and an inflected form
// (имени = "named after" or genitive of имя; красная = "5000-ruble note" or
// feminine of красный). We pick the option whose Wiktionary meaning best
// matches the translations Duolingo gives.
const STOP = new Set('a an the to of is are was were be been in on at for and or with by from it its this that i you he she we they me him her us them do does did not no'.split(' '));
function stems(s) {
  const out = new Set();
  for (let w of String(s || '').toLowerCase().replace(/'s\b/g, '').split(/[^a-z]+/)) {
    if (!w || STOP.has(w)) continue;
    out.add(w);
    for (const suf of ['ing', 'ed', 'es', 's']) if (w.length > suf.length + 2 && w.endsWith(suf)) out.add(w.slice(0, -suf.length));
  }
  return out;
}
function score(translations, text) {
  const t = stems(text);
  let n = 0;
  for (const tr of translations || []) for (const w of stems(tr)) if (t.has(w)) n++;
  return n;
}
// Parts of speech that are often both a word of their own and a form of something
// else (отлично, днём, дома): we prefer to keep those unless the translation clearly points elsewhere.
const FUNCTION_POS = new Set(['adverb', 'interjection', 'particle', 'conjunction', 'preposition', 'predicative', 'phrase']);

async function resolveTarget(t) {
  // Follow the reference, possibly in several steps (бегущего -> бегущий -> бежать).
  let lemma = t.target;
  let pos = t.pos;
  let info = await lookup(lemma);
  for (let i = 0; i < 2 && info && !info.lemmaEntries.length && info.targets.length; i++) {
    const next = info.targets[0];
    if (next.target === lemma) break;
    lemma = next.target;
    pos = next.pos || pos;
    info = await lookup(lemma);
  }
  const text = info ? info.lemmaEntries.map((e) => e.text).join('; ') : '';
  return { lemma, pos: pos === 'verb' || !info?.lemmaEntries[0] ? pos : info.lemmaEntries[0].pos || pos, text, status: 'inflected' };
}

/**
 * @param {string} text            word as Duolingo shows it
 * @param {string[]} translations  Duolingo's translations (used to choose when ambiguous)
 * @returns {Promise<{lemma:string,pos:string|null,status:'lemma'|'inflected'|'unknown'}>}
 */
export async function lemmatize(text, translations = []) {
  const word = stripStress(String(text).normalize('NFC').trim().replace(/\s+/g, ' '));
  const lower = word.toLocaleLowerCase('ru');
  const candidates = [...new Set([word, lower, cap(lower)])];
  // Duolingo sometimes writes е where Wiktionary uses ё (еще -> ещё).
  if (/е/.test(lower) && !/ё/.test(lower)) {
    const idx = [...lower].map((c, i) => (c === 'е' ? i : -1)).filter((i) => i >= 0);
    if (idx.length <= 3) for (const i of idx) candidates.push(lower.slice(0, i) + 'ё' + lower.slice(i + 1));
  }
  for (const c of candidates) {
    const r = await lookup(c);
    if (!r) continue;
    const own = r.lemmaEntries.length
      ? { lemma: c, pos: r.lemmaEntries[0].pos, text: r.lemmaEntries.map((e) => e.text).join('; '), status: 'lemma' }
      : null;
    const tg = r.targets.slice(0, 3); // Wiktionary's order
    if (!tg.length) return strip(own);
    if (!own && tg.length === 1) return strip(await resolveTarget(tg[0]));
    // Choose based on Duolingo's translations.
    const options = [];
    for (const t of tg) options.push(await resolveTarget(t));
    let best = options[0];
    let bestScore = score(translations, best.text);
    for (const o of options.slice(1)) {
      const sc = score(translations, o.text);
      if (sc > bestScore) { best = o; bestScore = sc; }
    }
    if (!own) return strip(best);
    const ownScore = score(translations, own.text);
    const margin = FUNCTION_POS.has(own.pos) ? 2 : 1;
    if (bestScore >= ownScore + margin) return strip(best);
    // Tie with a verb form (знаешь -> знать): the verb wins.
    if (bestScore === ownScore && best.pos === 'verb' && own.pos !== 'verb') return strip(best);
    return strip(own);
  }
  // Not found: many inflected adjectives have no page of their own
  // (жёлтая, интересная). Try the masculine form via the ending.
  for (const guess of adjectiveGuesses(lower)) {
    const r = await lookup(guess);
    if (r && r.lemmaEntries.some((e) => e.pos === 'adjective' || e.pos === 'pronoun' || e.pos === 'determiner')) {
      return { lemma: guess, pos: 'adjective', status: 'inflected' };
    }
  }
  return { lemma: word, pos: /\s/.test(word) ? 'phrase' : null, status: 'unknown' };
}
const ADJ_ENDINGS = [
  ['ая', ['ый', 'ий', 'ой']], ['яя', ['ий']], ['ое', ['ый', 'ой', 'ий']], ['ее', ['ий']],
  ['ые', ['ый', 'ой']], ['ие', ['ий', 'ой']], ['ую', ['ый', 'ой', 'ий']], ['юю', ['ий']],
  ['ого', ['ый', 'ой', 'ий']], ['его', ['ий']], ['ому', ['ый', 'ой', 'ий']], ['ему', ['ий']],
  ['ой', ['ый', 'ий']], ['ей', ['ий']], ['ых', ['ый', 'ой']], ['их', ['ий', 'ой']],
  ['ым', ['ый', 'ой']], ['им', ['ий', 'ой']], ['ыми', ['ый', 'ой']], ['ими', ['ий', 'ой']], ['ом', ['ый', 'ой']], ['ем', ['ий']],
];
function adjectiveGuesses(w) {
  if (/\s/.test(w)) return [];
  const out = [];
  for (const [end, repl] of ADJ_ENDINGS) {
    if (w.length > end.length + 2 && w.endsWith(end)) for (const r of repl) out.push(w.slice(0, -end.length) + r);
  }
  return [...new Set(out)].slice(0, 4);
}
const strip = (o) => ({ lemma: o.lemma, pos: o.pos || null, status: o.status });
