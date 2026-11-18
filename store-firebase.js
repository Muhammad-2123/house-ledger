// Shared store: Firebase Auth (username + password) and Cloud Firestore.
// Loaded only when config.js has a firebaseConfig.
import { firebaseConfig } from './config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut as fbSignOut, updateProfile
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, doc, collection, getDoc, setDoc, deleteDoc, updateDoc,
  onSnapshot, query, where, orderBy, startAt, endAt, limit, getDocs,
  writeBatch, arrayUnion, arrayRemove, deleteField
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export const mode = 'firebase';

// Usernames are turned into a private, never-mailed address so Firebase Auth
// can store them. People only ever see and type their username.
const toEmail = u => `${u.toLowerCase()}@members.house-ledger.example.com`;

let me = null;
let pendingName = null;

// Right after sign-up/sign-in, Firestore may briefly not see the new login yet
// and refuse a request. Retry those a few times before giving up.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isDenied = e => ((e && e.code) || '').includes('permission-denied');
async function retry(fn, tries = 4) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) { if (!isDenied(e) || i >= tries - 1) throw e; await sleep(600 * (i + 1)); }
  }
}
// Live listener that re-subscribes if it is refused during that same moment.
function listen(target, onNext, onFail) {
  let unsub = () => {}, stopped = false, attempts = 0;
  const start = () => {
    unsub = onSnapshot(target, snap => { attempts = 0; onNext(snap); }, e => {
      if (stopped) return;
      if (isDenied(e) && attempts++ < 4) setTimeout(() => { if (!stopped) start(); }, 700 * attempts);
      else { console.error(e); onFail && onFail(e); }
    });
  };
  start();
  return () => { stopped = true; unsub(); };
}

function friendly(err) {
  const code = err && err.code || '';
  if (code.includes('email-already-in-use')) return new Error('That username is already taken.');
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found'))
    return new Error('Username or password is not right.');
  if (code.includes('weak-password')) return new Error('The password needs at least 6 characters.');
  if (code.includes('too-many-requests')) return new Error('Too many tries. Wait a minute and try again.');
  if (code.includes('permission-denied')) return new Error('That was not allowed. Please try again.');
  if (code.includes('network') || code.includes('unavailable')) return new Error('No connection. Check the internet and try again.');
  return err instanceof Error ? err : new Error(String(err));
}

export function onUser(cb) {
  return onAuthStateChanged(auth, async u => {
    if (!u) { me = null; cb(null); return; }
    let name = u.displayName || pendingName;
    const username = u.email ? u.email.split('@')[0] : '';
    if (!name) {
      try {
        const snap = await retry(() => getDoc(doc(db, 'users', u.uid)));
        if (snap.exists()) name = snap.data().name;
      } catch (e) { /* ignore */ }
    }
    me = { uid: u.uid, name: name || username, username };
    cb(me);
  });
}

export async function signUp({ name, username, password }) {
  try {
    pendingName = name;
    const cred = await createUserWithEmailAndPassword(auth, toEmail(username), password);
    if (me && me.uid === cred.user.uid) me.name = name;
    await updateProfile(cred.user, { displayName: name });
    retry(() => setDoc(doc(db, 'users', cred.user.uid), { name, username: username.toLowerCase() }))
      .catch(e => console.warn('profile save', e));
  } catch (e) { throw friendly(e); }
}

export async function signIn({ username, password }) {
  try { await signInWithEmailAndPassword(auth, toEmail(username), password); }
  catch (e) { throw friendly(e); }
}

export async function signOut() { pendingName = null; await fbSignOut(auth); }

function requireUser() {
  if (!me) throw new Error('Please sign in first.');
  return me;
}

export async function createGroup({ name, size, currency }) {
  const u = requireUser();
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
  const ref = doc(collection(db, 'groups'));
  try {
    await retry(() => {
      const batch = writeBatch(db);
      batch.set(ref, {
        name, nameLower: name.toLowerCase(), size, currency,
        ownerId: u.uid, ownerName: u.name,
        memberIds: [u.uid], memberNames: { [u.uid]: u.name },
        createdAt: Date.now()
      });
      batch.set(doc(db, 'groupSecrets', ref.id), { code, ownerId: u.uid });
      return batch.commit();
    });
  } catch (e) { throw friendly(e); }
  return { id: ref.id, code };
}

