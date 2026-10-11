const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const STATUS_LABEL = {
  lemma: 'base form', inflected: 'converted', manual: 'manual',
  unknown: 'not found', error: 'error', pending: 'working…',
};

let data = null;
let editing = false;

async function load() {
  if (editing) return;
  const r = await send({ type: 'getList', courseKey: $('course').value || undefined });
  data = r;
  const s = r.status;
  $('course').innerHTML = s.courses.map((c) => `<option value="${c.key}">${esc(c.label)}</option>`).join('');
  if (s.currentKey) $('course').value = s.currentKey;
  const l = r.list;
  $('sub').textContent = l
    ? `${l.count} unique words · ${l.totalSeen} forms seen on Duolingo` + (s.pending ? ` · ${s.pending} still to look up…` : '')
    : 'No words captured yet. Open the words page on Duolingo and click "Fetch all".';
  render();
}

function render() {
  const l = data?.list;
  if (!l) { $('rows').innerHTML = ''; return; }
  const q = $('q').value.trim().toLocaleLowerCase();
  const f = $('filter').value;
  const rows = l.words.filter((w) =>
    (!f || w.status === f || (f === 'unknown' && w.status === 'error')) &&
    (!q || [w.word, ...w.forms, ...w.translations].some((x) => x.toLocaleLowerCase().includes(q))));
  $('rows').innerHTML = rows.map((w) => `
    <tr>
      <td class="word"><input value="${esc(w.word)}" data-forms="${esc(JSON.stringify(w.forms))}" data-orig="${esc(w.word)}" lang="ru"></td>
      <td class="hide-sm">${esc(w.partOfSpeech || '')}</td>
      <td>${esc(w.translations.join(', '))}</td>
      <td class="forms hide-sm">${esc(w.forms.filter((x) => x !== w.word).join(', '))}</td>
      <td><span class="pill s-${w.status}">${STATUS_LABEL[w.status] || w.status}</span></td>
    </tr>`).join('');
}

$('rows').addEventListener('focusin', () => (editing = true));
$('rows').addEventListener('focusout', async (e) => {
  editing = false;
  const inp = e.target;
  if (inp.tagName !== 'INPUT' || inp.value.trim() === inp.dataset.orig) return;
  await send({ type: 'setOverride', courseKey: $('course').value, forms: JSON.parse(inp.dataset.forms), lemma: inp.value });
  load();
});
$('rows').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

$('q').oninput = render;
$('filter').onchange = render;
$('course').onchange = async () => { await send({ type: 'setCurrent', courseKey: $('course').value }); load(); };
$('export').onclick = async () => {
  const r = await send({ type: 'export', courseKey: $('course').value, saveAs: true });
  if (!r?.ok) alert('Saving failed: ' + (r?.error || '?'));
};
$('retry').onclick = () => send({ type: 'retry' });
$('clear').onclick = async () => {
  if (!confirm('Delete all saved words?')) return;
  await send({ type: 'clearCourse', courseKey: $('course').value });
  load();
};

chrome.runtime.onMessage.addListener((m) => { if (m.type === 'statusUpdate') load(); });
load();
