import { firebaseConfig } from './config.js';

// "?local" in the address runs the offline preview store (handy for trying designs).
const store = firebaseConfig && !new URLSearchParams(location.search).has('local')
  ? await import('./store-firebase.js')
  : await import('./store-local.js');

const $app = document.getElementById('app');
const $toast = document.getElementById('toast');

let user = null;
let cleanups = [];
let lastCreatedCode = null;

/* ---------- small helpers ---------- */

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Turn Kurdish/Arabic digits (٠-٩, ۰-۹) into 0-9 so either keyboard works.
const latinDigits = s => String(s)
  .replace(/[٠-٩]/g, d => d.charCodeAt(0) - 0x0660)
  .replace(/[۰-۹]/g, d => d.charCodeAt(0) - 0x06F0)
  .replace(/٫/g, '.').replace(/[٬,\s]/g, '');

function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => $toast.classList.remove('show'), 2800);
}

function clearWatchers() { cleanups.forEach(fn => fn && fn()); cleanups = []; }

function num(n, currency) {
  const digits = currency === 'IQD' ? 0 : 2;
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function money(n, currency) {
  return currency === 'USD' ? `$${num(n, currency)}` : `${num(n, currency)} دینار`;
}
const curName = c => c === 'USD' ? 'دۆلار' : 'دینار';

const MONTHS = ['کانوونی دووەم', 'شوبات', 'ئازار', 'نیسان', 'ئایار', 'حوزەیران', 'تەممووز', 'ئاب', 'ئەیلوول', 'تشرینی یەکەم', 'تشرینی دووەم', 'کانوونی یەکەم'];
const DAYS = ['یەکشەممە', 'دووشەممە', 'سێشەممە', 'چوارشەممە', 'پێنجشەممە', 'هەینی', 'شەممە'];

// Weeks run Saturday to Friday.
function weekStart(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 1) % 7));
  return d;
}
const keyOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function fromKey(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }
function shiftWeek(k, n) { const d = fromKey(k); d.setDate(d.getDate() + 7 * n); return keyOf(d); }
const thisWeek = () => keyOf(weekStart(new Date()));
function weekLabel(k) {
  const a = fromKey(k), b = fromKey(k); b.setDate(b.getDate() + 6);
  if (a.getMonth() === b.getMonth()) return `${a.getDate()} – ${b.getDate()}ی ${MONTHS[b.getMonth()]}`;
  return `${a.getDate()}ی ${MONTHS[a.getMonth()]} – ${b.getDate()}ی ${MONTHS[b.getMonth()]}`;
}
function stamp(ms) {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]} ${d.getDate()}ی ${MONTHS[d.getMonth()]}، ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* ---------- the reckoning: who pays whom ---------- */

function reckon(expenses, group) {
  const scale = group.currency === 'IQD' ? 1 : 100;
  const people = {};
  const ensure = (uid, name) => (people[uid] ||= { uid, name: name || group.memberNames?.[uid] || 'ئەندامی پێشوو', paid: 0, share: 0 });
  (group.memberIds || []).forEach(uid => ensure(uid));

  for (const e of expenses) {
    if (!e.participants.length) continue;
    ensure(e.paidBy, e.paidByName).paid += e.amount;
    const each = e.amount / e.participants.length;
    e.participants.forEach(uid => { ensure(uid).share += each; });
  }

  const rows = Object.values(people).map(p => ({ ...p, net: p.paid - p.share }));
  const creditors = rows.filter(r => r.net > 0.5 / scale).map(r => ({ ...r, left: Math.round(r.net * scale) }));
  const debtors = rows.filter(r => r.net < -0.5 / scale).map(r => ({ ...r, left: Math.round(-r.net * scale) }));
  creditors.sort((a, b) => b.left - a.left);
  debtors.sort((a, b) => b.left - a.left);

  const transfers = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amt = Math.min(debtors[i].left, creditors[j].left);
    if (amt > 0) transfers.push({ from: debtors[i], to: creditors[j], amount: amt / scale });
    debtors[i].left -= amt; creditors[j].left -= amt;
    if (debtors[i].left <= 0) i++;
    if (creditors[j].left <= 0) j++;
  }
  return { rows: rows.sort((a, b) => a.name.localeCompare(b.name)), transfers };
}

/* ---------- layout pieces ---------- */

function masthead(sub) {
  return `
    <header class="masthead">
      <h1 class="title"><a href="#/">دەفتەری ماڵ</a></h1>
      <p class="subtitle">${sub}</p>
    </header>`;
}

