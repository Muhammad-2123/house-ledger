import { firebaseConfig } from './config.js';

const store = firebaseConfig
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

function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => $toast.classList.remove('show'), 2600);
}

function clearWatchers() { cleanups.forEach(fn => fn && fn()); cleanups = []; }

function money(n, currency) {
  const digits = currency === 'IQD' ? 0 : 2;
  const v = Number(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return currency === 'USD' ? `$${v}` : `${v} ${currency}`;
}

function num(n, currency) {
  const digits = currency === 'IQD' ? 0 : 2;
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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
  const left = `${a.getDate()} ${MONTHS[a.getMonth()]}`;
  const right = `${b.getDate()} ${MONTHS[b.getMonth()]} ${b.getFullYear()}`;
  return `${left} – ${right}`;
}
function stamp(ms) {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* ---------- the reckoning: who pays whom ---------- */

function reckon(expenses, group) {
  const scale = group.currency === 'IQD' ? 1 : 100;
  const people = {};
  const ensure = (uid, name) => (people[uid] ||= { uid, name: name || group.memberNames?.[uid] || 'Former member', paid: 0, share: 0 });
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
      <div class="rule-double"></div>
      <h1 class="title"><a href="#/">The House Ledger</a></h1>
      <p class="subtitle">${sub}</p>
      <div class="rule-double"></div>
    </header>`;
}

function previewNote() {
  return store.mode === 'local'
    ? `<p class="preview-note">Preview edition &middot; entries are kept on this device only</p>`
    : '';
}

/* ---------- screens ---------- */

function renderAuth(tab = 'in') {
  $app.innerHTML = `
    ${masthead('Shared purchases, fairly divided')}
    <section class="card">
      <div class="tabs" role="tablist">
        <button class="tab ${tab === 'in' ? 'on' : ''}" data-tab="in">Sign in</button>
        <button class="tab ${tab === 'up' ? 'on' : ''}" data-tab="up">New account</button>
      </div>
      <form id="authForm" class="form" autocomplete="on">
        ${tab === 'up' ? `
        <label>Your name
          <input name="name" required maxlength="30" autocomplete="name" placeholder="As your friends know you">
        </label>` : ''}
        <label>Username
          <input name="username" required minlength="3" maxlength="20" pattern="[A-Za-z0-9_.]+"
            autocapitalize="none" autocomplete="username" placeholder="letters and numbers">
        </label>
        <label>Password
          <input name="password" type="password" required minlength="6"
            autocomplete="${tab === 'up' ? 'new-password' : 'current-password'}" placeholder="at least 6 characters">
        </label>
        <p class="error" id="authErr"></p>
        <button class="btn primary" type="submit">${tab === 'up' ? 'Open my account' : 'Sign in'}</button>
      </form>
      <p class="fine">${tab === 'up'
        ? 'This phone will remember you, so next time you go straight to your groups.'
        : 'New here? Choose &ldquo;New account&rdquo; above.'}</p>
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
    ${masthead(`Good day, ${esc(user.name)}`)}
    <section class="card">
      <h2 class="section-title">Your Groups</h2>
      <ul class="group-list" id="myGroups"><li class="muted">Turning the pages&hellip;</li></ul>
    </section>
    <div class="actions">
      <a class="btn primary" href="#/new">Found a new group</a>
      <a class="btn" href="#/find">Find a group</a>
    </div>
    <p class="signout"><button class="link" id="signOut">Sign out (${esc(user.username)})</button></p>
    ${previewNote()}`;

  document.getElementById('signOut').onclick = () => store.signOut();
  cleanups.push(store.watchMyGroups(groups => {
    const ul = document.getElementById('myGroups');
    if (!ul) return;
    ul.innerHTML = groups.length ? groups.map(g => `
      <li><a href="#/g/${g.id}">
        <span class="g-name">${esc(g.name)}</span>
        <span class="g-meta">${g.memberIds.length} of ${g.size} members${g.ownerId === user.uid ? ' &middot; founder' : ''}</span>
      </a></li>`).join('')
      : `<li class="muted">You belong to no group yet. Found one, or find your friends&rsquo; group and join it with its code.</li>`;
  }));
}

function renderNew() {
  $app.innerHTML = `
    ${masthead('Found a new group')}
    <section class="card">
      <form id="newForm" class="form">
        <label>Name of the group
          <input name="name" required maxlength="40" placeholder="e.g. Flat 4, Bakhtiari Street">
        </label>
        <label>Number of members
          <select name="size">
            ${Array.from({ length: 19 }, (_, i) => i + 2).map(n => `<option ${n === 4 ? 'selected' : ''}>${n}</option>`).join('')}
          </select>
        </label>
        <label>Money is counted in
          <select name="currency">
            <option value="IQD">Iraqi dinar (IQD)</option>
            <option value="USD">US dollar (USD)</option>
          </select>
        </label>
        <p class="error" id="newErr"></p>
        <button class="btn primary" type="submit">Found the group</button>
      </form>
      <p class="fine">A six-digit code will be made for the group. Give it only to your members.</p>
    </section>
    <p class="back"><a href="#/">&larr; Back to your groups</a></p>`;

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
    ${masthead('Find a group')}
    <section class="card">
      <form id="findForm" class="search">
        <input name="q" type="search" placeholder="Search by group name" autocomplete="off">
        <button class="btn" type="submit">Search</button>
      </form>
      <ul class="group-list" id="results"></ul>
    </section>
    <p class="back"><a href="#/">&larr; Back to your groups</a></p>
    <dialog id="codeDlg" class="dialog">
      <form method="dialog" id="codeForm" class="form">
        <h3 id="dlgTitle" class="section-title"></h3>
        <p class="fine">Ask the founder for the group&rsquo;s six-digit code.</p>
        <input id="codeInput" class="code-input" inputmode="numeric" pattern="[0-9]{6}" maxlength="6"
          autocomplete="one-time-code" placeholder="&middot; &middot; &middot; &middot; &middot; &middot;" required>
        <p class="error" id="codeErr"></p>
        <div class="row">
          <button class="btn" type="button" id="dlgCancel">Cancel</button>
          <button class="btn primary" type="submit" id="dlgJoin">Join</button>
        </div>
      </form>
    </dialog>`;

  const form = document.getElementById('findForm');
  const results = document.getElementById('results');
  const dlg = document.getElementById('codeDlg');
  let target = null;

  async function run() {
    results.innerHTML = `<li class="muted">Searching&hellip;</li>`;
    try {
      const list = await store.searchGroups(form.q.value);
      results.innerHTML = list.length ? list.map(g => {
        const mine = g.memberIds.includes(user.uid);
        const full = g.memberIds.length >= g.size;
        return `<li><button class="row-btn" data-id="${g.id}" data-name="${esc(g.name)}" data-mine="${mine}" ${full && !mine ? 'disabled' : ''}>
          <span class="g-name">${esc(g.name)}</span>
          <span class="g-meta">founded by ${esc(g.ownerName)} &middot; ${g.memberIds.length} of ${g.size}
            ${mine ? ' &middot; <em>you are in</em>' : full ? ' &middot; <em>full</em>' : ''}</span>
        </button></li>`;
      }).join('') : `<li class="muted">No group by that name.</li>`;
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
    const code = document.getElementById('codeInput').value.trim();
    if (!/^\d{6}$/.test(code)) { document.getElementById('codeErr').textContent = 'The code has six digits.'; return; }
    const btn = document.getElementById('dlgJoin');
    btn.disabled = true;
    try {
      await store.joinGroup(target, code);
      dlg.close();
      toast('Welcome to the group.');
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
      <a href="#/" class="back-mini">&larr; Groups</a>
      <h1 class="board-title" id="gName">&nbsp;</h1>
      <p class="board-sub" id="gSub">&nbsp;</p>
    </header>
    <nav class="week-nav">
      <a href="#/g/${gid}/${tab}/${shiftWeek(week, -1)}" aria-label="Previous week">&lsaquo;</a>
      <span><small>Week of</small>${weekLabel(week)}</span>
      ${week < thisWeek() ? `<a href="#/g/${gid}/${tab}/${shiftWeek(week, 1)}" aria-label="Next week">&rsaquo;</a>` : '<i></i>'}
    </nav>
    <div class="tabs board-tabs">
      <a class="tab ${tab === 'entries' ? 'on' : ''}" href="#/g/${gid}/entries/${week}">Entries</a>
      <a class="tab ${tab === 'reckoning' ? 'on' : ''}" href="#/g/${gid}/reckoning/${week}">Reckoning</a>
      <a class="tab ${tab === 'members' ? 'on' : ''}" href="#/g/${gid}/members/${week}">Members</a>
    </div>
    <main id="pane"></main>`;

  const pane = document.getElementById('pane');

  function draw() {
    const g = state.group;
    if (!g) return;
    if (!g.memberIds.includes(user.uid)) {
      pane.innerHTML = `<section class="card"><p>You are not a member of this group. <a href="#/find">Find it and join with the code.</a></p></section>`;
      return;
    }
    document.getElementById('gName').textContent = g.name;
    document.getElementById('gSub').textContent = `${g.memberIds.length} of ${g.size} members · ${g.currency}`;
    if (tab === 'entries') drawEntries(g);
    else if (tab === 'reckoning') drawReckoning(g);
    else drawMembers(g);
  }

  function drawEntries(g) {
    const total = state.expenses.reduce((s, e) => s + e.amount, 0);
    const isCurrent = week === thisWeek();
    const ledgerHTML = `
        <h2 class="section-title">This Week&rsquo;s Entries</h2>
        ${state.expenses.length ? `<ol class="entries">${state.expenses.map(e => entryHTML(e, g)).join('')}</ol>
          <div class="total"><span>Spent this week</span><span>${money(total, g.currency)}</span></div>`
        : `<p class="muted center">Nothing entered this week.</p>`}`;
    const ledger = document.getElementById('ledger');
    if (ledger) { ledger.innerHTML = ledgerHTML; bindEntryButtons(); return; }

    pane.innerHTML = `
      ${isCurrent ? `
      <section class="card">
        <h2 class="section-title">New Entry</h2>
        <form id="addForm" class="form">
          <label>What was bought
            <input name="item" required maxlength="80" placeholder="e.g. Bread, rice and tea">
          </label>
          <label>Amount paid (${g.currency})
            <input name="amount" required inputmode="decimal" placeholder="0">
          </label>
          <label class="check"><input type="checkbox" name="me" checked> I share in this too</label>
          <button class="btn primary" type="submit">Enter in the ledger</button>
        </form>
      </section>` : `<p class="fine center">This week is closed. New entries go into the current week.</p>`}
      <section class="card ledger" id="ledger">${ledgerHTML}</section>`;

    const form = document.getElementById('addForm');
    if (form) form.onsubmit = async ev => {
      ev.preventDefault();
      const amount = Number(String(form.amount.value).replace(/[,\s]/g, ''));
      if (!(amount > 0)) { toast('Please write the amount as a number.'); return; }
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await store.addExpense(gid, { item: form.item.value.trim(), amount, includeMe: form.me.checked, weekKey: week });
        form.reset(); form.me.checked = true;
        toast('Entered. The others can now say if they share in it.');
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
      if (!confirm('Strike this entry from the ledger?')) return;
      try { await store.deleteExpense(gid, b.dataset.del); } catch (e) { toast(e.message); }
    });
  }

  function entryHTML(e, g) {
    const n = e.participants.length;
    const iAmIn = e.participants.includes(user.uid);
    const names = e.participants.map(u => u === user.uid ? 'you' : (g.memberNames[u] || 'former member'));
    const payer = e.paidBy === user.uid ? 'you' : esc(e.paidByName);
    return `
      <li class="entry">
        <div class="entry-top">
          <span class="item">${esc(e.item)}</span>
          <span class="amt">${money(e.amount, g.currency)}</span>
        </div>
        <div class="entry-meta">paid by ${payer} &middot; ${stamp(e.createdAt)}</div>
        <div class="entry-share">
          ${n ? `Shared by ${names.map(esc).join(', ')} &mdash; <b>${money(e.amount / n, g.currency)}</b> each`
              : `<em>No one has joined this yet.</em>`}
        </div>
        <div class="entry-actions">
          ${iAmIn
            ? `<button class="btn small" data-join="0" data-id="${e.id}">Count me out</button>`
            : `<button class="btn small primary" data-join="1" data-id="${e.id}">I share in this</button>`}
          ${e.paidBy === user.uid ? `<button class="link danger" data-del="${e.id}">Strike out</button>` : ''}
        </div>
      </li>`;
  }

  function drawReckoning(g) {
    const { rows, transfers } = reckon(state.expenses, g);
    const paid = state.weekDoc.paid || {};
    pane.innerHTML = `
      <section class="card">
        <h2 class="section-title">Settling Up</h2>
        ${transfers.length ? `<ul class="transfers">${transfers.map(t => {
          const key = `${t.from.uid}_${t.to.uid}`;
          const done = !!paid[key];
          const mine = t.from.uid === user.uid, toMe = t.to.uid === user.uid;
          return `<li class="${done ? 'done' : ''} ${mine ? 'mine' : ''}">
            <div class="t-line">
              <span><b>${mine ? 'You' : esc(t.from.name)}</b> ${mine ? 'pay' : 'pays'} <b>${toMe ? 'you' : esc(t.to.name)}</b></span>
              <span class="amt">${money(t.amount, g.currency)}</span>
            </div>
            <label class="check small"><input type="checkbox" data-key="${key}" ${done ? 'checked' : ''}> Settled</label>
          </li>`;
        }).join('')}</ul>`
        : `<p class="muted center">${state.expenses.length ? 'All square. Nobody owes anything this week.' : 'Nothing to settle this week.'}</p>`}
      </section>
      <section class="card">
        <h2 class="section-title">The Week&rsquo;s Account</h2>
        <table class="acct">
          <thead><tr><th>Member</th><th>Paid</th><th>Share</th><th>Balance</th></tr></thead>
          <tbody>${rows.map(r => `
            <tr${r.uid === user.uid ? ' class="me"' : ''}>
              <td>${esc(r.name)}</td>
              <td>${num(r.paid, g.currency)}</td>
              <td>${num(r.share, g.currency)}</td>
              <td class="${r.net > 0.004 ? 'plus' : r.net < -0.004 ? 'minus' : ''}">${r.net > 0.004 ? '+' : ''}${num(r.net, g.currency)}</td>
            </tr>`).join('')}</tbody>
        </table>
        <p class="fine">Amounts in ${g.currency}. Every purchase is divided equally among the members who share in it. A plus balance means the others owe you.</p>
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
      ${fresh ? `<section class="card notice"><p>Your group is founded. Send the code below to your members so they can join.</p></section>` : ''}
      <section class="card">
        <h2 class="section-title">Group Code</h2>
        <p class="code-show" id="codeShow">&middot; &middot; &middot; &middot; &middot; &middot;</p>
        <div class="row center"><button class="btn small" id="copyCode">Copy code</button></div>
        <p class="fine center">Members find &ldquo;${esc(g.name)}&rdquo; under <i>Find a group</i> and enter this code.</p>
      </section>
      <section class="card">
        <h2 class="section-title">Members</h2>
        <ol class="members">
          ${g.memberIds.map(uid => `<li>${esc(g.memberNames[uid] || '')}${uid === g.ownerId ? ' <small>founder</small>' : ''}${uid === user.uid ? ' <small>you</small>' : ''}</li>`).join('')}
          ${Array.from({ length: open }, () => `<li class="empty">vacant seat</li>`).join('')}
        </ol>
      </section>`;

    const show = code => {
      const el = document.getElementById('codeShow');
      if (el && code) el.textContent = code.split('').join(' ');
    };
    if (fresh) show(lastCreatedCode.code);
    else store.getCode(gid).then(show).catch(() => {});
    document.getElementById('copyCode').onclick = async () => {
      const code = (document.getElementById('codeShow').textContent || '').replace(/\D/g, '');
      try { await navigator.clipboard.writeText(code); toast('Code copied.'); }
      catch (e) { toast(`The code is ${code}`); }
    };
  }

  cleanups.push(store.watchGroup(gid, g => {
    if (!g) { pane.innerHTML = `<section class="card"><p>This group could not be found.</p></section>`; return; }
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
