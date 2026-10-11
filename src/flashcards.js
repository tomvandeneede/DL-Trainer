// Flashcards for the Russian word list and the guidebook sentences.
const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

const PREF_KEY = 'flashcardPrefs';
let prefs = { mode: 'words', direction: 'en-ru', section: null, unit: null, onlyUnit: false };
let words = [];      // [{ru, en, extra}]
let sentences = [];  // guidebook sentences
let deck = [];
let pos = 0;

const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const savePrefs = () => chrome.storage.local.set({ [PREF_KEY]: prefs });

async function loadData() {
  const st = await chrome.storage.local.get([PREF_KEY, 'guidebook']);
  prefs = { ...prefs, ...(st[PREF_KEY] || {}) };
  sentences = st.guidebook?.sentences || [];
  const r = await send({ type: 'getList' });
  words = (r?.list?.words || [])
    .filter((w) => w.translations?.length)
    .map((w) => ({
      ru: w.word,
      en: w.translations.slice(0, 3).join(', '),
      extra: [w.partOfSpeech, w.forms.filter((f) => f !== w.word).join(', ')].filter(Boolean).join(' · '),
    }));
}

// ---------- Section/unit choice -----------------------------------------------------
function sectionsAvailable() {
  return [...new Set(sentences.map((s) => s.section))].sort((a, b) => a - b);
}
function unitsIn(section) {
  const m = new Map();
  for (const s of sentences) if (s.section === section && !m.has(s.unit)) m.set(s.unit, s.unitTitle);
  return [...m.entries()].sort((a, b) => a[0] - b[0]);
}

function fillSections() {
  const secs = sectionsAvailable();
  $('section').innerHTML = secs.map((s) => `<option value="${s}">Section ${s}</option>`).join('');
  if (!secs.includes(prefs.section)) prefs.section = secs.at(-1) ?? null;
  if (prefs.section != null) $('section').value = prefs.section;
  fillUnits();
}
function fillUnits() {
  const units = unitsIn(prefs.section);
  $('unit').innerHTML = units.map(([u, t]) => `<option value="${u}">Unit ${u}${t ? ' – ' + t.replace(/</g, '&lt;') : ''}</option>`).join('');
  if (!units.some(([u]) => u === prefs.unit)) prefs.unit = units.at(-1)?.[0] ?? null;
  if (prefs.unit != null) $('unit').value = prefs.unit;
}

// ---------- Building the deck ------------------------------------------------------------
function buildDeck() {
  let cards;
  if (prefs.mode === 'words') {
    cards = words.map((w) => ({ ru: w.ru, en: w.en, extra: w.extra }));
  } else {
    const S = prefs.section, U = prefs.unit;
    cards = sentences
      .filter((s) => prefs.onlyUnit
        ? s.section === S && s.unit === U
        : s.section < S || (s.section === S && s.unit <= U))
      .map((s) => ({ ru: s.russian, en: s.english, extra: `Section ${s.section}, unit ${s.unit}${s.unitTitle ? ' – ' + s.unitTitle : ''}` }));
  }
  deck = shuffle(cards);
  pos = 0;
  render();
}

function render() {
  const isGb = prefs.mode === 'sentences';
  document.querySelectorAll('.gb').forEach((el) => el.classList.toggle('hidden', !isGb));
  $('tabWords').setAttribute('aria-selected', String(!isGb));
  $('tabSentences').setAttribute('aria-selected', String(isGb));

  if (!deck.length) {
    $('practice').classList.add('hidden');
    $('empty').classList.remove('hidden');
    $('empty').textContent = isGb
      ? (sentences.length ? 'No sentences for this selection.' : 'No guidebook sentences yet. Fetch them first via the extension popup (“Fetch all units”).')
      : 'No words yet. Fetch them first via the extension popup (“Fetch all from Duolingo”).';
    return;
  }
  $('practice').classList.remove('hidden');
  $('empty').classList.add('hidden');
  showCard();
}

function showCard() {
  const c = deck[pos];
  const dir = prefs.direction === 'random' ? (Math.random() < 0.5 ? 'en-ru' : 'ru-en') : prefs.direction;
  const front = dir === 'en-ru' ? { t: c.en, l: 'English', lang: 'en' } : { t: c.ru, l: 'Russian', lang: 'ru' };
  const back = dir === 'en-ru' ? { t: c.ru, l: 'Russian', lang: 'ru' } : { t: c.en, l: 'English', lang: 'en' };

  const card = $('card');
  // Back to the front without animation, so the answer doesn't flash into view.
  card.style.transition = 'none';
  card.classList.remove('flipped');
  void card.offsetWidth;
  card.style.transition = '';

  $('frontLang').textContent = front.l;
  $('backLang').textContent = back.l;
  for (const [el, f] of [[$('frontText'), front], [$('backText'), back]]) {
    el.textContent = f.t;
    el.lang = f.lang;
    el.classList.toggle('long', f.t.length > 40);
  }
  $('backExtra').textContent = c.extra || '';
  $('count').textContent = `${pos + 1} / ${deck.length}`;
  $('next').textContent = pos + 1 < deck.length ? 'Next' : 'Start over';

  // Fit the height to the longer side.
  card.style.height = 'auto';
  const h = Math.max(260, ...[...card.querySelectorAll('.face')].map((f) => f.scrollHeight));
  card.style.height = h + 'px';
}

function next() {
  if (!deck.length) return;
  if (pos + 1 < deck.length) pos++;
  else { shuffle(deck); pos = 0; }
  showCard();
}

// ---------- Events -----------------------------------------------------------------------
$('card').onclick = () => $('card').classList.toggle('flipped');
$('next').onclick = next;
$('shuffle').onclick = () => { shuffle(deck); pos = 0; if (deck.length) showCard(); };
$('tabWords').onclick = () => { prefs.mode = 'words'; savePrefs(); buildDeck(); };
$('tabSentences').onclick = () => { prefs.mode = 'sentences'; savePrefs(); buildDeck(); };
$('direction').onchange = (e) => { prefs.direction = e.target.value; savePrefs(); if (deck.length) showCard(); };
$('section').onchange = (e) => { prefs.section = Number(e.target.value); prefs.unit = null; fillUnits(); savePrefs(); buildDeck(); };
$('unit').onchange = (e) => { prefs.unit = Number(e.target.value); savePrefs(); buildDeck(); };
$('onlyUnit').onchange = (e) => { prefs.onlyUnit = e.target.checked; savePrefs(); buildDeck(); };
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT') return;
  if ((e.key === ' ' || e.key === 'Enter') && e.target.tagName !== 'BUTTON') { e.preventDefault(); $('card').classList.toggle('flipped'); }
  if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
});

(async () => {
  await loadData();
  $('direction').value = prefs.direction;
  $('onlyUnit').checked = !!prefs.onlyUnit;
  fillSections();
  buildDeck();
})();