function previewNote() {
  return store.mode === 'local'
    ? `<p class="preview-note">وەشانی تاقیکردنەوە · زانیارییەکان تەنها لەسەر ئەم ئامێرە دەمێننەوە</p>`
    : '';
}

/* ---------- screens ---------- */

function renderAuth(tab = 'in') {
  $app.innerHTML = `
    ${masthead('خەرجییە هاوبەشەکان، بە یەکسانی دابەشکراو')}
    <section class="card">
      <div class="tabs" role="tablist">
        <button class="tab ${tab === 'in' ? 'on' : ''}" data-tab="in">چوونەژوورەوە</button>
        <button class="tab ${tab === 'up' ? 'on' : ''}" data-tab="up">هەژماری نوێ</button>
      </div>
      <form id="authForm" class="form" autocomplete="on">
        ${tab === 'up' ? `
        <label>ناوت
          <input name="name" required maxlength="30" autocomplete="name" placeholder="ئەو ناوەی هاوڕێکانت پێی دەتناسن">
        </label>` : ''}
        <label>ناوی بەکارهێنەر
          <input name="username" dir="ltr" required minlength="3" maxlength="20" pattern="[A-Za-z0-9_.]+"
            title="تەنها پیتی ئینگلیزی و ژمارە"
            autocapitalize="none" autocomplete="username" placeholder="username">
        </label>
        <label>وشەی نهێنی
          <input name="password" dir="ltr" type="password" required minlength="6"
            autocomplete="${tab === 'up' ? 'new-password' : 'current-password'}" placeholder="••••••">
        </label>
        <p class="error" id="authErr"></p>
        <button class="btn primary" type="submit">${tab === 'up' ? 'دروستکردنی هەژمار' : 'چوونەژوورەوە'}</button>
      </form>
      <p class="fine">${tab === 'up'
        ? 'ناوی بەکارهێنەر تەنها بە پیتی ئینگلیزی و ژمارە بێت. وشەی نهێنی لانیکەم 6 پیت. ئەم مۆبایلە بیرت دەمێنێت، جاری داهاتوو ڕاستەوخۆ دەچیتە ناو گرووپەکانت.'
        : 'یەکەم جارتە؟ «هەژماری نوێ» هەڵبژێرە.'}</p>
    </section>
    ${previewNote()}`;

  $app.querySelectorAll('.tab').forEach(b => b.onclick = () => renderAuth(b.dataset.tab));
  const form = document.getElementById('authForm');
  form.onsubmit = async ev => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      if (tab === 'up') await store.signUp({ name: f.name.trim(), username: f.username.trim(), password: f.password });
      else await store.signIn({ username: f.username.trim(), password: f.password });
    } catch (e) {
      document.getElementById('authErr').textContent = e.message;
      btn.disabled = false;
    }
  };
}

function renderHome() {
  $app.innerHTML = `
    ${masthead(`بەخێربێیت، ${esc(user.name)}`)}
    <section class="card">
      <h2 class="section-title">گرووپەکانت</h2>
      <ul class="group-list" id="myGroups"><li class="muted">چاوەڕێ بکە…</li></ul>
    </section>
    <div class="actions">
      <a class="btn primary" href="#/new">دروستکردنی گرووپی نوێ</a>
      <a class="btn" href="#/find">گەڕان بۆ گرووپ</a>
    </div>
    <p class="signout"><button class="link" id="signOut">چوونەدەرەوە (${esc(user.username)})</button></p>
    ${previewNote()}`;

  document.getElementById('signOut').onclick = () => store.signOut();
  cleanups.push(store.watchMyGroups(groups => {
    const ul = document.getElementById('myGroups');
    if (!ul) return;
    ul.innerHTML = groups.length ? groups.map(g => `
      <li><a href="#/g/${g.id}">
        <span class="g-name">${esc(g.name)}</span>
        <span class="g-meta">${g.memberIds.length} لە ${g.size} ئەندام${g.ownerId === user.uid ? ' · دامەزرێنەر' : ''}</span>
      </a></li>`).join('')
      : `<li class="muted">هێشتا لە هیچ گرووپێکدا نیت. گرووپێک دروست بکە، یان گرووپی هاوڕێکانت بدۆزەرەوە و بە کۆدەکەی بچۆ ناوی.</li>`;
  }));
}

