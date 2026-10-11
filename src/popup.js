const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

function render(s) {
  if (!s) return;
  const sel = $('course');
  sel.hidden = s.courses.length < 2;
  sel.innerHTML = s.courses.map((c) => `<option value="${c.key}">${c.label}</option>`).join('');
  if (s.currentKey) sel.value = s.currentKey;
  const c = s.current;
  $('stat').innerHTML = c
    ? `<b>${c.unique}</b> unique Russian words in base form<br>${c.raw} word forms seen on Duolingo` +
      (s.pending ? `<br>${s.pending} words still to look up…` : '')
    : 'No words yet. Click <i>Fetch all</i> (logged in to Duolingo, Russian course active).';
}

function renderGb(s, prog) {
  const p = prog || s?.gbProgress;
  let t = s?.guidebook
    ? `<b>${s.guidebook.count}</b> sentences from ${s.guidebook.units} units`
    : 'Not fetched yet.';
  if (p && !p.finished) t = p.error ? 'Failed: ' + p.error : `Working… unit ${p.done} / ${p.total ?? '?'} · ${p.sentences} sentences`;
  $('gbStat').innerHTML = t;
}

async function refresh() { const s = await send({ type: 'getStatus' }); render(s); renderGb(s); }

$('course').onchange = async (e) => { await send({ type: 'setCurrent', courseKey: e.target.value }); refresh(); };
$('fetch').onclick = () => { $('msg').textContent = 'Opening the words page…'; send({ type: 'startFetch' }); };
$('list').onclick = () => send({ type: 'openList' });
$('flash').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('flashcards.html') });
for (const [id, saveAs] of [['export', false], ['exportAs', true]]) {
  $(id).onclick = async () => {
    const r = await send({ type: 'export', courseKey: $('course').value || undefined, saveAs });
    $('msg').textContent = r?.ok
      ? `Saved to Downloads/${r.filename} (${r.count} words)` + (r.pending ? ` — note: ${r.pending} not processed yet` : '')
      : 'Failed: ' + (r?.error || '?');
  };
}
$('gbFetch').onclick = () => { $('gbStat').textContent = 'Starting…'; send({ type: 'startGuidebooks' }); };
$('gbExport').onclick = async () => {
  const r = await send({ type: 'exportGuidebook', saveAs: false });
  $('msg').textContent = r?.ok ? `Saved to Downloads/${r.filename} (${r.count} sentences)` : 'Failed: ' + (r?.error || '?');
};
chrome.runtime.onMessage.addListener((m) => {
  if (m.type === 'statusUpdate') render(m.status);
  if (m.type === 'guidebookUpdate') { if (m.progress.finished) refresh(); else renderGb(null, m.progress); }
});
refresh();
