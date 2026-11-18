// Preview store: keeps everything in this browser's localStorage.
// Same interface as store-firebase.js, so the app can't tell the difference.

const DB_KEY = 'ledger.db.v1';
const SESSION_KEY = 'ledger.session.v1';

const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* ignore */ }
  return { users: {}, groups: {}, secrets: {}, expenses: {}, weeks: {} };
}
function save(db) {
  localStorage.setItem(DB_KEY, JSON.stringify(db));
  notify();
}
function notify() { listeners.forEach(fn => { try { fn(); } catch (e) { console.error(e); } }); }
window.addEventListener('storage', e => { if (e.key === DB_KEY || e.key === SESSION_KEY) notify(); });

function watch(compute, cb) {
  const run = () => cb(compute());
  listeners.add(run);
  queueMicrotask(run);
  return () => listeners.delete(run);
}

const id = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

async function hash(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function sessionUid() {
  try { return localStorage.getItem(SESSION_KEY); } catch (e) { return null; }
}
function currentUser() {
  const uid = sessionUid();
  if (!uid) return null;
  const u = load().users[uid];
  return u ? { uid, name: u.name, username: u.username } : null;
}
function requireUser() {
  const u = currentUser();
  if (!u) throw new Error('Please sign in first.');
  return u;
}
function requireMember(db, gid, uid) {
  const g = db.groups[gid];
  if (!g) throw new Error('That group no longer exists.');
  if (!g.memberIds.includes(uid)) throw new Error('You are not a member of this group.');
  return g;
}

export const mode = 'local';

export function onUser(cb) {
  let last;
  return watch(currentUser, u => {
    const key = u ? u.uid : null;
    if (key !== last) { last = key; cb(u); }
  });
}

export async function signUp({ name, username, password }) {
  const db = load();
  const uname = username.toLowerCase();
  if (Object.values(db.users).some(u => u.username === uname)) {
    throw new Error('That username is already taken.');
  }
  const uid = id();
  db.users[uid] = { name, username: uname, passHash: await hash(uname + ':' + password) };
  localStorage.setItem(SESSION_KEY, uid);
  save(db);
}

export async function signIn({ username, password }) {
  const db = load();
  const uname = username.toLowerCase();
  const entry = Object.entries(db.users).find(([, u]) => u.username === uname);
  if (!entry || entry[1].passHash !== await hash(uname + ':' + password)) {
    throw new Error('Username or password is not right.');
  }
  localStorage.setItem(SESSION_KEY, entry[0]);
  notify();
}

export async function signOut() {
  localStorage.removeItem(SESSION_KEY);
  notify();
}

export async function createGroup({ name, size, currency }) {
  const me = requireUser();
  const db = load();
  const gid = id();
  const code = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
  db.groups[gid] = {
    name, nameLower: name.toLowerCase(), size, currency,
    ownerId: me.uid, ownerName: me.name,
    memberIds: [me.uid], memberNames: { [me.uid]: me.name },
    createdAt: Date.now()
  };
  db.secrets[gid] = code;
  save(db);
  return { id: gid, code };
}

export async function searchGroups(q) {
  requireUser();
  const term = q.trim().toLowerCase();
  const all = Object.entries(load().groups).map(([id, g]) => ({ id, ...g }));
  return all
    .filter(g => !term || g.nameLower.includes(term))
    .sort((a, b) => a.nameLower.localeCompare(b.nameLower))
    .slice(0, 30);
}

export function watchMyGroups(cb) {
  return watch(() => {
    const me = currentUser();
    if (!me) return [];
    return Object.entries(load().groups)
      .filter(([, g]) => g.memberIds.includes(me.uid))
      .map(([id, g]) => ({ id, ...g }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }, cb);
}

export async function joinGroup(gid, code) {
  const me = requireUser();
  const db = load();
  const g = db.groups[gid];
  if (!g) throw new Error('That group no longer exists.');
  if (g.memberIds.includes(me.uid)) return;
  if (db.secrets[gid] !== code) throw new Error('That code is not right. Ask the group founder for it.');
  if (g.memberIds.length >= g.size) throw new Error('This group is already full.');
  g.memberIds.push(me.uid);
  g.memberNames[me.uid] = me.name;
  save(db);
}

export function watchGroup(gid, cb) {
  return watch(() => {
    const g = load().groups[gid];
    return g ? { id: gid, ...g } : null;
  }, cb);
}

export async function getCode(gid) {
  const me = requireUser();
  const db = load();
  requireMember(db, gid, me.uid);
  return db.secrets[gid];
}

export function watchExpenses(gid, weekKey, cb) {
  return watch(() => {
    const list = load().expenses[gid] || {};
    return Object.entries(list)
      .map(([id, e]) => ({ id, ...e }))
      .filter(e => e.weekKey === weekKey)
      .sort((a, b) => b.createdAt - a.createdAt);
  }, cb);
}

export async function addExpense(gid, { item, amount, includeMe, weekKey }) {
  const me = requireUser();
  const db = load();
  requireMember(db, gid, me.uid);
  db.expenses[gid] = db.expenses[gid] || {};
  db.expenses[gid][id()] = {
    item, amount, weekKey,
    paidBy: me.uid, paidByName: me.name,
    participants: includeMe ? [me.uid] : [],
    createdAt: Date.now()
  };
  save(db);
}

export async function setParticipation(gid, eid, join) {
  const me = requireUser();
  const db = load();
  requireMember(db, gid, me.uid);
  const e = db.expenses[gid] && db.expenses[gid][eid];
  if (!e) return;
  e.participants = e.participants.filter(u => u !== me.uid);
  if (join) e.participants.push(me.uid);
  save(db);
}

export async function deleteExpense(gid, eid) {
  const me = requireUser();
  const db = load();
  const e = db.expenses[gid] && db.expenses[gid][eid];
  if (!e) return;
  if (e.paidBy !== me.uid) throw new Error('Only the person who paid can strike out an entry.');
  delete db.expenses[gid][eid];
  save(db);
}

export function watchWeek(gid, weekKey, cb) {
  return watch(() => {
    const w = (load().weeks[gid] || {})[weekKey];
    return w || { paid: {} };
  }, cb);
}

export async function setPaid(gid, weekKey, key, value) {
  const me = requireUser();
  const db = load();
  requireMember(db, gid, me.uid);
  db.weeks[gid] = db.weeks[gid] || {};
  const w = db.weeks[gid][weekKey] = db.weeks[gid][weekKey] || { paid: {} };
  if (value) w.paid[key] = true; else delete w.paid[key];
  save(db);
}