function renderNew() {
  $app.innerHTML = `
    ${masthead('گرووپی نوێ')}
    <section class="card">
      <form id="newForm" class="form">
        <label>ناوی گرووپ
          <input name="name" required maxlength="40" placeholder="بۆ نموونە: ماڵی خوێندکاران">
        </label>
        <label>ژمارەی ئەندامان
          <select name="size">
            ${Array.from({ length: 19 }, (_, i) => i + 2).map(n => `<option ${n === 4 ? 'selected' : ''}>${n}</option>`).join('')}
          </select>
        </label>
        <label>دراو
          <select name="currency">
            <option value="IQD">دیناری عێراقی (IQD)</option>
            <option value="USD">دۆلاری ئەمریکی (USD)</option>
          </select>
        </label>
        <p class="error" id="newErr"></p>
        <button class="btn primary" type="submit">دروستکردنی گرووپ</button>
      </form>
      <p class="fine">کۆدێکی 6 ژمارەیی بۆ گرووپەکە دروست دەبێت. تەنها بیدە بە ئەندامەکانت.</p>
    </section>
    <p class="back"><a href="#/">گەڕانەوە بۆ گرووپەکانت</a></p>`;

  const form = document.getElementById('newForm');
  form.onsubmit = async ev => {
    ev.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const { id, code } = await store.createGroup({ name: f.name.trim(), size: Number(f.size), currency: f.currency });
      lastCreatedCode = { id, code };
      location.hash = `#/g/${id}/members`;
    } catch (e) {
      document.getElementById('newErr').textContent = e.message;
      btn.disabled = false;
    }
  };
}

function renderFind() {
  $app.innerHTML = `
    ${masthead('گەڕان بۆ گرووپ')}
    <section class="card">
      <form id="findForm" class="search">
        <input name="q" type="search" placeholder="ناوی گرووپ بنووسە" autocomplete="off">
        <button class="btn" type="submit">گەڕان</button>
      </form>
      <ul class="group-list" id="results"></ul>
    </section>
    <p class="back"><a href="#/">گەڕانەوە بۆ گرووپەکانت</a></p>
    <dialog id="codeDlg" class="dialog">
      <form method="dialog" id="codeForm" class="form">
        <h3 id="dlgTitle" class="section-title"></h3>
        <p class="fine" style="margin:0">کۆدە 6 ژمارەییەکەی گرووپ لە دامەزرێنەرەکەی وەربگرە.</p>
        <input id="codeInput" class="code-input" inputmode="numeric" maxlength="6"
          autocomplete="one-time-code" placeholder="------" required>
        <p class="error" id="codeErr"></p>
        <div class="row">
          <button class="btn" type="button" id="dlgCancel">پاشگەزبوونەوە</button>
          <button class="btn primary" type="submit" id="dlgJoin">چوونە ناو گرووپ</button>
        </div>
      </form>
    </dialog>`;

  const form = document.getElementById('findForm');
  const results = document.getElementById('results');
  const dlg = document.getElementById('codeDlg');
  let target = null;

  async function run() {
    results.innerHTML = `<li class="muted">دەگەڕێم…</li>`;
    try {
      const list = await store.searchGroups(form.q.value);
      results.innerHTML = list.length ? list.map(g => {
        const mine = g.memberIds.includes(user.uid);
        const full = g.memberIds.length >= g.size;
        return `<li><button class="row-btn" data-id="${g.id}" data-name="${esc(g.name)}" data-mine="${mine}" ${full && !mine ? 'disabled' : ''}>
          <span class="g-name">${esc(g.name)}</span>
          <span class="g-meta">دامەزرێنەر: ${esc(g.ownerName)} · ${g.memberIds.length} لە ${g.size}${mine ? ' · تۆ ئەندامیت' : full ? ' · پڕە' : ''}</span>
        </button></li>`;
      }).join('') : `<li class="muted">هیچ گرووپێک بەم ناوە نییە.</li>`;
    } catch (e) { results.innerHTML = `<li class="error">${esc(e.message)}</li>`; }
  }
  form.onsubmit = ev => { ev.preventDefault(); run(); };
  let t; form.q.oninput = () => { clearTimeout(t); t = setTimeout(run, 300); };
  run();

  results.onclick = ev => {
    const b = ev.target.closest('.row-btn');
    if (!b) return;
    if (b.dataset.mine === 'true') { location.hash = `#/g/${b.dataset.id}`; return; }
    target = b.dataset.id;
    document.getElementById('dlgTitle').textContent = b.dataset.name;
    document.getElementById('codeErr').textContent = '';
    document.getElementById('codeInput').value = '';
    dlg.showModal();
    document.getElementById('codeInput').focus();
  };
  document.getElementById('dlgCancel').onclick = () => dlg.close();
  document.getElementById('codeForm').onsubmit = async ev => {
    ev.preventDefault();
    const code = latinDigits(document.getElementById('codeInput').value);
    if (!/^\d{6}$/.test(code)) { document.getElementById('codeErr').textContent = 'کۆدەکە دەبێت 6 ژمارە بێت.'; return; }
    const btn = document.getElementById('dlgJoin');
    btn.disabled = true;
    try {
      await store.joinGroup(target, code);
      dlg.close();
      toast('بەخێربێیت بۆ گرووپەکە.');
      location.hash = `#/g/${target}`;
    } catch (e) {
      document.getElementById('codeErr').textContent = e.message;
    } finally { btn.disabled = false; }
  };
}

