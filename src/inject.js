// Runs in the page context of duolingo.com (world: MAIN).
// Captures the API responses the words page fetches itself, and can repeat
// the same request to fetch every page of the word list.
(() => {
  if (window.__dwlInjected) return;
  window.__dwlInjected = true;

  // Only the list request itself (not /learned-lexemes/count or /practice-lexemes).
  const LIST_RE = /\/learned-lexemes\?/i;
  const API_MATCH = LIST_RE;
  const LANG = 'ru'; // the extension is limited to Russian
  const origFetch = window.fetch.bind(window);
  let template = null; // last seen learned-lexemes request
  let fetching = false;

  const post = (type, payload) =>
    window.postMessage({ __dwl: true, dir: 'page', type, payload }, location.origin);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function headersToObject(h) {
    const out = {};
    if (!h) return out;
    try {
      if (h instanceof Headers) h.forEach((v, k) => (out[k] = v));
      else if (Array.isArray(h)) h.forEach(([k, v]) => (out[k] = v));
      else Object.assign(out, h);
    } catch (_) {}
    delete out['content-length'];
    delete out['Content-Length'];
    return out;
  }

  function courseFromUrl(url) {
    const m = String(url).match(/\/courses\/([a-zA-Z-]+)\/([a-zA-Z-]+)\//);
    return m ? { learningLanguage: m[1], fromLanguage: m[2] } : null;
  }

  // Find (recursively) the array of word objects in an API response.
  function findLexemeArray(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 5) return null;
    if (Array.isArray(obj)) {
      if (obj.length && obj.every((x) => x && typeof x === 'object' && !Array.isArray(x)) &&
          obj.some((x) => typeof (x.text ?? x.word_string ?? x.word) === 'string')) {
        return obj;
      }
      for (const v of obj) { const r = findLexemeArray(v, depth + 1); if (r) return r; }
      return null;
    }
    for (const key of ['learnedLexemes', 'vocab_overview', 'lexemes', 'words']) {
      if (Array.isArray(obj[key])) return obj[key];
    }
    for (const v of Object.values(obj)) {
      const r = findLexemeArray(v, depth + 1);
      if (r) return r;
    }
    return null;
  }

  function toStrings(v) {
    if (v == null) return [];
    if (Array.isArray(v)) return v.flatMap(toStrings);
    if (typeof v === 'string') return v.split(/\s*[,;]\s*/).filter(Boolean);
    if (typeof v === 'object') return toStrings(v.text ?? v.translation ?? v.value);
    return [];
  }

  function normalizeItem(x) {
    const text = x.text ?? x.word_string ?? x.word ?? x.lexeme ?? null;
    if (typeof text !== 'string' || !text.trim()) return null;
    return {
      text: text.trim(),
      translations: [...new Set(toStrings(x.translations ?? x.translation ?? x.hints))],
      // The old vocabulary endpoint already included an infinitive / gender.
      infinitive: typeof x.infinitive === 'string' ? x.infinitive : null,
      pos: x.pos ?? null,
      gender: x.gender ?? null,
    };
  }

  function handleJson(url, json) {
    const arr = findLexemeArray(json);
    const items = (arr || []).map(normalizeItem).filter(Boolean);
    const course = courseFromUrl(url) || {
      learningLanguage: json?.learningLanguage ?? json?.learning_language ?? null,
      fromLanguage: json?.fromLanguage ?? json?.from_language ?? null,
    };
    const pagination = json?.pagination || null;
    if (course.learningLanguage && course.learningLanguage !== LANG) {
      post('wrongLanguage', { learningLanguage: course.learningLanguage });
      return { items: [], pagination, hasPagination: false };
    }
    course.learningLanguage = LANG;
    if (items.length) {
      post('lexemes', { course, items, total: pagination?.totalLexemes ?? null });
    }
    return { items, pagination, hasPagination: !!json && 'pagination' in json };
  }

  // --- Intercept fetch -------------------------------------------------------
  window.fetch = async function (input, init) {
    let url = '';
    try { url = typeof input === 'string' ? input : input?.url || String(input); } catch (_) {}
    const isList = API_MATCH.test(url);
    if (isList) {
      // Remember the request right away (before the response arrives).
      try {
        const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
        const headers = headersToObject(init?.headers || (input instanceof Request ? input.headers : null));
        let body = typeof init?.body === 'string' ? init.body : null;
        if (body == null && input instanceof Request && !init?.body) body = await input.clone().text().catch(() => null);
        template = { url: new URL(url, location.origin).toString(), method, headers, body };
        post('template', { ready: true });
      } catch (_) {}
    }
    const res = await origFetch(input, init);
    if (isList) res.clone().json().then((j) => handleJson(url, j)).catch(() => {});
    return res;
  };

  // --- Intercept XMLHttpRequest --------------------------------------------
  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  const XH = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__dwl = { method: String(method || 'GET').toUpperCase(), url: String(url), headers: {} };
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this.__dwl) this.__dwl.headers[k] = v;
    return XH.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const info = this.__dwl;
    if (info && API_MATCH.test(info.url)) {
      {
        template = {
          url: new URL(info.url, location.origin).toString(),
          method: info.method,
          headers: info.headers,
          body: typeof body === 'string' ? body : null,
        };
        post('template', { ready: true });
      }
      this.addEventListener('load', () => {
        try {
          const j = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
          handleJson(info.url, j);
        } catch (_) {}
      });
    }
    return XS.apply(this, arguments);
  };

  // --- Fetch all pages by repeating Duolingo's own request -----------------
  async function fetchAll() {
    if (fetching) return;
    if (!template) {
      post('fetchAllResult', { ok: false, reason: 'no-template' });
      return;
    }
    fetching = true;
    let got = 0;
    let total = null;
    try {
      const u = new URL(template.url);
      let start = 0;
      for (let page = 0; page < 500; page++) {
        if (u.searchParams.has('startIndex') || page > 0) u.searchParams.set('startIndex', String(start));
        const res = await origFetch(u.toString(), {
          method: template.method,
          headers: template.headers,
          body: template.method === 'GET' || template.method === 'HEAD' ? undefined : template.body,
          credentials: 'include',
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        const { items, pagination, hasPagination } = handleJson(u.toString(), json);
        got += items.length;
        total = pagination?.totalLexemes ?? total;
        post('progress', { got, total });

        if (!items.length) break;
        const next = pagination?.nextStartIndex;
        if (next == null) {
          if (hasPagination) break; // Duolingo says: no next page
          start += items.length;
        } else {
          start = next;
        }
        if (total != null && start >= total) break;
        if (!u.searchParams.has('startIndex') && page === 0 && !hasPagination) break; // not paginated
        await sleep(250);
      }
      post('fetchAllResult', { ok: true, got, total });
    } catch (e) {
      post('fetchAllResult', { ok: false, reason: String(e?.message || e), got, total });
    } finally {
      fetching = false;
    }
  }

  // --- Guidebooks: fetch all sentences of all units ------------------------------
  let gbBusy = false;
  const CYR = /[\u0400-\u04FF]/;

  function currentUserId() {
    const jwt = (document.cookie.match(/(?:^|; )jwt_token=([^;]+)/) || [])[1];
    if (!jwt) return { jwt: null, uid: null };
    let b = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    return { jwt, uid: JSON.parse(atob(b)).sub };
  }

  // Find all sentence pairs (Russian + translation) in a guidebook, plus the
  // heading ("Say where you are from") they appear under.
  function extractSentences(gb) {
    const out = [];
    let topic = null;
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { o.forEach(walk); return; }
      const t = o.text?.styledString?.text;
      const sub = o.subtext?.styledString?.text;
      if (typeof t === 'string' && typeof sub === 'string') {
        let ru = t.trim(), en = sub.trim();
        if (!CYR.test(ru) && CYR.test(en)) [ru, en] = [en, ru];
        if (ru && en) out.push({ russian: ru, english: en, topic });
        return;
      }
      for (const v of Object.values(o)) walk(v);
    };
    for (const el of gb?.elements || []) {
      if (el.type === 'text') {
        const ss = el.element?.styledString;
        const attr = ss?.styling?.[0]?.attributes || {};
        if (ss?.text && attr.fontWeight === 'bold' && (attr.fontSize || 0) >= 20) topic = ss.text.trim();
        continue;
      }
      walk(el.element);
    }
    return out;
  }

  async function fetchGuidebooks() {
    if (gbBusy) return;
    gbBusy = true;
    try {
      const { jwt, uid } = currentUserId();
      if (!uid) throw new Error('Not logged in to Duolingo');
      const res = await origFetch(`/2017-06-30/users/${uid}?fields=currentCourse`, {
        credentials: 'include', headers: { Authorization: 'Bearer ' + jwt, Accept: 'application/json' },
      });
      if (!res.ok) throw new Error('Fetching the course failed (HTTP ' + res.status + ')');
      const cc = (await res.json()).currentCourse;
      if (!cc) throw new Error('No active course found');
      if (cc.learningLanguage !== LANG) { post('wrongLanguage', { learningLanguage: cc.learningLanguage }); throw new Error('The active course is not Russian'); }

      const units = [];
      for (const sec of cc.pathSectioned || []) {
        (sec.units || []).forEach((u, i) => {
          if (u.guidebook?.url) units.push({ section: sec.index + 1, unit: i + 1, courseUnit: (u.unitIndex ?? 0) + 1, unitTitle: u.teachingObjective || null, url: u.guidebook.url });
        });
      }
      if (!units.length) throw new Error('No guidebooks found in this course');

      const sentences = [];
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        let gb = null;
        for (let attempt = 0; attempt < 3 && !gb; attempt++) {
          try { const r = await origFetch(u.url); if (r.ok) gb = await r.json(); } catch (_) {}
          if (!gb) await sleep(1000);
        }
        const seen = new Set();
        for (const s of gb ? extractSentences(gb) : []) {
          const key = s.russian + '\u0001' + s.english;
          if (seen.has(key)) continue;
          seen.add(key);
          sentences.push({ russian: s.russian, english: s.english, section: u.section, unit: u.unit, courseUnit: u.courseUnit, unitTitle: u.unitTitle, topic: s.topic });
        }
        post('guidebookProgress', { done: i + 1, total: units.length, sentences: sentences.length });
        await sleep(100);
      }
      post('guidebook', { fromLanguage: cc.fromLanguage, units: units.length, sentences });
    } catch (e) {
      post('guidebookResult', { ok: false, reason: String(e?.message || e) });
    } finally {
      gbBusy = false;
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || !e.data.__dwl || e.data.dir !== 'ext') return;
    if (e.data.type === 'fetchAll') fetchAll();
    if (e.data.type === 'fetchGuidebooks') fetchGuidebooks();
    if (e.data.type === 'hasTemplate') post('template', { ready: !!template });
  });
})();
