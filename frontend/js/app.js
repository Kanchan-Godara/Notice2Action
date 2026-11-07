/* app.js - router + all pages. Pages are drawn by setting innerHTML from template strings.
   Anything that came from a notice goes through esc() first so it can never inject HTML. */
const $ = (s, root = document) => root.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  settings: { student_name: '', language: 'english', reminder_days: '2' },
  status: { ai_available: false, model: null },
  tasks: new Map(),            // id -> task, so buttons can find the task they belong to
  texts: {},                   // notice id -> full text (for highlighting the source sentence)
  filters: { priority: '', status: 'pending', sort: 'deadline' },
  cal: new Date(), selDay: null, warning: null,
};

/* ---------- small helpers ---------- */
const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>',
  upload: '<path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  results: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  tasks: '<path d="m9 11 3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
};
const icon = (n) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n]}</svg>`;
const loading = () => '<div class="spinner" role="status" aria-label="Loading"></div>';
const head = (t, sub) => `<div class="page-head"><h1>${t}</h1>${sub ? `<p>${sub}</p>` : ''}</div>`;
const empty = (title, text, btn) => `<div class="card empty"><div class="art"></div><h3>${title}</h3><p>${text}</p>${btn || ''}</div>`;
const errorBox = (m) => `<div class="alert conflict"><div><b>Something went wrong</b><br>${esc(m)}</div></div>`;
const fmtDate = (iso) => iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const fmtTime = (t) => { if (!t) return ''; const [h, m] = t.split(':'); return `${(+h % 12) || 12}:${m} ${+h < 12 ? 'am' : 'pm'}`; };
const fmtSize = (b) => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const daysUntil = (iso) => Math.round((new Date(iso + 'T00:00:00') - new Date(todayIso() + 'T00:00:00')) / 86400000);
const cache = (list) => list.forEach((t) => state.tasks.set(String(t.id), t));

function toast(msg, bad) {
  const el = document.createElement('div');
  el.className = 'toast' + (bad ? ' bad' : ''); el.textContent = msg;
  $('#toasts').appendChild(el); setTimeout(() => el.remove(), 3200);
}

/* ---------- task row (used on dashboard, results and tasks pages) ---------- */
function dueChip(t) {
  if (t.status === 'completed' || !t.deadline) return '';
  const d = daysUntil(t.deadline);
  if (d < 0) return `<span class="badge urgent">Overdue by ${-d} day${d === -1 ? '' : 's'}</span>`;
  if (d === 0) return '<span class="badge urgent">Due today</span>';
  if (d <= (+state.settings.reminder_days || 2)) return `<span class="badge high">Due in ${d} day${d === 1 ? '' : 's'}</span>`;
  return '';
}
function taskRow(t, showNotice) {
  const when = t.deadline ? `${fmtDate(t.deadline)}${t.deadline_time ? ', ' + fmtTime(t.deadline_time) : ''}` : 'No date found';
  return `<div class="task ${t.status}" data-id="${t.id}">
    <button class="check" data-act="toggle" aria-label="${t.status === 'completed' ? 'Mark as pending' : 'Mark as completed'}"></button>
    <div class="task-main" data-act="source">
      <div class="t-title">${esc(t.title)}</div>
      <div class="meta">
        <span class="badge ${t.deadline ? '' : 'warn'}">${esc(when)}</span>
        ${t.deadline && !t.date_certain ? '<span class="badge warn" title="The notice does not clearly state this date">Date uncertain</span>' : ''}
        <span class="badge ${t.priority}">${t.priority}</span>${dueChip(t)}
        ${t.source_verified ? '<span class="badge ok">Source found</span>' : '<span class="badge warn">No source sentence</span>'}
        ${showNotice && t.notice_title ? `<span class="muted small">${esc(t.notice_title)}</span>` : ''}
      </div></div>
    <div class="actions">
      <button class="btn small" data-act="source">Source</button>
      <button class="btn small" data-act="edit">Edit</button>
      <button class="btn small danger" data-act="delete">Delete</button>
    </div></div>`;
}
const taskList = (list, showNotice, emptyText) => list.length ? list.map((t) => taskRow(t, showNotice)).join('') : `<p class="muted">${emptyText}</p>`;

/* ---------- router ---------- */
async function route() {
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  closeNav(); closeDrawer(); window.scrollTo(0, 0);
  if (!name) { $('#app').dataset.mode = 'landing'; $('#app').innerHTML = landing(); return; }
  if (!PAGES[name]) { location.hash = '#/'; return; }
  await renderPage(name, arg);
}
async function renderPage(name, arg) {
  const app = $('#app');
  if (app.dataset.mode !== 'shell') { app.dataset.mode = 'shell'; app.innerHTML = shell(); }
  const active = name === 'notice' ? 'results' : name;
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === active));
  const view = $('#view'); view.innerHTML = loading();
  try { await PAGES[name](view, arg); } catch (e) { view.innerHTML = errorBox(e.message); }
}
async function refresh() { const y = window.scrollY; const [name, arg] = location.hash.replace(/^#\/?/, '').split('/'); await renderPage(name, arg); window.scrollTo(0, y); }

function shell() {
  const links = [['dashboard', 'Dashboard'], ['upload', 'Upload notice'], ['results', 'Analysis results'], ['tasks', 'My tasks'], ['calendar', 'Calendar'], ['settings', 'Settings']];
  return `<div class="shell">
    <header class="topbar"><a class="logo" href="#/"><i></i>Notice2Action</a><button class="btn small" data-act="nav" aria-label="Open menu">Menu</button></header>
    <aside class="sidebar"><a class="logo" href="#/"><i></i>Notice2Action</a>
      <nav class="nav">${links.map(([p, l]) => `<a href="#/${p}" data-page="${p}">${icon(p)}${l}</a>`).join('')}</nav></aside>
    <main class="main" id="view"></main></div>`;
}
const closeNav = () => document.body.classList.remove('nav-open');

/* ---------- landing ---------- */
function landing() {
  return `<div class="land">
    <nav><a class="logo" href="#/"><i></i>Notice2Action</a><a class="btn" href="#/dashboard">Open dashboard</a></nav>
    <section class="hero"><div>
      <h1>From confusing college notices to clear student action plans.</h1>
      <p class="lead">Upload a PDF or paste a notice from WhatsApp. Notice2Action pulls out what you need to do, when it is due, and shows the exact sentence it came from.</p>
      <div class="row"><a class="btn primary" href="#/upload">Analyse a notice</a><a class="btn" href="#/dashboard">See my dashboard</a></div></div>
      <div class="demo" aria-label="Example of how a notice becomes a task">
        <span class="badge purple">Example</span>
        <div class="notice" style="margin-top:10px">…Library dues must be cleared first. <mark>All students must submit the DBMS lab file on or before 14 November 2026 by 4:00 pm.</mark> Late files will not be accepted.</div>
        <div class="arrow">becomes</div>
        <div class="task" style="border:0;padding:0"><div class="task-main"><div class="t-title">Submit the DBMS lab file</div>
          <div class="meta"><span class="badge">14 Nov 2026, 4:00 pm</span><span class="badge high">high</span><span class="badge ok">Source found</span></div></div></div>
      </div></section>
    <section class="features">
      <div class="card"><h2>Every task shows its source</h2><p>Click a task to see the exact sentence in your notice. No source sentence means no “verified” label.</p></div>
      <div class="card"><h2>Honest about uncertainty</h2><p>Missing year or unclear date? The task is marked “Date uncertain” instead of guessing quietly.</p></div>
      <div class="card"><h2>Clashes, not false alarms</h2><p>Two tasks on one day are only a clash when their times overlap. Otherwise you get a gentle busy-day note.</p></div>
      <div class="card"><h2>Simple language</h2><p>Get a notice explained in plain English, Hindi or Punjabi, with every date kept exactly as written.</p></div>
    </section>
    <h2 class="big">How it works</h2>
    <section class="steps">
      <div class="card"><h3>Add your notice</h3><p class="muted">Upload a PDF or paste text.</p></div>
      <div class="card"><h3>Review the tasks</h3><p class="muted">Check each task against its source sentence.</p></div>
      <div class="card"><h3>Stay on schedule</h3><p class="muted">Track tasks on your dashboard and calendar.</p></div>
    </section>
    <footer class="foot">Notice2Action - a student project. Always confirm important deadlines with your college.</footer></div>`;
}

/* ---------- dashboard ---------- */
async function dashboard(view) {
  const [d, notices] = await Promise.all([API.get('/dashboard'), API.get('/notices')]);
  cache(d.urgent); cache(d.upcoming);
  const name = state.settings.student_name;
  const clashes = d.conflicts.filter((c) => c.level === 'conflict').length;
  const stat = (n, label, cls = '') => `<div class="stat ${cls}"><b>${n}</b><span>${label}</span></div>`;
  view.innerHTML = head(`Welcome${name ? ', ' + esc(name) : ''}`, 'Your notices, deadlines and tasks in one place.') + (!notices.length
    ? empty('No notices yet', 'Upload a PDF or paste a notice to get your first action plan.', '<a class="btn primary" href="#/upload">Add a notice</a>')
    : `<div class="stats">
        ${stat(d.total_notices, 'Notices processed')}${stat(d.pending, 'Pending tasks', 'purple')}${stat(d.completed, 'Completed tasks', 'green')}
        ${stat(d.urgent.length, 'Urgent tasks', 'red')}${stat(d.upcoming.length, 'Due in 7 days', 'orange')}${stat(clashes, 'Deadline clashes', 'red')}</div>
      ${d.conflicts.map((c) => `<div class="alert ${c.level === 'conflict' ? 'conflict' : ''}"><div><b>${c.level === 'conflict' ? 'Possible clash' : 'Busy day'} on ${fmtDate(c.date)}</b><br>${esc(c.message)}</div></div>`).join('')}
      ${d.overdue.length ? `<div class="alert conflict"><div><b>${d.overdue.length} overdue task${d.overdue.length > 1 ? 's' : ''}</b><br>Check “My tasks” to complete or reschedule them.</div></div>` : ''}
      <div class="grid2" style="margin-bottom:18px">
        <section class="card"><h2>Urgent tasks</h2>${taskList(d.urgent, true, 'Nothing urgent right now.')}</section>
        <section class="card"><h2>Due in the next 7 days</h2>${taskList(d.upcoming, true, 'No deadlines this week.')}</section></div>
      <section class="card"><h2>Recent notices</h2>${notices.slice(0, 6).map((n) => `
        <div class="task" style="align-items:center"><div class="task-main" style="cursor:default"><div class="t-title">${esc(n.title)}</div>
          <div class="meta"><span class="badge">${n.source_type === 'pdf' ? 'PDF' : 'Pasted text'}</span><span class="badge">${n.task_count} task${n.task_count === 1 ? '' : 's'}</span>
          <span class="badge ${n.method === 'ai' ? 'purple' : ''}">${n.method === 'ai' ? 'AI analysis' : 'Rule-based'}</span></div></div>
          <div class="actions"><a class="btn small" href="#/notice/${n.id}">View</a><button class="btn small danger" data-act="delnotice" data-nid="${n.id}">Delete</button></div></div>`).join('')}</section>`);
}

/* ---------- upload ---------- */
let pickedFile = null;
async function upload(view) {
  pickedFile = null;
  view.innerHTML = head('Upload notice', 'Add a PDF or paste the text of a notice. Maximum PDF size is 10 MB.') + `
  <div class="card"><div class="tabs" role="tablist"><button class="on" data-tab="pdf" role="tab">Upload PDF</button><button data-tab="text" role="tab">Paste text</button></div>
    <div id="pane-pdf"><div class="drop" id="drop" tabindex="0"><b>Drop a PDF here, or click to choose</b><div class="muted small">PDF files only, up to 10 MB. Scanned images are not supported yet.</div></div>
      <input type="file" id="file" accept="application/pdf,.pdf" hidden><div id="fileinfo"></div></div>
    <div id="pane-text" hidden><label for="paste" style="margin-top:0">Notice text</label><textarea id="paste" placeholder="Paste the notice here, for example from WhatsApp or your college website."></textarea></div>
    <label for="title">Title (optional)</label><input type="text" id="title" maxlength="80" placeholder="e.g. Mid-semester exam notice">
    <div id="status"></div>
    <div class="row" style="margin-top:18px"><button class="btn primary" id="go">Analyse notice</button></div></div>`;

  const setFile = (f) => {
    const info = $('#fileinfo'); pickedFile = null; info.innerHTML = '';
    if (!f) return;
    if (!f.name.toLowerCase().endsWith('.pdf')) return toast('Only PDF files are allowed.', true);
    if (f.size > 10 * 1024 * 1024) return toast('That file is over 10 MB.', true);
    pickedFile = f;
    info.innerHTML = `<div class="fileinfo"><div><b>${esc(f.name)}</b><div class="muted small">PDF, ${fmtSize(f.size)}</div></div><button class="btn small" id="rm">Remove</button></div>`;
    $('#rm').onclick = () => { $('#file').value = ''; setFile(null); };
  };
  const drop = $('#drop');
  drop.onclick = () => $('#file').click();
  drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file').click(); } };
  $('#file').onchange = (e) => setFile(e.target.files[0]);
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); setFile(e.dataTransfer.files[0]); };
  document.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => {
    document.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
    $('#pane-pdf').hidden = b.dataset.tab !== 'pdf'; $('#pane-text').hidden = b.dataset.tab !== 'text';
  });

  $('#go').onclick = async () => {
    const isPdf = !$('#pane-pdf').hidden, title = $('#title').value.trim(), status = $('#status'), btn = $('#go');
    if (isPdf && !pickedFile) return toast('Choose a PDF first.', true);
    if (!isPdf && $('#paste').value.trim().length < 20) return toast('Paste at least a few sentences.', true);
    btn.disabled = true;
    status.innerHTML = '<div class="progress"><div id="bar"></div></div><div class="muted small" id="stxt">Uploading…</div>';
    try {
      const bar = $('#bar'), stxt = $('#stxt');
      const data = isPdf
        ? await API.uploadPdf(pickedFile, title, (p) => { bar.style.width = Math.round(p * 100) + '%'; if (p >= 1) stxt.textContent = 'Reading the PDF and finding tasks…'; })
        : (bar.style.width = '100%', stxt.textContent = 'Finding tasks…', await API.analyseText($('#paste').value, title));
      state.warning = data.ai_warning;
      toast(`Found ${data.tasks.length} task${data.tasks.length === 1 ? '' : 's'}`);
      location.hash = '#/notice/' + data.notice.id;
    } catch (e) { status.innerHTML = errorBox(e.message); btn.disabled = false; }
  };
}

/* ---------- results ---------- */
async function results(view) {
  const notices = await API.get('/notices');
  if (!notices.length) { view.innerHTML = head('Analysis results') + empty('Nothing analysed yet', 'Your results will appear here after you add a notice.', '<a class="btn primary" href="#/upload">Add a notice</a>'); return; }
  location.replace('#/notice/' + notices[0].id);
}
async function notice(view, id) {
  const [data, notices] = await Promise.all([API.get('/notices/' + id), API.get('/notices')]);
  const n = data.notice; cache(data.tasks); state.texts[n.id] = n.raw_text;
  const ai = n.method === 'ai', warning = state.warning; state.warning = null;
  view.innerHTML = head(esc(n.title), `${n.source_type === 'pdf' ? `PDF, ${n.page_count} page${n.page_count === 1 ? '' : 's'}, ${fmtSize(n.file_size)}` : 'Pasted text'} - ${ai ? 'analysed with AI' : 'analysed with rule-based extraction'}`) + `
    <div class="row" style="margin-bottom:16px"><label for="pick" style="margin:0">Notice</label>
      <select id="pick" style="max-width:340px">${notices.map((x) => `<option value="${x.id}" ${x.id === n.id ? 'selected' : ''}>${esc(x.title)}</option>`).join('')}</select></div>
    ${warning ? `<div class="alert"><div>${esc(warning)}</div></div>` : ''}
    ${ai ? '' : '<div class="alert info"><div>Rule-based extraction finds dates and action words. Check each task against its source sentence before relying on it.</div></div>'}
    ${n.summary ? `<section class="card"><h2>${ai ? 'Summary' : 'Opening lines of the notice'}</h2><p style="margin:0">${esc(n.summary)}</p></section>` : ''}
    ${data.conflicts.map((c) => `<div class="alert ${c.level === 'conflict' ? 'conflict' : ''}"><div><b>${c.level === 'conflict' ? 'Possible clash' : 'Busy day'} on ${fmtDate(c.date)}</b><br>${esc(c.message)}</div></div>`).join('')}
    <section class="card"><h2>Tasks found (${data.tasks.length})</h2>${data.tasks.length ? taskList(data.tasks, false, '')
      : '<p class="muted">No tasks with action words or deadlines were found. Read the original text below to check.</p>'}</section>
    <section class="card"><h2>Explain in simple language</h2>
      <div class="row"><select id="lang" style="max-width:200px"><option value="english">English</option><option value="hindi">Hindi</option><option value="punjabi">Punjabi</option></select>
        <button class="btn primary" id="simplify">Explain simply</button></div>
      ${state.status.ai_available ? '' : '<p class="muted small">This feature needs a Gemini API key. See Settings.</p>'}<div id="simple"></div></section>
    <section class="card"><details><summary>Original notice text</summary><pre>${esc(n.raw_text)}</pre></details></section>
    <div class="row"><button class="btn danger" data-act="delnotice" data-nid="${n.id}">Delete this notice</button></div>`;
  $('#lang').value = state.settings.language;
  $('#pick').onchange = (e) => { location.hash = '#/notice/' + e.target.value; };
  $('#simplify').onclick = async () => {
    const out = $('#simple'), btn = $('#simplify'); btn.disabled = true; out.innerHTML = loading();
    try { const r = await API.send('POST', `/notices/${n.id}/simplify`, { language: $('#lang').value }); out.innerHTML = `<div class="simple-out">${esc(r.explanation)}</div><p class="muted small">AI-written explanation. Check dates against the original notice.</p>`; }
    catch (e) { out.innerHTML = errorBox(e.message); }
    btn.disabled = false;
  };
}

/* ---------- tasks ---------- */
async function tasks(view) {
  const f = state.filters, qs = new URLSearchParams({ sort: f.sort });
  if (f.priority) qs.set('priority', f.priority); if (f.status) qs.set('status', f.status);
  const list = await API.get('/tasks?' + qs); cache(list);
  const sel = (key, opts) => `<select data-filter="${key}" aria-label="${key}">${opts.map(([v, l]) => `<option value="${v}" ${f[key] === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  view.innerHTML = head('My tasks', 'Everything from all your notices.') + `
    <div class="row" style="margin-bottom:16px">
      ${sel('status', [['pending', 'Pending'], ['completed', 'Completed'], ['', 'All tasks']])}
      ${sel('priority', [['', 'Any priority'], ['urgent', 'Urgent'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']])}
      ${sel('sort', [['deadline', 'Sort by deadline'], ['newest', 'Sort by newest']])}</div>
    <section class="card">${list.length ? taskList(list, true, '') : empty('No tasks match', 'Change the filters, or add a notice to create tasks.', '<a class="btn primary" href="#/upload">Add a notice</a>')}</section>`;
  document.querySelectorAll('[data-filter]').forEach((s) => s.style.maxWidth = '200px');
}

/* ---------- calendar ---------- */
async function calendar(view) {
  const y = state.cal.getFullYear(), m = state.cal.getMonth(), key = `${y}-${String(m + 1).padStart(2, '0')}`;
  const [list, pending] = await Promise.all([API.get('/calendar?month=' + key), API.get('/tasks?status=pending')]);
  cache(list); cache(pending);
  const byDay = {}; list.forEach((t) => (byDay[t.deadline] = byDay[t.deadline] || []).push(t));
  const lead = (new Date(y, m, 1).getDay() + 6) % 7, total = new Date(y, m + 1, 0).getDate(), today = todayIso();
  let cells = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="dow">${d}</div>`).join('') + '<div class="cell blank"></div>'.repeat(lead);
  for (let d = 1; d <= total; d++) {
    const iso = `${key}-${String(d).padStart(2, '0')}`, items = byDay[iso] || [];
    cells += `<button class="cell ${iso === today ? 'today' : ''} ${iso === state.selDay ? 'sel' : ''}" data-act="day" data-date="${iso}" aria-label="${fmtDate(iso)}, ${items.length} tasks">
      <span class="n">${d}</span>${items.slice(0, 2).map((t) => `<span class="chip p-${t.priority} ${t.status === 'completed' ? 'done' : ''}">${esc(t.title)}</span>`).join('')}
      ${items.length > 2 ? `<span class="muted small">+${items.length - 2} more</span>` : ''}${items.length ? `<span class="dot">${items.length} due</span>` : ''}</button>`;
  }
  const selected = state.selDay ? byDay[state.selDay] || [] : null, undated = pending.filter((t) => !t.deadline);
  view.innerHTML = head('Calendar', 'Deadlines found in your notices.') + `
    <section class="card"><div class="row" style="justify-content:space-between;margin-bottom:14px">
      <button class="btn small" data-act="month" data-dir="-1">Previous</button><h2 style="margin:0">${state.cal.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</h2><button class="btn small" data-act="month" data-dir="1">Next</button></div>
      <div class="cal">${cells}</div></section>
    <section class="card"><h2>${state.selDay ? 'Tasks due ' + fmtDate(state.selDay) : 'Select a day'}</h2>${selected === null ? '<p class="muted">Select a day above to see its tasks.</p>' : taskList(selected, true, 'No tasks are due on this day.')}</section>
    ${undated.length ? `<section class="card"><h2>Tasks without a date</h2>${taskList(undated, true, '')}</section>` : ''}`;
}

/* ---------- settings ---------- */
async function settings(view) {
  const s = state.settings, st = state.status;
  view.innerHTML = head('Settings', 'Saved in your local database.') + `
    <section class="card"><label for="sname" style="margin-top:0">Your name</label><input type="text" id="sname" maxlength="40" value="${esc(s.student_name)}">
      <label for="slang">Default language for simple explanations</label>
      <select id="slang"><option value="english">English</option><option value="hindi">Hindi</option><option value="punjabi">Punjabi</option></select>
      <label for="sdays">Show “due soon” badge when a deadline is within (days)</label><input type="number" id="sdays" min="1" max="14" value="${esc(s.reminder_days)}">
      <div class="row" style="margin-top:18px"><button class="btn primary" id="save">Save settings</button></div></section>
    <section class="card"><h2>AI analysis</h2>${st.ai_available
      ? `<span class="badge ok">Connected</span> <span class="muted">Model: ${esc(st.model)}</span>`
      : '<span class="badge warn">Not configured</span><p class="muted">Rule-based extraction is being used. To turn on AI and Simple Language Mode, copy <code>.env.example</code> to <code>.env</code>, add your <code>GEMINI_API_KEY</code>, and restart the server.</p>'}</section>`;
  $('#slang').value = s.language;
  $('#save').onclick = async () => {
    try {
      state.settings = await API.send('PUT', '/settings', { student_name: $('#sname').value.trim(), language: $('#slang').value, reminder_days: String(Math.min(14, Math.max(1, +$('#sdays').value || 2))) });
      toast('Settings saved');
    } catch (e) { toast(e.message, true); }
  };
}

const PAGES = { dashboard, upload, results, notice, tasks, calendar, settings };

/* ---------- drawer: shows the sentence that supports a task ---------- */
async function openSource(id) {
  const t = state.tasks.get(String(id)); if (!t) return;
  const drawer = $('#drawer'); drawer.innerHTML = loading(); document.body.classList.add('drawer-open');
  let body;
  if (!t.source_sentence) {
    body = '<div class="alert"><div><b>Not verified.</b> No supporting sentence was found for this task. Check the original notice before relying on it.</div></div>';
  } else {
    try {
      if (!state.texts[t.notice_id]) state.texts[t.notice_id] = (await API.get('/notices/' + t.notice_id)).notice.raw_text;
    } catch { /* show the sentence on its own */ }
    const raw = state.texts[t.notice_id] || '', i = raw.indexOf(t.source_sentence);
    const shown = i < 0 ? `<mark>${esc(t.source_sentence)}</mark>`
      : (i > 220 ? '…' : '') + esc(raw.slice(Math.max(0, i - 220), i)) + `<mark>${esc(t.source_sentence)}</mark>` + esc(raw.slice(i + t.source_sentence.length, i + t.source_sentence.length + 220)) + (raw.length > i + t.source_sentence.length + 220 ? '…' : '');
    body = `<h3 style="font-size:1rem">Sentence from your notice</h3><blockquote class="source">${shown}</blockquote><span class="badge ok">Source found</span>`;
  }
  drawer.innerHTML = `<div class="row" style="justify-content:space-between"><h2>${esc(t.title)}</h2><button class="btn small" data-act="close">Close</button></div>
    <div class="meta" style="margin:12px 0 18px"><span class="badge">${t.deadline ? esc(fmtDate(t.deadline)) + (t.deadline_time ? ', ' + fmtTime(t.deadline_time) : '') : 'No date found'}</span>
    ${t.deadline && !t.date_certain ? '<span class="badge warn">Date uncertain</span>' : ''}<span class="badge ${t.priority}">${t.priority}</span></div>
    ${t.description ? `<p class="muted">${esc(t.description)}</p>` : ''}${body}
    <p style="margin-top:20px"><a href="#/notice/${t.notice_id}">Open full notice analysis</a></p>`;
}
function closeDrawer() { document.body.classList.remove('drawer-open'); }

/* ---------- edit dialog ---------- */
function openEdit(id) {
  const t = state.tasks.get(String(id)), dlg = $('#dlg'); if (!t) return;
  dlg.innerHTML = `<h2>Edit task</h2><form method="dialog" id="editform">
    <label for="e-title">Title</label><input type="text" id="e-title" value="${esc(t.title)}" maxlength="150" required>
    <label for="e-desc">Description</label><textarea id="e-desc" style="min-height:80px">${esc(t.description)}</textarea>
    <div class="grid2"><div><label for="e-date">Deadline</label><input type="date" id="e-date" value="${esc(t.deadline || '')}"></div><div><label for="e-time">Time</label><input type="time" id="e-time" value="${esc(t.deadline_time || '')}"></div></div>
    <label for="e-pri">Priority</label><select id="e-pri">${['low', 'medium', 'high', 'urgent'].map((p) => `<option ${t.priority === p ? 'selected' : ''}>${p}</option>`).join('')}</select>
    <div class="row" style="margin-top:20px;justify-content:flex-end"><button type="button" class="btn" id="e-cancel">Cancel</button><button class="btn primary" id="e-save">Save changes</button></div></form>`;
  dlg.showModal();
  $('#e-cancel').onclick = () => dlg.close();
  $('#editform').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await API.send('PATCH', '/tasks/' + id, { title: $('#e-title').value, description: $('#e-desc').value, deadline: $('#e-date').value, deadline_time: $('#e-time').value, priority: $('#e-pri').value });
      dlg.close(); toast('Task saved'); refresh();
    } catch (err) { toast(err.message, true); }
  };
}

/* ---------- one click handler for every button with data-act ---------- */
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const id = el.closest('[data-id]')?.dataset.id;
  try {
    switch (el.dataset.act) {
      case 'toggle': { const t = state.tasks.get(id); const done = t.status !== 'completed';
        await API.send('PATCH', '/tasks/' + id, { status: done ? 'completed' : 'pending' }); toast(done ? 'Marked as completed' : 'Marked as pending'); refresh(); break; }
      case 'source': openSource(id); break;
      case 'edit': openEdit(id); break;
      case 'delete': if (confirm('Delete this task? This cannot be undone.')) { await API.send('DELETE', '/tasks/' + id); toast('Task deleted'); refresh(); } break;
      case 'delnotice': if (confirm('Delete this notice and all its tasks?')) {
        await API.send('DELETE', '/notices/' + el.dataset.nid); toast('Notice deleted');
        location.hash.startsWith('#/notice/') ? (location.hash = '#/dashboard') : refresh(); } break;
      case 'month': state.cal = new Date(state.cal.getFullYear(), state.cal.getMonth() + (+el.dataset.dir), 1); state.selDay = null; refresh(); break;
      case 'day': state.selDay = el.dataset.date; refresh(); break;
      case 'nav': document.body.classList.toggle('nav-open'); break;
      case 'close': closeDrawer(); break;
    }
  } catch (err) { toast(err.message, true); }
});
document.addEventListener('change', (e) => { const k = e.target.dataset.filter; if (k) { state.filters[k] = e.target.value; refresh(); } });
$('#scrim').onclick = closeDrawer;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

/* ---------- start ---------- */
(async function init() {
  try { const [s, st] = await Promise.all([API.get('/settings'), API.get('/status')]); state.settings = s; state.status = st; } catch { /* page will show the error */ }
  window.addEventListener('hashchange', route);
  route();
})();