export async function searchGroups(q) {
  requireUser();
  const term = q.trim().toLowerCase();
  const qy = term
    ? query(collection(db, 'groups'), orderBy('nameLower'), startAt(term), endAt(term + ''), limit(30))
    : query(collection(db, 'groups'), orderBy('nameLower'), limit(30));
  try {
    const snap = await retry(() => getDocs(qy));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) { throw friendly(e); }
}

export function watchMyGroups(cb) {
  const u = requireUser();
  const qy = query(collection(db, 'groups'), where('memberIds', 'array-contains', u.uid));
  return listen(qy, snap => {
    cb(snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => b.createdAt - a.createdAt));
  }, () => cb([]));
}

export async function joinGroup(gid, code) {
  const u = requireUser();
  const gref = doc(db, 'groups', gid);
  let snap;
  try { snap = await retry(() => getDoc(gref)); } catch (e) { throw friendly(e); }
  if (!snap.exists()) throw new Error('That group no longer exists.');
  const g = snap.data();
  if (g.memberIds.includes(u.uid)) return;
  if (g.memberIds.length >= g.size) throw new Error('This group is already full.');
  const batch = writeBatch(db);
  batch.set(doc(db, 'groups', gid, 'joins', u.uid), { code, at: Date.now() });
  batch.update(gref, {
    memberIds: [...g.memberIds, u.uid],
    [`memberNames.${u.uid}`]: u.name
  });
  try { await batch.commit(); }
  catch (e) {
    if (isDenied(e)) throw new Error('That code is not right, or the group just filled up.');
    throw friendly(e);
  }
}

export function watchGroup(gid, cb) {
  return listen(doc(db, 'groups', gid),
    s => cb(s.exists() ? { id: s.id, ...s.data() } : null),
    () => cb(null));
}

export async function getCode(gid) {
  const s = await retry(() => getDoc(doc(db, 'groupSecrets', gid)));
  return s.exists() ? s.data().code : '';
}

export function watchExpenses(gid, weekKey, cb) {
  const qy = query(collection(db, 'groups', gid, 'expenses'), where('weekKey', '==', weekKey));
  return listen(qy, snap => {
    cb(snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => b.createdAt - a.createdAt));
  });
}

export async function addExpense(gid, { item, amount, includeMe, weekKey }) {
  const u = requireUser();
  const ref = doc(collection(db, 'groups', gid, 'expenses'));
  try {
    await retry(() => setDoc(ref, {
      item, amount, weekKey,
      paidBy: u.uid, paidByName: u.name,
      participants: includeMe ? [u.uid] : [],
      createdAt: Date.now()
    }));
  } catch (e) { throw friendly(e); }
}

export async function setParticipation(gid, eid, join) {
  const u = requireUser();
  try {
    await retry(() => updateDoc(doc(db, 'groups', gid, 'expenses', eid), {
      participants: join ? arrayUnion(u.uid) : arrayRemove(u.uid)
    }));
  } catch (e) { throw friendly(e); }
}

export async function deleteExpense(gid, eid) {
  try { await deleteDoc(doc(db, 'groups', gid, 'expenses', eid)); }
  catch (e) { throw friendly(e); }
}

export function watchWeek(gid, weekKey, cb) {
  return listen(doc(db, 'groups', gid, 'weeks', weekKey),
    s => cb(s.exists() ? { paid: {}, ...s.data() } : { paid: {} }));
}

export async function setPaid(gid, weekKey, key, value) {
  try {
    await retry(() => setDoc(doc(db, 'groups', gid, 'weeks', weekKey),
      { paid: { [key]: value ? true : deleteField() } }, { merge: true }));
  } catch (e) { throw friendly(e); }
}