function renderBoard(gid, tab = 'entries', week = thisWeek()) {
  const state = { group: null, expenses: [], weekDoc: { paid: {} } };

  $app.innerHTML = `
    <header class="board-head">
      <a href="#/" class="back-mini">→ گرووپەکان</a>
      <h1 class="board-title" id="gName">&nbsp;</h1>
      <p class="board-sub" id="gSub">&nbsp;</p>
    </header>
    <nav class="week-nav">
      <a href="#/g/${gid}/${tab}/${shiftWeek(week, -1)}" aria-label="هەفتەی پێشوو">›</a>
      <span><small>هەفتەی</small>${weekLabel(week)}</span>
      ${week < thisWeek() ? `<a href="#/g/${gid}/${tab}/${shiftWeek(week, 1)}" aria-label="هەفتەی دواتر">‹</a>` : '<i>‹</i>'}
    </nav>
    <div class="tabs board-tabs">
      <a class="tab ${tab === 'entries' ? 'on' : ''}" href="#/g/${gid}/entries/${week}">تۆمارەکان</a>
      <a class="tab ${tab === 'reckoning' ? 'on' : ''}" href="#/g/${gid}/reckoning/${week}">حیساب</a>
      <a class="tab ${tab === 'members' ? 'on' : ''}" href="#/g/${gid}/members/${week}">ئەندامان</a>
    </div>
    <main id="pane"></main>`;

  const pane = document.getElementById('pane');

  function draw() {
    const g = state.group;
    if (!g) return;
    if (!g.memberIds.includes(user.uid)) {
      pane.innerHTML = `<section class="card"><p>تۆ ئەندامی ئەم گرووپە نیت. <a href="#/find">بیدۆزەرەوە و بە کۆدەکە بچۆ ناوی.</a></p></section>`;
      return;
    }
    document.getElementById('gName').textContent = g.name;
    document.getElementById('gSub').textContent = `${g.memberIds.length} لە ${g.size} ئەندام · ${curName(g.currency)}`;
    if (tab === 'entries') drawEntries(g);
    else if (tab === 'reckoning') drawReckoning(g);
    else drawMembers(g);
  }

  function drawEntries(g) {
    const total = state.expenses.reduce((s, e) => s + e.amount, 0);
    const isCurrent = week === thisWeek();
    const ledgerHTML = `
        <h2 class="section-title">تۆمارەکانی ئەم هەفتەیە</h2>
        ${state.expenses.length ? `<ol class="entries">${state.expenses.map(e => entryHTML(e, g)).join('')}</ol>
          <div class="total"><span>کۆی خەرجی هەفتە</span><span class="amt">${money(total, g.currency)}</span></div>`
        : `<p class="muted center">هێشتا هیچ شتێک تۆمار نەکراوە.</p>`}`;
    const ledger = document.getElementById('ledger');
    if (ledger) { ledger.innerHTML = ledgerHTML; bindEntryButtons(); return; }

    pane.innerHTML = `
      ${isCurrent ? `
      <section class="card">
        <h2 class="section-title">تۆمارێکی نوێ</h2>
        <form id="addForm" class="form">
          <label>چیت کڕیوە
            <input name="item" required maxlength="80" placeholder="بۆ نموونە: نان و برنج و چا">
          </label>
          <label>چەندت داوە (${curName(g.currency)})
            <input name="amount" required inputmode="decimal" placeholder="0">
          </label>
          <label class="check"><input type="checkbox" name="me" checked> منیش بەشدارم تێیدا</label>
          <button class="btn primary" type="submit">زیادکردن</button>
        </form>
      </section>` : `<p class="fine center">ئەم هەفتەیە تەواو بووە. تۆماری نوێ دەچێتە سەر هەفتەی ئێستا.</p>`}
      <section class="card ledger" id="ledger">${ledgerHTML}</section>`;

    const form = document.getElementById('addForm');
    if (form) form.onsubmit = async ev => {
      ev.preventDefault();
      const amount = Number(latinDigits(form.amount.value));
      if (!(amount > 0)) { toast('تکایە بڕەکە بە ژمارە بنووسە.'); return; }
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await store.addExpense(gid, { item: form.item.value.trim(), amount, includeMe: form.me.checked, weekKey: week });
        form.reset(); form.me.checked = true;
        toast('زیادکرا. ئێستا ئەوانی تر دەتوانن بڵێن بەشدارن یان نا.');
      } catch (e) { toast(e.message); }
      btn.disabled = false;
    };
    bindEntryButtons();
  }

  function bindEntryButtons() {
    pane.querySelectorAll('[data-join]').forEach(b => b.onclick = async () => {
      b.disabled = true;
      try { await store.setParticipation(gid, b.dataset.id, b.dataset.join === '1'); }
      catch (e) { toast(e.message); b.disabled = false; }
    });
    pane.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!confirm('ئەم تۆمارە بسڕدرێتەوە؟')) return;
      try { await store.deleteExpense(gid, b.dataset.del); } catch (e) { toast(e.message); }
    });
  }

  function entryHTML(e, g) {
    const n = e.participants.length;
    const iAmIn = e.participants.includes(user.uid);
    const names = e.participants.map(u => u === user.uid ? 'تۆ' : (g.memberNames[u] || 'ئەندامی پێشوو'));
    const payer = e.paidBy === user.uid ? 'تۆ' : esc(e.paidByName);
    return `
      <li class="entry">
        <div class="entry-top">
          <span class="item">${esc(e.item)}</span>
          <span class="amt">${money(e.amount, g.currency)}</span>
        </div>
        <div class="entry-meta">${payer} پارەی داوە · ${stamp(e.createdAt)}</div>
        <div class="entry-share">
          ${n ? `بەشداربووان: ${names.map(esc).join('، ')} — هەر کەسە <b class="amt">${money(e.amount / n, g.currency)}</b>`
              : `هێشتا کەس بەشدار نییە.`}
        </div>
        <div class="entry-actions">
          ${iAmIn
            ? `<button class="btn small" data-join="0" data-id="${e.id}">دەرمبهێنە</button>`
            : `<button class="btn small primary" data-join="1" data-id="${e.id}">منیش بەشدارم</button>`}
          ${e.paidBy === user.uid ? `<button class="link danger" data-del="${e.id}">سڕینەوە</button>` : ''}
        </div>
      </li>`;
  }

  function drawReckoning(g) {
    const { rows, transfers } = reckon(state.expenses, g);
    const paid = state.weekDoc.paid || {};
    pane.innerHTML = `
      <section class="card">
        <h2 class="section-title">کێ دەبێت چەند بدات</h2>
        ${transfers.length ? `<ul class="transfers">${transfers.map(t => {
          const key = `${t.from.uid}_${t.to.uid}`;
          const done = !!paid[key];
          const mine = t.from.uid === user.uid, toMe = t.to.uid === user.uid;
          const line = mine
            ? `<span><b>تۆ</b> دەبێت بدەیت بە <b>${esc(t.to.name)}</b></span>`
            : `<span><b>${esc(t.from.name)}</b> دەبێت بدات بە <b>${toMe ? 'تۆ' : esc(t.to.name)}</b></span>`;
          return `<li class="${done ? 'done' : ''} ${mine ? 'mine' : ''}">
            <div class="t-line">${line}<span class="amt">${money(t.amount, g.currency)}</span></div>
            <label class="check small"><input type="checkbox" data-key="${key}" ${done ? 'checked' : ''}> دراوە</label>
          </li>`;
        }).join('')}</ul>`
        : `<p class="muted center">${state.expenses.length ? 'هەموو شت یەکسانە، کەس قەرزار نییە.' : 'ئەم هەفتەیە هیچ شتێک نییە بۆ حیسابکردن.'}</p>`}
      </section>
      <section class="card">
        <h2 class="section-title">حیسابی هەفتە</h2>
        <table class="acct">
          <thead><tr><th>ئەندام</th><th>داویەتی</th><th>بەشی</th><th>ئەنجام</th></tr></thead>
          <tbody>${rows.map(r => `
            <tr${r.uid === user.uid ? ' class="me"' : ''}>
              <td>${esc(r.name)}${r.uid === user.uid ? ' (تۆ)' : ''}</td>
              <td>${num(r.paid, g.currency)}</td>
              <td>${num(r.share, g.currency)}</td>
              <td class="${r.net > 0.004 ? 'plus' : r.net < -0.004 ? 'minus' : ''}">${r.net > 0.004 ? '+' : ''}${num(r.net, g.currency)}</td>
            </tr>`).join('')}</tbody>
        </table>
        <p class="fine">بڕەکان بە ${curName(g.currency)}ن. هەر کڕینێک بە یەکسانی لەنێوان ئەو کەسانەدا دابەش دەکرێت کە بەشدار بوون تێیدا. ئەنجامی (+) واتە ئەوانی تر قەرزاری تۆن، (−) واتە تۆ قەرزاریت.</p>
      </section>`;

    pane.querySelectorAll('[data-key]').forEach(c => c.onchange = async () => {
      try { await store.setPaid(gid, week, c.dataset.key, c.checked); }
      catch (e) { toast(e.message); c.checked = !c.checked; }
    });
  }

  function drawMembers(g) {
    const open = g.size - g.memberIds.length;
    const fresh = lastCreatedCode && lastCreatedCode.id === gid;
    pane.innerHTML = `
      ${fresh ? `<section class="card notice"><p>گرووپەکەت دروستکرا. ئەم کۆدەی خوارەوە بنێرە بۆ ئەندامەکانت تا بتوانن بچنە ناوی.</p></section>` : ''}
      <section class="card">
        <h2 class="section-title">کۆدی گرووپ</h2>
        <p class="code-show" id="codeShow">------</p>
        <div class="row center"><button class="btn small" id="copyCode">کۆپیکردنی کۆد</button></div>
        <p class="fine center">ئەندامەکان «${esc(g.name)}» لە بەشی «گەڕان بۆ گرووپ» دەدۆزنەوە و ئەم کۆدە دەنووسن.</p>
      </section>
      <section class="card">
        <h2 class="section-title">ئەندامان</h2>
        <ol class="members">
          ${g.memberIds.map(uid => `<li>${esc(g.memberNames[uid] || '')}${uid === g.ownerId ? ' <small>دامەزرێنەر</small>' : ''}${uid === user.uid ? ' <small>تۆ</small>' : ''}</li>`).join('')}
          ${Array.from({ length: open }, () => `<li class="empty">جێگای بەتاڵ</li>`).join('')}
        </ol>
      </section>`;

    const show = code => {
      const el = document.getElementById('codeShow');
      if (el && code) el.textContent = code;
    };
    if (fresh) show(lastCreatedCode.code);
    else store.getCode(gid).then(show).catch(() => {});
    document.getElementById('copyCode').onclick = async () => {
      const code = (document.getElementById('codeShow').textContent || '').replace(/\D/g, '');
      try { await navigator.clipboard.writeText(code); toast('کۆدەکە کۆپی کرا.'); }
      catch (e) { toast(`کۆدەکە: ${code}`); }
    };
  }

  cleanups.push(store.watchGroup(gid, g => {
    if (!g) { pane.innerHTML = `<section class="card"><p>ئەم گرووپە نەدۆزرایەوە.</p></section>`; return; }
    state.group = g; draw();
  }));
  cleanups.push(store.watchExpenses(gid, week, list => { state.expenses = list; draw(); }));
  cleanups.push(store.watchWeek(gid, week, w => { state.weekDoc = w; if (tab === 'reckoning') draw(); }));
}

/* ---------- router ---------- */

function route() {
  clearWatchers();
  window.scrollTo(0, 0);
  if (!user) { renderAuth(); return; }
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'new') renderNew();
  else if (parts[0] === 'find') renderFind();
  else if (parts[0] === 'g' && parts[1]) {
    const tab = ['entries', 'reckoning', 'members'].includes(parts[2]) ? parts[2] : 'entries';
    const week = /^\d{4}-\d{2}-\d{2}$/.test(parts[3] || '') ? parts[3] : thisWeek();
    renderBoard(parts[1], tab, week);
  }
  else renderHome();
}

window.addEventListener('hashchange', route);
store.onUser(u => { user = u; route(); });
