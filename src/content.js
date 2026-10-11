// Content script (isolated world). Bridge between the page (inject.js) and the
// extension (background.js); also shows a small panel on the words page.
(() => {
  const WORDS_PATH = /^\/practice-hub\/words/;
  let templateReady = false;
  let panel = null;
  let lastStatus = null;

  const toPage = (type, payload) =>
    window.postMessage({ __dwl: true, dir: 'ext', type, payload }, location.origin);

  const send = (msg) =>
    chrome.runtime.sendMessage(msg).catch(() => null);

  // --- Messages from the page --------------------------------------------------
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || !e.data.__dwl || e.data.dir !== 'page') return;
    const { type, payload } = e.data;
    if (type === 'lexemes') {
      send({ type: 'lexemes', course: payload.course, items: payload.items, total: payload.total });
    } else if (type === 'guidebookProgress') {
      setMessage(`Guidebooks: unit ${payload.done} / ${payload.total} · ${payload.sentences} sentences`);
      send({ type: 'guidebookProgress', ...payload });
    } else if (type === 'guidebook') {
      send({ type: 'guidebook', data: payload }).then((r) => {
        setMessage(r?.ok ? `Guidebook sentences saved: ${r.filename} (${r.count} sentences from ${payload.units} units)` : 'Saving failed: ' + (r?.error || '?'));
      });
    } else if (type === 'guidebookResult') {
      setMessage('Guidebooks: ' + payload.reason);
      send({ type: 'guidebookProgress', error: payload.reason });
    } else if (type === 'wrongLanguage') {
      setMessage('This extension only works with the Russian course. Switch to Russian on Duolingo.');
    } else if (type === 'template') {
      templateReady = !!payload.ready;
    } else if (type === 'progress') {
      setMessage(`Fetching… ${payload.got}${payload.total ? ' / ' + payload.total : ''} words`);
    } else if (type === 'fetchAllResult') {
      if (payload.ok) setMessage(`Done: ${payload.got} words fetched. Looking up base forms…`);
      else if (payload.reason === 'no-template') fallbackLoadMore();
      else setMessage('Fetching failed: ' + payload.reason);
    }
  });

  // --- Messages from popup / background -----------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === 'fetchAll') { startFetchAll(); reply({ ok: true, onWordsPage: isWordsPage() }); }
    else if (msg.type === 'fetchGuidebooks') { toPage('fetchGuidebooks'); reply({ ok: true }); }
    else if (msg.type === 'scanDom') { reply({ ok: true, count: scanDom() }); }
    else if (msg.type === 'status') { lastStatus = msg.status; renderStatus(); }
    return false;
  });

  function isWordsPage() { return WORDS_PATH.test(location.pathname); }

  function startFetchAll() {
    if (!isWordsPage()) {
      setMessage('Opening the words page first.');
      location.href = 'https://www.duolingo.com/practice-hub/words';
      return;
    }
    setMessage('Fetching started…');
    toPage('fetchAll');
  }

  // If we haven't seen the API request yet: click "Load more" ourselves until
  // nothing new appears. Every click is captured by inject.js.
  async function fallbackLoadMore() {
    setMessage('Loading the word list via the "Load more" button…');
    const re = /(load|show|see|view) more|meer (laden|tonen|weergeven)|toon meer|mehr (laden|anzeigen)|cargar más|ver más|charger plus|voir plus|carica altro|mostra altro|carregar mais|ver mais|załaduj więcej|показать ещё|показать еще/i;
    for (let i = 0; i < 300; i++) {
      if (templateReady) { toPage('fetchAll'); return; }
      const btn = [...document.querySelectorAll('button, [role="button"], li[role="button"]')]
        .find((b) => re.test((b.innerText || b.textContent || '').trim()));
      if (!btn) break;
      btn.click();
      await new Promise((r) => setTimeout(r, 900));
    }
    if (templateReady) { toPage('fetchAll'); return; }
    const n = scanDom();
    setMessage(n ? `${n} words read from the page.` : 'No words found. Scroll through the list and try again.');
  }

  // Fallback: read the words directly from the page's HTML.
  function scanDom() {
    if (!isWordsPage()) return 0;
    const lists = [...document.querySelectorAll('ul, ol')].filter((l) => l.children.length >= 3);
    const items = [];
    for (const list of lists) {
      if (list.closest('nav, header, aside')) continue;
      for (const li of list.children) {
        const lines = (li.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
        if (!lines.length || lines[0].length > 60) continue;
        items.push({ text: lines[0], translations: lines.slice(1, 2).join(', ').split(/\s*,\s*/).filter(Boolean) });
      }
    }
    if (items.length) send({ type: 'lexemes', course: null, items, source: 'dom' });
    return items.length;
  }

  // --- Panel ----------------------------------------------------------------------
  function ensurePanel() {
    if (!isWordsPage()) { if (panel) { panel.host.remove(); panel = null; } return; }
    if (panel || !document.body) return;
    const host = document.createElement('div');
    host.id = 'dwl-panel-host';
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .box{font:13px/1.4 system-ui,-apple-system,sans-serif;background:#fff;color:#3c3c3c;border:2px solid #e5e5e5;
             border-radius:14px;padding:12px 14px;width:260px;box-shadow:0 4px 16px rgba(0,0,0,.12)}
        h1{font-size:14px;margin:0 0 6px;color:#58a700}
        .stat{margin:4px 0 8px}
        .msg{color:#777;min-height:18px;margin-bottom:8px}
        button{font:600 12px system-ui,sans-serif;border:0;border-radius:10px;padding:8px 10px;cursor:pointer;margin:2px 4px 2px 0}
        .primary{background:#58cc02;color:#fff;box-shadow:0 3px 0 #58a700}
        .secondary{background:#f0f0f0;color:#3c3c3c}
        .x{float:right;background:none;padding:0 2px;color:#aaa;font-size:16px}
        @media (prefers-color-scheme: dark){.box{background:#131f24;color:#e8eef0;border-color:#37464f}.secondary{background:#37464f;color:#e8eef0}.msg{color:#a0aeb5}}
      </style>
      <div class="box">
        <button class="x" title="Hide">×</button>
        <h1>Russian word list</h1>
        <div class="stat">–</div>
        <div class="msg"></div>
        <button class="primary" data-a="fetch">Fetch all</button>
        <button class="secondary" data-a="export">Save JSON</button>
        <button class="secondary" data-a="list">View list</button>
        <button class="secondary" data-a="gb">Guidebook sentences</button>
      </div>`;
    root.querySelector('.x').onclick = () => (host.style.display = 'none');
    root.querySelector('[data-a=fetch]').onclick = startFetchAll;
    root.querySelector('[data-a=export]').onclick = async () => {
      const r = await send({ type: 'export' });
      setMessage(r?.ok ? `Saved: ${r.filename} (${r.count} words)` : 'Saving failed: ' + (r?.error || '?'));
    };
    root.querySelector('[data-a=list]').onclick = () => send({ type: 'openList' });
    root.querySelector('[data-a=gb]').onclick = () => { setMessage('Fetching guidebooks…'); toPage('fetchGuidebooks'); };
    document.body.appendChild(host);
    panel = { host, root };
    renderStatus();
    send({ type: 'getStatus' }).then((s) => { if (s) { lastStatus = s; renderStatus(); } });
  }

  function setMessage(text) {
    ensurePanel();
    if (panel) panel.root.querySelector('.msg').textContent = text;
  }

  function renderStatus() {
    if (!panel || !lastStatus) return;
    const c = lastStatus.current;
    panel.root.querySelector('.stat').textContent = c
      ? `${c.raw} words seen → ${c.unique} unique base forms` +
        (lastStatus.pending ? ` (${lastStatus.pending} still to process)` : '')
      : 'No words captured yet.';
  }

  // Duolingo is a single-page app: keep watching the URL.
  let lastPath = '';
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      ensurePanel();
      if (isWordsPage()) toPage('hasTemplate');
    }
  }, 700);
})();
