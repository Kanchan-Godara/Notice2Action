/* app.js - router + all pages. Pages are drawn by setting innerHTML from template strings.
   Anything that came from a notice goes through esc() first so it can never inject HTML. */

const $ = (s, root = document) => root.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  user: null,
  status: { ai_available: false },   // filled in by init(); safe default if the backend is down
  settings: { student_name: '', language: 'english', reminder_days: '2' },
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
const cache = (list) => (list || []).forEach((t) => state.tasks.set(String(t.id), t));

/* Adds a <style> block to <head> once, no matter how many times a page is drawn. */
function injectStyle(id, css) {
  if (document.getElementById(id)) return;
  const el = document.createElement('style');
  el.id = id;
  el.textContent = css;
  document.head.appendChild(el);
}

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
  return `<div class="task ${esc(t.status)}" data-id="${esc(t.id)}">
    <button class="check" data-act="toggle" aria-label="${t.status === 'completed' ? 'Mark as pending' : 'Mark as completed'}"></button>
    <div class="task-main" data-act="source">
      <div class="t-title">${esc(t.title)}</div>
      <div class="meta">
        <span class="badge ${t.deadline ? '' : 'warn'}">${esc(when)}</span>
        ${t.deadline && !t.date_certain ? '<span class="badge warn" title="The notice does not clearly state this date">Date uncertain</span>' : ''}
        <span class="badge ${esc(t.priority)}">${esc(t.priority)}</span>${dueChip(t)}
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

/* ---------- pages table and router ---------- */
const PAGES = {
  login: () => authPage('login'),
  signup: () => authPage('signup'),
  dashboard,
  upload,
  results,
  notice,
  tasks,
  calendar,
  settings,
};

const closeNav = () => document.body.classList.remove('nav-open');

async function route() {
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  closeNav();
  closeDrawer();
  window.scrollTo(0, 0);

  // Landing page
  if (!name) {
    $('#app').dataset.mode = 'landing';
    landing();
    return;
  }

  // Unknown page -> landing
  if (!PAGES[name]) {
    location.hash = '#/';
    return;
  }

  const publicPages = ['login', 'signup'];

  // Logged-in students do not need the login / signup forms
  if (publicPages.includes(name) && state.user) {
    location.hash = '#/dashboard';
    return;
  }

  // Everything else needs a login
  if (!publicPages.includes(name) && !state.user) {
    location.hash = '#/login';
    return;
  }

  await renderPage(name, arg);
}

async function renderPage(name, arg) {
  if (!PAGES[name]) return;
  const app = $('#app');
  if (app.dataset.mode !== 'shell') { app.dataset.mode = 'shell'; app.innerHTML = shell(); }
  const active = name === 'notice' ? 'results' : name;
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === active));
  const view = $('#view'); view.innerHTML = loading();
  try { await PAGES[name](view, arg); } catch (e) { view.innerHTML = errorBox(e.message); }
}

async function refresh() {
  const y = window.scrollY;
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  await renderPage(name, arg);
  window.scrollTo(0, y);
}

function shell() {
  const links = [['dashboard', 'Dashboard'], ['upload', 'Upload notice'], ['results', 'Analysis results'], ['tasks', 'My tasks'], ['calendar', 'Calendar'], ['settings', 'Settings']];
  return `<div class="shell">
    <header class="topbar"><a class="logo" href="#/"><i></i>Notice2Action</a><button class="btn small" data-act="nav" aria-label="Open menu">Menu</button></header>
    <aside class="sidebar"><a class="logo" href="#/"><i></i>Notice2Action</a>
      <nav class="nav">${links.map(([p, l]) => `<a href="#/${p}" data-page="${p}">${icon(p)}${l}</a>`).join('')}</nav>
      <button class="btn small" data-act="logout" style="margin:16px">Log out</button></aside>
    <main class="main" id="view"></main></div>`;
}

/* ---------- landing page styles (added to <head> once; shared by landing and auth pages) ---------- */
const LANDING_CSS = `
.land { background: #faf9ff; color: #25213b; min-height: 100vh; overflow: hidden; }
.land nav { max-width: 1180px; margin: auto; padding: 22px 28px; display: flex; align-items: center; justify-content: space-between; }
.land .logo { font-size: 23px; font-weight: 800; color: #5636bd; text-decoration: none; }
.land a { text-decoration: none; }
.land .nav-links { display: flex; gap: 12px; align-items: center; }
.land .hero { max-width: 1180px; margin: 45px auto 70px; padding: 55px 35px; display: grid; grid-template-columns: 1.1fr .9fr; align-items: center; gap: 35px; }
.land .eyebrow { display: inline-block; padding: 9px 15px; border-radius: 30px; background: #eee8ff; color: #6542c6; font-size: 13px; font-weight: 700; }
.land .hero h1 { font-size: clamp(38px, 5vw, 62px); line-height: 1.12; letter-spacing: -2px; margin: 22px 0; }
.land .gradient-text { color: #7048d7; }
.land .hero p { color: #77738a; font-size: 17px; line-height: 1.8; max-width: 520px; }
.land .hero-actions { display: flex; gap: 13px; flex-wrap: wrap; margin-top: 28px; }
.land .hero-visual { background: linear-gradient(145deg, #e9e0ff, #fce8f1); padding: 30px; border-radius: 30px; box-shadow: 0 25px 60px #6d50ad20; }

/* Workflow card */
.land .workflow-card { background: white; border: 1px solid #eeeaf7; border-radius: 22px; padding: 25px; box-shadow: 0 12px 35px #44316a12; max-width: 480px; margin: auto; }
.land .workflow-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 24px; }
.land .workflow-heading h3 { font-size: 19px; margin: 0; }
.land .workflow-heading p { font-size: 12px; color: #888; margin: 6px 0 0; }
.land .workflow-status { background: #eee8ff; color: #7048d7; padding: 7px 11px; border-radius: 20px; font-size: 11px; font-weight: 700; white-space: nowrap; }
.land .workflow-step { display: flex; align-items: center; gap: 15px; padding: 15px; border: 1px solid #eeeaf7; border-radius: 15px; background: #fcfbff; margin: 10px 0; }
.land .workflow-icon { min-width: 47px; width: 47px; height: 47px; display: grid; place-items: center; background: #eee8ff; border-radius: 13px; font-size: 23px; }
.land .step-2 .workflow-icon { background: #fceafa; }
.land .step-3 .workflow-icon { background: #e8f8ef; }
.land .workflow-info { flex: 1; min-width: 0; }
.land .workflow-info h4 { font-size: 14px; margin: 0 0 5px; }
.land .workflow-info p { font-size: 12px; color: #817c92; line-height: 1.5; margin: 0; }
.land .workflow-arrow { text-align: center; color: #9b80e5; font-size: 20px; line-height: 20px; margin: 2px 0; }
.land .workflow-result { background: linear-gradient(120deg, #f0eaff, #fceafa); border-radius: 13px; padding: 13px; margin-top: 18px; text-align: center; color: #6542c6; font-size: 12px; font-weight: 700; }

/* Features */
.land .section { max-width: 1120px; margin: 75px auto; padding: 0 25px; }
.land .section-heading { text-align: center; margin-bottom: 35px; }
.land .section-heading h2 { font-size: 34px; margin-bottom: 10px; }
.land .section-heading p { color: #817c92; }
.land .feature-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; }
.land .feature-card { background: white; padding: 27px; border: 1px solid #eeeaf7; border-radius: 20px; transition: .25s ease; }
.land .feature-card:hover { transform: translateY(-7px); box-shadow: 0 18px 35px #55408018; border-color: #d5c5ff; }
.land .feature-icon { width: 48px; height: 48px; display: grid; place-items: center; border-radius: 14px; background: #f0eaff; font-size: 24px; margin-bottom: 17px; }
.land .feature-card h3 { margin-bottom: 9px; }
.land .feature-card p { color: #817c92; line-height: 1.7; font-size: 14px; }
.land .feature-more { color: #7048d7; font-weight: 700; border: 0; background: none; cursor: pointer; padding: 8px 0; font-size: 14px; }
.land .feature-more:hover { color: #4f2ba8; }
.land .feature-detail { display: none; color: #625b78; font-size: 13px; line-height: 1.6; margin-top: 8px; }
.land .feature-detail.show { display: block; }

/* Call to action */
.land .cta { text-align: center; margin: 80px 20px; padding: 65px 25px; border-radius: 28px; background: linear-gradient(120deg, #6544c9, #9670e8); color: white; }
.land .cta p { color: #eee7ff; margin: 15px 0 25px; }
.land .cta .btn { background: white; color: #6544c9; }

/* FAQ */
.land .faq-item { background: white; border: 1px solid #eeeaf7; border-radius: 14px; padding: 18px 20px; margin: 12px 0; }
.land .faq-question { width: 100%; background: none; border: 0; text-align: left; font-size: 15px; font-weight: 700; cursor: pointer; color: #302846; display: flex; justify-content: space-between; gap: 12px; }
.land .faq-answer { display: none; color: #817c92; line-height: 1.7; padding-top: 13px; font-size: 14px; }
.land .faq-answer.show { display: block; }

.land footer { text-align: center; padding: 30px; color: #8b859c; }

/* Buttons */
.land .btn { display: inline-block; padding: 12px 21px; border-radius: 12px; font-weight: 700; transition: .2s ease; }
.land .btn:hover { transform: translateY(-2px); }
.land .btn.primary { background: #7048d7; color: white; box-shadow: 0 7px 18px #7048d740; }
.land .btn.secondary { border: 1px solid #ded7ee; color: #5942a1; background: white; }

/* Scroll reveal */
.land .reveal { opacity: 0; transform: translateY(25px); transition: opacity .7s ease, transform .7s ease; }
.land .reveal.visible { opacity: 1; transform: translateY(0); }

.land .btn:focus-visible, .land button:focus-visible, .land a:focus-visible { outline: 3px solid #a58ae9; outline-offset: 4px; }

@media (max-width: 750px) {
  .land .hero { grid-template-columns: 1fr; padding: 30px 22px; margin-top: 15px; }
  .land .feature-grid { grid-template-columns: 1fr; }
  .land .hero h1 { font-size: 42px; }
  .land .section-heading h2 { font-size: 27px; }
  .land nav { padding: 18px; }
  .land .hero-visual { padding: 18px; }
}

@keyframes floatDemo {
  0%, 100% { transform: translateY(0) rotate(1deg); }
  50% { transform: translateY(-9px) rotate(1deg); }
}
@media (prefers-reduced-motion: no-preference) {
  .land .hero-visual { animation: floatDemo 4s ease-in-out infinite; }
}
@media (prefers-reduced-motion: reduce) {
  .land .reveal { opacity: 1; transform: none; transition: none; }
  .land .hero-visual { animation: none; }
}
`;

/* ---------- authentication ---------- */
function authPage(mode) {
  const isSignup = mode === 'signup';
  const app = $('#app');

  injectStyle('land-css', LANDING_CSS);
  app.dataset.mode = 'landing';

  app.innerHTML = `
    <div class="land">
      <nav>
        <a class="logo" href="#/">✦ Notice2Action</a>
      </nav>

      <section class="card" style="max-width:450px;margin:50px auto">
        <h1>${isSignup ? 'Create your account' : 'Welcome back'}</h1>
        <p class="muted">
          ${isSignup ? 'Sign up to manage your personal notices and tasks.' : 'Login to access your notices and tasks.'}
        </p>

        <form id="authForm">
          ${isSignup ? `
            <label for="authName">Full name</label>
            <input id="authName" type="text" autocomplete="name" required>
          ` : ''}

          <label for="authEmail">Email address</label>
          <input id="authEmail" type="email" autocomplete="email" required>

          <label for="authPassword">Password</label>
          <input id="authPassword" type="password" minlength="8"
                 autocomplete="${isSignup ? 'new-password' : 'current-password'}" required>

          <div id="authError"></div>

          <button class="btn primary" id="authSubmit" type="submit" style="margin-top:20px;width:100%">
            ${isSignup ? 'Create account' : 'Login'}
          </button>
        </form>

        <p style="margin-top:20px">
          ${isSignup
            ? 'Already have an account? <a href="#/login">Login</a>'
            : 'New student? <a href="#/signup">Create an account</a>'}
        </p>
      </section>
    </div>
  `;

  $('#authForm').onsubmit = async (e) => {
    e.preventDefault();

    const error = $('#authError');
    const submit = $('#authSubmit');
    error.innerHTML = '';
    submit.disabled = true;

    const data = {
      email: $('#authEmail').value.trim(),
      password: $('#authPassword').value,
    };
    if (isSignup) data.name = $('#authName').value.trim();

    try {
      const result = await API.send('POST', isSignup ? '/auth/register' : '/auth/login', data);
      state.user = result.user;
      state.settings = await API.get('/settings');

      toast(isSignup ? 'Account created!' : 'Login successful!');
      location.hash = '#/dashboard';
    } catch (err) {
      error.innerHTML = errorBox(err.message);
      submit.disabled = false;
    }
  };
}

/* ---------- landing page ---------- */
function landing() {
  const app = $('#app');
  injectStyle('land-css', LANDING_CSS);
  app.dataset.mode = 'landing';

  app.innerHTML = `
    <div class="land">

      <nav>
        <a class="logo" href="#/">✦ Notice2Action</a>

        <div class="nav-links">
          <a href="#/" data-scroll="features" class="btn secondary">Features</a>
          <a href="#/login" class="btn secondary">Login</a>
          <a href="#/signup" class="btn primary">Get Started ↗</a>
        </div>
      </nav>

      <section class="hero">

        <div>
          <span class="eyebrow">✦ YOUR SMART STUDY COMPANION</span>

          <h1>
            Stop missing deadlines.<br>
            <span class="gradient-text">Start taking action.</span>
          </h1>

          <p>
            Turn college notices into organised tasks.
            Track assignments, manage deadlines and take
            control of your academic life — all in one place.
          </p>

          <div class="hero-actions">
            <a href="#/signup" class="btn primary">Get Started Free →</a>
            <a href="#/" data-scroll="features" class="btn secondary">Explore Features</a>
          </div>

          <p style="font-size:13px;margin-top:18px">
            ✨ One place for your notices, tasks and deadlines.
          </p>
        </div>

        <!-- Workflow visual -->
        <div class="hero-visual">
          <div class="workflow-card">

            <div class="workflow-heading">
              <div>
                <h3>From Notice to Action</h3>
                <p>See how Notice2Action works</p>
              </div>
              <span class="workflow-status">AI POWERED</span>
            </div>

            <div class="workflow-step step-1">
              <div class="workflow-icon">📄</div>
              <div class="workflow-info">
                <h4>01. Upload Notice</h4>
                <p>Add a PDF or paste the text of a college notice.</p>
              </div>
            </div>

            <div class="workflow-arrow">↓</div>

            <div class="workflow-step step-2">
              <div class="workflow-icon">🤖</div>
              <div class="workflow-info">
                <h4>02. AI Analysis</h4>
                <p>Important information, tasks and deadlines are identified.</p>
              </div>
            </div>

            <div class="workflow-arrow">↓</div>

            <div class="workflow-step step-3">
              <div class="workflow-icon">✓</div>
              <div class="workflow-info">
                <h4>03. Task Identification</h4>
                <p>You get a clear task list with dates, priorities and sources.</p>
              </div>
            </div>

            <div class="workflow-result">
              ✨ One notice. Clear tasks. Better planning.
            </div>

          </div>
        </div>

      </section>

      <!-- Features -->
      <section class="section" id="features">

        <div class="section-heading">
          <span class="eyebrow">MADE FOR STUDENTS</span>
          <h2>Everything you need to stay organised</h2>
          <p>Less confusion. Better planning. More productivity.</p>
        </div>

        <div class="feature-grid">

          <div class="feature-card">
            <div class="feature-icon">📄</div>
            <h3>Smart Notice Management</h3>
            <p>Keep your college notices organised in one place.</p>
            <button type="button" class="feature-more" data-feature="notice">Learn more +</button>
            <div class="feature-detail" id="detail-notice">
              Upload notices and keep important academic information easy to find.
            </div>
          </div>

          <div class="feature-card">
            <div class="feature-icon">✓</div>
            <h3>Task Tracking</h3>
            <p>Turn important academic work into manageable tasks.</p>
            <button type="button" class="feature-more" data-feature="task">Learn more +</button>
            <div class="feature-detail" id="detail-task">
              Keep track of pending and completed work so you know what needs attention.
            </div>
          </div>

          <div class="feature-card">
            <div class="feature-icon">📅</div>
            <h3>Deadline Calendar</h3>
            <p>See your upcoming deadlines and plan ahead.</p>
            <button type="button" class="feature-more" data-feature="calendar">Learn more +</button>
            <div class="feature-detail" id="detail-calendar">
              View important dates and stay aware of approaching deadlines.
            </div>
          </div>

        </div>
      </section>

      <!-- Call to action -->
      <section class="cta">
        <h2>Your academic life deserves better organisation.</h2>
        <p>Start managing your notices and tasks with Notice2Action.</p>
        <a href="#/signup" class="btn">Create Your Free Account →</a>
      </section>

      <!-- FAQ -->
      <section class="section">

        <div class="section-heading">
          <h2>Frequently asked questions</h2>
          <p>Some things you might want to know.</p>
        </div>

        <div class="faq-item">
          <button type="button" class="faq-question">What is Notice2Action?<span>＋</span></button>
          <div class="faq-answer">
            Notice2Action helps students organise college notices,
            track tasks and manage important deadlines.
          </div>
        </div>

        <div class="faq-item">
          <button type="button" class="faq-question">Do I need an account?<span>＋</span></button>
          <div class="faq-answer">
            Yes. Create a free account to access your personal
            notices, tasks and dashboard.
          </div>
        </div>

        <div class="faq-item">
          <button type="button" class="faq-question">Can I track my assignments?<span>＋</span></button>
          <div class="faq-answer">
            Yes. You can manage your tasks and monitor their
            completion from your personal dashboard.
          </div>
        </div>

      </section>

      <footer>
        <strong>✦ Notice2Action</strong>
        <p>Stay organised. Take action.</p>
        <p>
          <a href="#/login">Login</a> ·
          <a href="#/signup">Create account</a>
        </p>
      </footer>

    </div>
  `;

  // Expandable feature cards
  app.querySelectorAll('[data-feature]').forEach((button) => {
    button.addEventListener('click', () => {
      const detail = app.querySelector(`#detail-${button.dataset.feature}`);
      if (!detail) return;
      detail.classList.toggle('show');
      button.textContent = detail.classList.contains('show') ? 'Show less −' : 'Learn more +';
    });
  });

  // FAQ accordion
  app.querySelectorAll('.faq-question').forEach((button) => {
    button.addEventListener('click', () => {
      const answer = button.nextElementSibling;
      if (!answer) return;
      const isOpen = answer.classList.toggle('show');
      const indicator = button.querySelector('span');
      if (indicator) indicator.textContent = isOpen ? '−' : '＋';
    });
  });

  // Smooth scroll to the features section (does not touch the hash router)
  app.querySelectorAll('[data-scroll]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      const target = app.querySelector('#' + link.dataset.scroll);
      if (target) target.scrollIntoView({ behavior: 'smooth' });
    });
  });

  // Scroll reveal animations
  const revealElements = app.querySelectorAll('.section, .cta, .feature-card');

  if ('IntersectionObserver' in window) {
    revealElements.forEach((element) => element.classList.add('reveal'));

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });

    revealElements.forEach((element) => observer.observe(element));

    // Safety net: never leave content invisible if the observer does not fire
    setTimeout(() => revealElements.forEach((el) => el.classList.add('visible')), 2500);
  }
}

/* ---------- dashboard ---------- */
const DASH_CSS = `
.student-dash { --sp-panel: #ffffff; --sp-border: #e9e6f2; --sp-text: #25233a; --sp-muted: #77758a; color: var(--sp-text); border-radius: 20px; padding: 24px; min-height: 100%; }
.student-dash * { box-sizing: border-box; }
.sp-top { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 25px; }
.sp-greeting h1 { font-size: clamp(24px, 4vw, 34px); margin: 0 0 7px; color: var(--sp-text); font-weight: 750; letter-spacing: -.8px; }
.sp-greeting p { color: var(--sp-muted); margin: 0; font-size: 14px; }
.sp-date { background: #f5f3ff; border: 1px solid #e6e0fa; border-radius: 12px; padding: 12px 16px; color: #65549b; font-size: 13px; }
.sp-hero { position: relative; overflow: hidden; background: linear-gradient(120deg, #6655bd, #8263ca 60%, #568ac1); border-radius: 20px; padding: 25px; margin-bottom: 23px; display: grid; grid-template-columns: 1fr auto; gap: 20px; align-items: center; }
.sp-hero h2 { color: #ffffff; font-size: 22px; margin: 0 0 9px; }
.sp-hero p { color: rgba(255,255,255,.9); font-size: 14px; line-height: 1.6; margin: 0; max-width: 470px; }
.sp-hero-icon { width: 75px; height: 75px; border-radius: 22px; background: rgba(255,255,255,.2); display: grid; place-items: center; font-size: 37px; }
.sp-progress { margin-top: 19px; max-width: 430px; }
.sp-progress-head { display: flex; justify-content: space-between; color: #ffffff; font-size: 12px; margin-bottom: 8px; }
.sp-progress-track { height: 9px; background: rgba(255,255,255,.25); border-radius: 20px; overflow: hidden; }
.sp-progress-fill { height: 100%; background: #b9f4d0; border-radius: 20px; transition: width .5s ease; }
.sp-section-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 26px 0 14px; }
.sp-section-title h2 { color: var(--sp-text); font-size: 17px; margin: 0; }
.sp-section-title span { color: var(--sp-muted); font-size: 12px; }
.sp-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
.sp-stat { background: #ffffff; border: 1px solid var(--sp-border); border-radius: 16px; padding: 18px; box-shadow: 0 3px 12px rgba(45,35,80,.045); transition: transform .2s, box-shadow .2s; }
.sp-stat:hover { transform: translateY(-4px); box-shadow: 0 7px 18px rgba(45,35,80,.09); }
.sp-stat-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 14px; }
.sp-stat-icon { width: 39px; height: 39px; display: grid; place-items: center; border-radius: 12px; font-size: 19px; }
.sp-purple { background: #eee9ff; color: #7555c7; }
.sp-blue { background: #e6f1ff; color: #4385c9; }
.sp-green { background: #e3f7ec; color: #269765; }
.sp-red { background: #ffebef; color: #d85c79; }
.sp-orange { background: #fff0df; color: #d98736; }
.sp-yellow { background: #fff8dc; color: #b39127; }
.sp-stat-number { color: var(--sp-text); font-size: 27px; font-weight: 750; }
.sp-stat-label { color: var(--sp-muted); font-size: 13px; }
.sp-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: start; }
.sp-panel { background: #ffffff; border: 1px solid var(--sp-border); border-radius: 17px; padding: 19px; min-width: 0; box-shadow: 0 3px 12px rgba(45,35,80,.04); }
.sp-panel h3 { color: var(--sp-text); font-size: 15px; margin: 0 0 15px; }
.sp-alert { display: flex; gap: 12px; align-items: flex-start; padding: 13px 15px; border-radius: 13px; margin-bottom: 10px; background: #fff0f2; border: 1px solid #f8d8df; color: #a83f58; font-size: 13px; line-height: 1.6; }
.sp-alert.busy { background: #fff6e9; border-color: #f5e3c4; color: #946323; }
.sp-task-area .task { border-bottom: 1px solid var(--sp-border); padding: 12px 0; color: var(--sp-text); }
.sp-task-area .task:last-child { border-bottom: 0; }
.sp-task-area .task-main, .sp-notices .task-main, .sp-task-area .t-title, .sp-notices .t-title { color: var(--sp-text); }
.sp-notices .task { border-bottom: 1px solid var(--sp-border); padding: 12px 0; color: var(--sp-text); }
.sp-notices .task:last-child { border-bottom: 0; }
.sp-notices .meta { margin-top: 7px; }
.sp-notices .actions { display: flex; gap: 7px; flex-wrap: wrap; }
.sp-notices .btn { border-radius: 8px; }
.sp-notices .btn.small { font-size: 12px; }
.sp-notices .btn.danger { color: #d94b62; }
.sp-notice-empty { text-align: center; padding: 25px 12px; color: var(--sp-muted); }
.sp-notice-empty div { font-size: 30px; margin-bottom: 8px; }
.student-dash .card { background: #ffffff; color: var(--sp-text); border-color: var(--sp-border); }
@media (max-width: 760px) {
  .student-dash { padding: 15px; }
  .sp-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .sp-grid { grid-template-columns: 1fr; }
  .sp-hero { padding: 20px; }
}
@media (max-width: 430px) {
  .sp-hero-icon { display: none; }
  .sp-stat { padding: 14px; }
  .sp-stat-number { font-size: 23px; }
  .sp-date { width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  .sp-stat, .sp-progress-fill { transition: none; }
}
`;

async function dashboard(view) {
  const [d, notices] = await Promise.all([API.get('/dashboard'), API.get('/notices')]);

  const urgent = d.urgent || [];
  const upcoming = d.upcoming || [];
  const overdue = d.overdue || [];
  const conflicts = d.conflicts || [];
  const allNotices = notices || [];
  cache(urgent); cache(upcoming);

  const name = state.settings.student_name;
  const clashes = conflicts.filter((c) => c.level === 'conflict').length;

  const pending = Number(d.pending) || 0;
  const completed = Number(d.completed) || 0;
  const totalTasks = pending + completed;
  const progress = totalTasks ? Math.round((completed / totalTasks) * 100) : 0;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const today = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  const stat = (ico, number, label, color) => `
    <div class="sp-stat">
      <div class="sp-stat-top">
        <span class="sp-stat-icon ${color}">${ico}</span>
        <span class="sp-stat-number">${number}</span>
      </div>
      <div class="sp-stat-label">${label}</div>
    </div>`;

  injectStyle('dash-css', DASH_CSS);

  view.innerHTML = `
    <div class="student-dash">

      <div class="sp-top">
        <div class="sp-greeting">
          <h1>${greeting}${name ? ', ' + esc(name) : ''} 👋</h1>
          <p>Your personal academic planner. Let's make today productive!</p>
        </div>
        <div class="sp-date">📅 ${today}</div>
      </div>

      <section class="sp-hero">
        <div>
          <h2>🎓 Your study journey</h2>
          <p>
            Every completed task brings you one step closer to your goals.
            Keep track of your academic progress here.
          </p>
          <div class="sp-progress">
            <div class="sp-progress-head">
              <span>Task completion</span>
              <strong>${progress}%</strong>
            </div>
            <div class="sp-progress-track">
              <div class="sp-progress-fill" style="width:${progress}%"></div>
            </div>
          </div>
        </div>
        <div class="sp-hero-icon">📚</div>
      </section>

      <div class="sp-section-title">
        <h2>Your academic overview</h2>
        <span>Live dashboard statistics</span>
      </div>

      <div class="sp-stats">
        ${stat('📩', d.total_notices || 0, 'Notices processed', 'sp-purple')}
        ${stat('📝', pending, 'Pending tasks', 'sp-blue')}
        ${stat('✅', completed, 'Completed tasks', 'sp-green')}
        ${stat('🔥', urgent.length, 'Urgent tasks', 'sp-red')}
        ${stat('📅', upcoming.length, 'Due in 7 days', 'sp-orange')}
        ${stat('⚠️', clashes, 'Deadline clashes', 'sp-yellow')}
      </div>

      ${overdue.length ? `
        <div class="sp-section-title"><h2>⚠️ Needs your attention</h2></div>
        <div class="sp-alert">
          <span>🚨</span>
          <div>
            <strong>${overdue.length} overdue task${overdue.length === 1 ? '' : 's'}</strong><br>
            Check My Tasks to complete or reschedule them.
          </div>
        </div>
      ` : ''}

      ${conflicts.length ? `
        <div class="sp-section-title"><h2>Deadline reminders</h2></div>
        ${conflicts.map((c) => `
          <div class="sp-alert ${c.level === 'conflict' ? '' : 'busy'}">
            <span>${c.level === 'conflict' ? '⚠️' : '📌'}</span>
            <div>
              <strong>${c.level === 'conflict' ? 'Possible clash' : 'Busy day'} on ${fmtDate(c.date)}</strong><br>
              ${esc(c.message)}
            </div>
          </div>
        `).join('')}
      ` : ''}

      <div class="sp-section-title">
        <h2>📌 Your study planner</h2>
        <span>Stay ahead of your deadlines</span>
      </div>

      <div class="sp-grid">
        <section class="sp-panel sp-task-area">
          <h3>🔥 Urgent tasks</h3>
          ${taskList(urgent, true, 'Nothing urgent right now. Great work!')}
        </section>

        <section class="sp-panel sp-task-area">
          <h3>🗓️ Upcoming deadlines</h3>
          ${taskList(upcoming, true, 'No deadlines this week.')}
        </section>
      </div>

      <div class="sp-section-title">
        <h2>📂 Recently added notices</h2>
        <span>${allNotices.length} total</span>
      </div>

      <section class="sp-panel sp-notices">
        ${allNotices.length
          ? allNotices.slice(0, 6).map((n) => `
              <div class="task" style="align-items:center">
                <div class="task-main" style="cursor:default">
                  <div class="t-title">${esc(n.title)}</div>
                  <div class="meta">
                    <span class="badge">${n.source_type === 'pdf' ? 'PDF' : 'Pasted text'}</span>
                    <span class="badge">${n.task_count} task${n.task_count === 1 ? '' : 's'}</span>
                    <span class="badge ${n.method === 'ai' ? 'purple' : ''}">${n.method === 'ai' ? 'AI analysis' : 'Rule-based'}</span>
                  </div>
                </div>
                <div class="actions">
                  <a class="btn small" href="#/notice/${esc(n.id)}">View</a>
                  <button class="btn small danger" data-act="delnotice" data-nid="${esc(n.id)}">Delete</button>
                </div>
              </div>
            `).join('')
          : `
            <div class="sp-notice-empty">
              <div>📭</div>
              <strong>No notices yet</strong>
              <p>Upload a college notice to create your first action plan.</p>
              <a class="btn primary" href="#/upload">Upload a notice</a>
            </div>
          `}
      </section>

    </div>
  `;
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
    $('#pane-pdf').hidden = b.dataset.tab !== 'pdf';
    $('#pane-text').hidden = b.dataset.tab !== 'text';
  });

  $('#go').onclick = async () => {
    const isPdf = !$('#pane-pdf').hidden, title = $('#title').value.trim(), status = $('#status'), btn = $('#go');
    if (isPdf && !pickedFile) return toast('Choose a PDF first.', true);
    if (!isPdf && $('#paste').value.trim().length < 20) return toast('Paste at least a few sentences.', true);
    btn.disabled = true;
    status.innerHTML = '<div class="progress"><div id="bar"></div></div><div class="muted small" id="stxt">Uploading…</div>';
    try {
      const bar = $('#bar'), stxt = $('#stxt');
      let data;
      if (isPdf) {
        data = await API.uploadPdf(pickedFile, title, (p) => {
          bar.style.width = Math.round(p * 100) + '%';
          if (p >= 1) stxt.textContent = 'Reading the PDF and finding tasks…';
        });
      } else {
        bar.style.width = '100%';
        stxt.textContent = 'Finding tasks…';
        data = await API.analyseText($('#paste').value, title);
      }
      state.warning = data.ai_warning;
      toast(`Found ${data.tasks.length} task${data.tasks.length === 1 ? '' : 's'}`);
      location.hash = '#/notice/' + data.notice.id;
    } catch (e) { status.innerHTML = errorBox(e.message); btn.disabled = false; }
  };
}

/* ---------- results (jumps to the newest notice) ---------- */
async function results(view) {
  const notices = await API.get('/notices');
  if (!notices.length) {
    view.innerHTML = head('Analysis results') + empty('Nothing analysed yet', 'Your results will appear here after you add a notice.', '<a class="btn primary" href="#/upload">Add a notice</a>');
    return;
  }
  location.replace('#/notice/' + notices[0].id);
}

/* ---------- single notice ---------- */
async function notice(view, id) {
  const [data, notices] = await Promise.all([API.get('/notices/' + id), API.get('/notices')]);

  const n = data.notice;
  cache(data.tasks);
  state.texts[n.id] = n.raw_text;

  const ai = n.method === 'ai';
  const warning = state.warning;
  state.warning = null;

  view.innerHTML = head(
    esc(n.title),
    `${n.source_type === 'pdf'
      ? `PDF, ${n.page_count} page${n.page_count === 1 ? '' : 's'}, ${fmtSize(n.file_size)}`
      : 'Pasted text'} - ${ai ? 'analysed with AI' : 'analysed with rule-based extraction'}`
  ) + `
    <div class="row" style="margin-bottom:16px">
      <label for="pick" style="margin:0">Notice</label>
      <select id="pick" style="max-width:340px">
        ${notices.map((x) => `<option value="${esc(x.id)}" ${x.id === n.id ? 'selected' : ''}>${esc(x.title)}</option>`).join('')}
      </select>
    </div>

    ${warning ? `<div class="alert"><div>${esc(warning)}</div></div>` : ''}

    ${ai ? '' : `
      <div class="alert info"><div>
        Rule-based extraction finds dates and action words.
        Check each task against its source sentence before relying on it.
      </div></div>`}

    ${n.summary ? `
      <section class="card">
        <h2>${ai ? 'Summary' : 'Opening lines of the notice'}</h2>
        <p style="margin:0">${esc(n.summary)}</p>
      </section>` : ''}

    ${(data.conflicts || []).map((c) => `
      <div class="alert ${c.level === 'conflict' ? 'conflict' : ''}">
        <div>
          <b>${c.level === 'conflict' ? 'Possible clash' : 'Busy day'} on ${fmtDate(c.date)}</b><br>
          ${esc(c.message)}
        </div>
      </div>`).join('')}

    <section class="card">
      <h2>Tasks found (${data.tasks.length})</h2>
      ${data.tasks.length
        ? taskList(data.tasks, false, '')
        : '<p class="muted">No tasks with action words or deadlines were found. Read the original text below to check.</p>'}
    </section>

    <section class="card">
      <h2>Explain in simple language</h2>
      <div class="row">
        <select id="lang" style="max-width:200px">
          <option value="english">English</option>
          <option value="hindi">Hindi</option>
          <option value="punjabi">Punjabi</option>
        </select>
        <button class="btn primary" id="simplify">Explain simply</button>
      </div>
      ${state.status && state.status.ai_available ? '' : '<p class="muted small">This feature needs a Gemini API key. See Settings.</p>'}
      <div id="simple"></div>
    </section>

    <section class="card">
      <details>
        <summary>Original notice text</summary>
        <pre>${esc(n.raw_text)}</pre>
      </details>
    </section>

    <div class="row">
      <button class="btn danger" data-act="delnotice" data-nid="${esc(n.id)}">Delete this notice</button>
    </div>
  `;

  $('#lang').value = state.settings.language;
  $('#pick').onchange = (e) => { location.hash = '#/notice/' + e.target.value; };

  $('#simplify').onclick = async () => {
    const out = $('#simple'), btn = $('#simplify');
    btn.disabled = true;
    out.innerHTML = loading();
    try {
      const r = await API.send('POST', `/notices/${n.id}/simplify`, { language: $('#lang').value });
      out.innerHTML = `<div class="simple-out">${esc(r.explanation)}</div><p class="muted small">AI-written explanation. Check dates against the original notice.</p>`;
    } catch (e) {
      out.innerHTML = errorBox(e.message);
    }
    btn.disabled = false;
  };
}

/* ---------- tasks ---------- */
async function tasks(view) {
  const f = state.filters, qs = new URLSearchParams({ sort: f.sort });
  if (f.priority) qs.set('priority', f.priority);
  if (f.status) qs.set('status', f.status);
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
      <span class="n">${d}</span>${items.slice(0, 2).map((t) => `<span class="chip p-${esc(t.priority)} ${t.status === 'completed' ? 'done' : ''}">${esc(t.title)}</span>`).join('')}
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
  const s = state.settings;
  view.innerHTML = head('Settings', 'Personalise your experience.') + `
    <section class="card">
      <form id="setform">
        <label for="s-name">Your name</label>
        <input id="s-name" type="text" value="${esc(s.student_name)}" maxlength="60">

        <label for="s-lang">Preferred language</label>
        <select id="s-lang">
          ${['english', 'hindi', 'punjabi'].map((l) =>
            `<option value="${l}" ${s.language === l ? 'selected' : ''}>${l[0].toUpperCase() + l.slice(1)}</option>`).join('')}
        </select>

        <label for="s-rem">Remind me this many days before a deadline</label>
        <input id="s-rem" type="number" min="1" max="14" value="${esc(s.reminder_days)}">

        <div class="row" style="margin-top:18px">
          <button class="btn primary" type="submit">Save settings</button>
        </div>
      </form>
    </section>`;

  $('#setform').onsubmit = async (e) => {
    e.preventDefault();
    try {
      // Change 'PUT' if your Flask /settings route expects POST or PATCH.
      state.settings = await API.send('PUT', '/settings', {
        student_name: $('#s-name').value.trim(),
        language: $('#s-lang').value,
        reminder_days: $('#s-rem').value,
      });
      toast('Settings saved');
    } catch (err) { toast(err.message, true); }
  };
}

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
    <div class="meta" style="margin:12px 0 18px"><span class="badge">${t.deadline ? esc(fmtDate(t.deadline)) + (t.deadline_time ? ', ' + esc(fmtTime(t.deadline_time)) : '') : 'No date found'}</span>
    ${t.deadline && !t.date_certain ? '<span class="badge warn">Date uncertain</span>' : ''}<span class="badge ${esc(t.priority)}">${esc(t.priority)}</span></div>
    ${t.description ? `<p class="muted">${esc(t.description)}</p>` : ''}${body}
    <p style="margin-top:20px"><a href="#/notice/${esc(t.notice_id)}">Open full notice analysis</a></p>`;
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
      case 'toggle': {
        const t = state.tasks.get(id); const done = t.status !== 'completed';
        await API.send('PATCH', '/tasks/' + id, { status: done ? 'completed' : 'pending' });
        toast(done ? 'Marked as completed' : 'Marked as pending'); refresh(); break;
      }
      case 'source': openSource(id); break;
      case 'edit': openEdit(id); break;
      case 'delete':
        if (confirm('Delete this task? This cannot be undone.')) {
          await API.send('DELETE', '/tasks/' + id); toast('Task deleted'); refresh();
        }
        break;
      case 'delnotice':
        if (confirm('Delete this notice and all its tasks?')) {
          await API.send('DELETE', '/notices/' + el.dataset.nid);
          toast('Notice deleted');
          if (location.hash.startsWith('#/notice/')) location.hash = '#/dashboard';
          else refresh();
        }
        break;
      case 'month': state.cal = new Date(state.cal.getFullYear(), state.cal.getMonth() + (+el.dataset.dir), 1); state.selDay = null; refresh(); break;
      case 'day': state.selDay = el.dataset.date; refresh(); break;
      case 'nav': document.body.classList.toggle('nav-open'); break;
      case 'close': closeDrawer(); break;
      case 'logout':
        await API.send('POST', '/auth/logout');   // needs a matching Flask route
        state.user = null;
        state.tasks.clear();
        state.texts = {};
        $('#app').dataset.mode = '';
        location.hash = '#/login';
        break;
    }
  } catch (err) { toast(err.message, true); }
});

document.addEventListener('change', (e) => { const k = e.target.dataset.filter; if (k) { state.filters[k] = e.target.value; refresh(); } });
$('#scrim').onclick = closeDrawer;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

/* ---------- application startup ---------- */
(async function init() {
  // Check backend status
  try {
    state.status = await API.get('/status');
  } catch (error) {
    console.error('Backend connection failed:', error);
  }

  // Check whether the student is already logged in
  try {
    const result = await API.get('/auth/me');
    state.user = result.user;
    state.settings = await API.get('/settings');
  } catch (error) {
    state.user = null;
  }

  window.addEventListener('hashchange', route);
  route();
})();