'use strict';
(() => {
  const wab = window.wab;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const PAGE = 60;
  const EMOJIS = ['😀', '😂', '🙂', '😉', '😍', '🥰', '😘', '😊', '🙏', '👍', '👏', '🎉', '❤️', '💪', '🤝', '😢', '😮', '🤔', '😅', '🙌', '✅', '❌', '⭐', '🔥', '🌹', '🎂', '🎁', '☕', '🍎', '🕯️', '📞', '📍'];

  const S = {
    info: null, convs: new Map(), msgs: new Map(), seen: new Set(), done: new Set(), drafts: new Map(),
    active: null, cursor: 0, phoneLastPollAt: 0, skew: 0, online: true, search: '', pendingFiles: [], loadingOlder: false, retentionDays: 30,
    gen: 0, activeId: null, acctSummary: {}, addMode: false, mediaSrc: new Map(), mediaPending: new Map(), blobUrl: new Map(), msgNodes: new Map(), dayNodes: new Map(),
    filter: 'all', msgResults: [], sched: [], find: { q: '', results: [], idx: -1 }, stale: new Set(), fromCache: false, cacheTimer: null, lock: { enabled: false, locked: false, minutes: 5, onHide: true }, baseSub: '',
  };

  // ------------------------------------------------------------ helpers
  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid);
    return n;
  }
  const key = (type, name) => (type === 'group' ? 'group' : 'private') + '|' + name;
  const show = (id, on = true) => $(id).classList.toggle('hidden', !on);
  const now = () => Date.now() + S.skew;

  async function api(method, path, body) {
    const r = await wab.call(method, path, body, S.activeId);
    if (!r.ok) { const e = new Error(r.error || 'שגיאה'); e.status = r.status; throw e; }
    return r.data;
  }

  let toastTimer = null;
  function toast(text, kind) {
    const t = $('#toast');
    t.textContent = text;
    t.className = 'toast' + (kind === 'error' ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), kind === 'error' ? 6000 : 3000);
  }

  // a name that is a phone number ("+972 54-220-3610") must read left-to-right, or the + jumps to the end in a Hebrew UI
  const nameDir = (n) => (/^[\s+\d\-()\u200E\u200F\u202A-\u202E]+$/.test(String(n || '')) ? 'ltr' : 'auto');
  const colorOf = (s) => { let h = 0; for (const ch of s) h = (h * 31 + ch.codePointAt(0)) % 360; return `hsl(${h} 45% 45%)`; };
  const initial = (c) => (c.type === 'group' ? '👥' : (Array.from((c.name || '?').trim())[0] || '?').toUpperCase());
  function avatar(c, small) { return el('div', { class: 'avatar' + (small ? ' sm' : ''), style: `background:${colorOf(c.name)}`, text: initial(c) }); }

  const hhmm = (t) => new Date(t).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  function dayLabel(t) {
    const d = new Date(t), n = new Date();
    const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((start(n) - start(d)) / 86400000);
    if (diff === 0) return 'היום';
    if (diff === 1) return 'אתמול';
    return d.toLocaleDateString('he-IL', { day: 'numeric', month: 'long', year: diff > 300 ? 'numeric' : undefined });
  }
  function listTime(t) {
    if (!t) return '';
    const diff = dayLabel(t);
    return diff === 'היום' ? hhmm(t) : diff === 'אתמול' ? 'אתמול' : new Date(t).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' });
  }
  const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(n / 1024)) + 'KB');
  const TICK = { queued: ['🕓', 'ממתין לטלפון'], picked: ['📲', 'הטלפון לקח את ההודעה'], sent: ['✓', 'נשלח'], failed: ['⚠', 'השליחה נכשלה'], cancelled: ['✕', 'בוטל'] };
  const slim = (m) => ({ id: m.id, dir: m.dir, text: String(m.text || '').slice(0, 120), at: m.at, status: m.status, files: (m.files || []).length });

  function linkify(text) {
    const out = [];
    let last = 0;
    for (const m of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
      if (m.index > last) out.push(text.slice(last, m.index));
      out.push(el('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer', text: m[0] }));
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  // ------------------------------------------------------------ login
  function showLogin(message, { add } = {}) {
    stopSync();
    S.active = null;
    S.addMode = !!add;
    show('#app', false);
    show('#login');
    $('#l-title').textContent = add ? 'הוספת מספר נוסף: הדבק את הקישור האישי שלו' : 'התחברות לחשבון שלך בשרת';
    show('#l-cancel', !!add && S.info.accounts.length > 0);
    $('#l-link').value = '';
    $('#l-ver').textContent = 'גרסה ' + S.info.version;
    const err = $('#l-error');
    err.textContent = message || '';
    err.classList.toggle('hidden', !message);
    $('#l-pass').value = '';
    $('#l-code').value = '';
    show('#l-code-wrap', false);
    $('#l-link').focus();
  }

  async function doLogin(e) {
    e.preventDefault();
    const btn = $('#l-btn'), err = $('#l-error');
    btn.disabled = true;
    btn.textContent = 'מתחבר… (אם השרת ישן, זה יכול לקחת עד דקה)';
    err.classList.add('hidden');
    const r = await wab.login({ link: $('#l-link').value, password: $('#l-pass').value, code: $('#l-code').value.trim() });
    btn.disabled = false;
    btn.textContent = 'התחבר';
    if (!r.ok) {
      err.textContent = r.error;
      err.classList.remove('hidden');
      if (r.needCode) { show('#l-code-wrap'); $('#l-code').focus(); }
      return;
    }
    S.info = await wab.info();
    if (r.passwordIsDefault) setTimeout(() => toast('מומלץ להחליף את סיסמת ברירת המחדל באזור האישי באתר'), 1500);
    await startSession();
    toast('המספר נוסף: ' + (S.info.label || ''));
  }

  // ------------------------------------------------------------ session / sync
  let syncTimer = null, syncing = false, running = false;

  async function startSession() {
    running = true;
    S.gen++;
    S.activeId = S.info.activeId;
    S.active = null; S.cursor = 0; S.search = ''; S.pendingFiles = []; S.msgNodes.clear(); S.dayNodes.clear(); S.mediaSrc.clear(); S.mediaPending.clear(); for (const u of S.blobUrl.values()) URL.revokeObjectURL(u); S.blobUrl.clear();
    $('#search').value = '';
    show('#chat', false); show('#empty');
    show('#banner', false);
    show('#login', false);
    show('#app');
    renderAccountMenu();
    pollOthers();
    $('#me-name').textContent = S.info.label || '';
    $('#me-avatar').textContent = initial({ type: 'private', name: S.info.label || '?' });
    $('#me-avatar').style.background = colorOf(S.info.label || '?');
    $('#foot-ver').textContent = 'גרסה ' + S.info.version;
    S.convs.clear(); S.msgs.clear(); S.seen.clear(); S.done.clear(); S.stale.clear(); S.msgResults = []; S.sched = []; S.filter = 'all';
    if (await loadCache()) { S.fromCache = true; renderList(); updateBanner(); } // the app opens at once with what it knew; the server confirms in a moment
    try {
      await bootstrap(false);
    } catch (e) {
      if (e.status === 401) return;
      setOnline(false, e.message);
    }
    renderList();
    refreshScheduled();
    scheduleSync();
  }

  function stopSync() { running = false; S.gen++; clearTimeout(syncTimer); }

  async function bootstrap(keepCursor) {
    const gen = S.gen;
    const d = await api('GET', '/api/desk/bootstrap');
    if (gen !== S.gen) return;
    if (!keepCursor) S.cursor = d.cursor;
    S.phoneLastPollAt = d.phoneLastPollAt;
    S.skew = d.serverTime - Date.now();
    S.retentionDays = d.retentionDays;
    const fresh = new Map();
    for (const c of d.conversations) fresh.set(key(c.type, c.name), c);
    S.convs = fresh;
    S.fromCache = false;
    setOnline(true);
    renderList();
    updateUnread();
    updateBanner();
    saveCacheSoon();
  }

  function scheduleSync() {
    clearTimeout(syncTimer);
    if (!running) return;
    syncTimer = setTimeout(async () => { await syncOnce(); scheduleSync(); }, document.hasFocus() ? 2500 : 6000);
  }

  async function syncOnce() {
    if (syncing || !running) return;
    syncing = true;
    const gen = S.gen;
    try {
      for (let i = 0; i < 5; i++) {
        const d = await api('GET', '/api/desk/sync?since=' + S.cursor);
        if (gen !== S.gen) return;
        S.phoneLastPollAt = d.phoneLastPollAt;
        S.skew = d.serverTime - Date.now();
        if (d.messages.length) applyMessages(d.messages);
        S.cursor = Math.max(S.cursor, d.cursor);
        if (d.messages.length < 300) break;
      }
      setOnline(true);
      updateBanner();
    } catch (e) {
      if (e.status !== 401) setOnline(false, e.message);
    } finally {
      syncing = false;
    }
  }

  function setOnline(on, msg) {
    S.online = on;
    S.offlineMsg = msg || '';
    updateBanner();
  }

  function updateBanner() {
    const b = $('#banner');
    let text = '', bad = false;
    if (S.fromCache && S.online) text = 'מציג עותק שמור מהפעם הקודמת, מתעדכן מהשרת…';
    else if (!S.online) { text = (S.offlineMsg || 'אין חיבור לשרת') + ' — מנסה שוב…'; bad = true; }
    else if (!S.phoneLastPollAt) text = 'הטלפון עדיין לא התחבר לשרת. הודעות ימתינו עד שיתחבר.';
    else {
      const age = now() - S.phoneLastPollAt;
      if (age > 3 * 60 * 1000) text = `הטלפון לא מחובר כבר ${age > 3600000 ? Math.round(age / 3600000) + ' שעות' : Math.round(age / 60000) + ' דקות'}. הודעות יישלחו כשיתחבר.`;
    }
    b.textContent = text;
    b.classList.toggle('hidden', !text);
    b.classList.toggle('bad', bad);
  }

  function upsert(list, m) {
    const i = list.findIndex((x) => x.id === m.id);
    if (i >= 0) list[i] = m;
    else { list.push(m); list.sort((a, b) => a.at - b.at || a.seq - b.seq); }
  }

  function applyMessages(msgs) {
    let unknown = false, touchedActive = false;
    for (const m of msgs) {
      const k = key(m.type, m.target);
      const isNew = !S.seen.has(m.id);
      S.seen.add(m.id);
      const list = S.msgs.get(k);
      if (list) upsert(list, m);
      let c = S.convs.get(k);
      if (!c) { unknown = true; c = { type: m.type, name: m.target, phone: '', lastAt: 0, unread: 0, last: null, source: 'incoming' }; S.convs.set(k, c); }
      if (!c.last || m.at >= (c.lastAt || 0) || c.last.id === m.id) { c.lastAt = Math.max(c.lastAt || 0, m.at); c.last = slim(m); }
      if (k === S.active) touchedActive = true;
      if (m.dir === 'in' && isNew) {
        if (k === S.active && document.hasFocus()) api('POST', '/api/desk/read', { type: m.type, name: m.target }).catch(() => {});
        else {
          c.unread = (c.unread || 0) + 1;
          if (c.prefs && c.prefs.archived && !c.prefs.muted) { const p = { ...c.prefs }; delete p.archived; c.prefs = p; } // the server does the same: a new message brings the chat back
          if (!(c.prefs && c.prefs.muted)) wab.notify({ key: k, title: c.name, body: m.text || (m.files && m.files.length ? '📎 ' + m.files[0].name : '') });
        }
      }
    }
    renderList();
    updateUnread();
    saveCacheSoon();
    if (touchedActive) renderThread(false);
    if (unknown) bootstrap(true).catch(() => {});
  }

  function updateUnread() {
    let n = 0;
    for (const c of S.convs.values()) if (!(c.prefs && c.prefs.muted)) n += c.unread || 0; // muted chats do not count
    S.acctSummary[S.activeId] = { ...(S.acctSummary[S.activeId] || {}), unread: n };
    let others = 0;
    for (const [id, v] of Object.entries(S.acctSummary)) if (id !== S.activeId) others += v.unread || 0;
    show('#me-dot', others > 0);
    wab.setUnread(n + others);
    document.title = (n ? `(${n}) ` : '') + 'WA Bridge';
  }

  // ------------------------------------------------------------ conversation list
  function highlight(text, q) {
    const out = [];
    const low = text.toLowerCase();
    let at = 0, i;
    while (q && (i = low.indexOf(q, at)) >= 0) { if (i > at) out.push(text.slice(at, i)); out.push(el('mark', { text: text.slice(i, i + q.length) })); at = i + q.length; }
    out.push(text.slice(at));
    return out;
  }

  function renderFilters() {
    const unread = [...S.convs.values()].filter((c) => !(c.prefs || {}).archived && c.unread > 0).length;
    for (const b of $$('#filters button')) {
      b.classList.toggle('on', b.dataset.f === S.filter);
      if (b.dataset.f === 'unread') b.textContent = unread ? `לא נקראו (${unread})` : 'לא נקראו';
    }
  }

  function convRow(k, c) {
    const last = c.last, p = c.prefs || {};
    let preview = c.type === 'group' ? 'קבוצה' : c.phone ? '+' + c.phone : '';
    if (last) {
      const body = last.text || (last.files ? '📎 קובץ' : '');
      preview = (last.dir === 'out' ? (TICK[last.status] || TICK.queued)[0] + ' ' : '') + body;
    }
    const row = el('div', { class: 'conv' + (k === S.active ? ' active' : ''), 'data-key': k, on: { click: () => openConv(k) } },
      avatar(c),
      el('div', { class: 'conv-main' },
        el('div', { class: 'row1' }, el('span', { class: 'name', dir: nameDir(c.name), text: c.name }), el('span', { style: 'display:flex;gap:6px;align-items:center' }, p.pinned ? el('span', { class: 'pin', title: 'מוצמדת', text: '📌' }) : null, el('span', { class: 'time' + (c.unread && !p.muted ? ' unread' : ''), text: listTime(c.lastAt) }))),
        el('div', { class: 'row2' }, el('span', { class: 'preview', dir: 'auto', text: preview }), el('span', { style: 'display:flex;align-items:center' }, p.muted ? el('span', { class: 'mute', title: 'מושתקת', text: '🔕' }) : null, p.ignore ? el('span', { class: 'mute', title: 'לא נשמרת', text: '🚫' }) : null, c.unread ? el('span', { class: 'badge' + (p.muted ? ' muted' : ''), text: c.unread > 99 ? '99+' : String(c.unread) }) : null))));
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); convMenu(k, e.clientX, e.clientY); });
    return row;
  }

  function resultRow(r, q) {
    const k = key(r.type, r.target);
    const c = S.convs.get(k) || { type: r.type, name: r.target };
    return el('div', { class: 'conv res', on: { click: () => openConvAt(k, r.id) } }, avatar(c),
      el('div', { class: 'conv-main' },
        el('div', { class: 'row1' }, el('span', { class: 'name', dir: nameDir(r.target), text: r.target }), el('span', { class: 'time', text: listTime(r.at) })),
        el('div', { class: 'row2' }, el('span', { class: 'preview', dir: 'auto' }, r.dir === 'out' ? 'אני: ' : '', ...highlight(r.text, q)))));
  }

  function renderList() {
    renderFilters();
    const q = S.search.trim().toLowerCase();
    const visible = ([, c]) => {
      const p = c.prefs || {};
      if (q) return c.name.toLowerCase().includes(q) || (c.phone || '').includes(q) || (c.last && c.last.text.toLowerCase().includes(q));
      if (S.filter === 'archived') return !!p.archived;
      if (p.archived) return false;
      if (S.filter === 'unread') return c.unread > 0;
      if (S.filter === 'groups') return c.type === 'group';
      return true;
    };
    const items = [...S.convs.entries()].filter(visible)
      .sort((a, b) => (((b[1].prefs || {}).pinned ? 1 : 0) - ((a[1].prefs || {}).pinned ? 1 : 0)) || (b[1].lastAt || 0) - (a[1].lastAt || 0) || a[1].name.localeCompare(b[1].name, 'he'));
    const rows = items.map(([k, c]) => convRow(k, c));
    if (q && S.msgResults.length) rows.push(el('div', { class: 'list-sec', text: `הודעות (${S.msgResults.length})` }), ...S.msgResults.map((r) => resultRow(r, q)));
    if (!rows.length) {
      const msg = q ? 'לא נמצאו שיחות' : S.filter === 'archived' ? 'הארכיון ריק' : S.filter === 'unread' ? 'אין הודעות שלא נקראו' : S.filter === 'groups' ? 'אין קבוצות' : 'אין עדיין שיחות. לחץ ✎ כדי להתחיל שיחה חדשה.';
      $('#list').replaceChildren(el('div', { class: 'list-empty', text: msg }));
      return;
    }
    $('#list').replaceChildren(...rows);
  }

  // ------------------------------------------------------------ chat view
  async function openConv(k) {
    const gen = S.gen;
    if (S.active) S.drafts.set(S.activeId + '|' + S.active, $('#input').value);
    S.active = k;
    S.msgNodes.clear(); S.dayNodes.clear();
    S.pendingFiles = [];
    renderChips();
    const c = S.convs.get(k);
    if (!c) return;
    show('#empty', false);
    show('#chat');
    $('#c-avatar').replaceWith(Object.assign(avatar(c), { id: 'c-avatar' }));
    $('#c-name').textContent = c.name;
    $('#c-name').setAttribute('dir', nameDir(c.name));
    S.baseSub = c.type === 'group' ? 'קבוצה (הודעות טקסט בלבד)' : c.phone ? '+' + c.phone : 'ללא מספר טלפון (ניתן להשיב רק לשיחות שהתחילו בוואטסאפ)';
    updateSub();
    closeFind();
    $('#input').value = S.drafts.get(S.activeId + '|' + k) || '';
    autoGrow();
    renderList();
    const hadCopy = S.msgs.has(k);
    if (hadCopy) renderThread(true); // the saved copy shows at once
    if (!hadCopy || S.stale.has(k)) {
      if (!hadCopy) $('#thread').replaceChildren(el('div', { class: 'loading', text: 'טוען…' }));
      try {
        const d = await api('GET', `/api/desk/messages?type=${c.type}&name=${encodeURIComponent(c.name)}&limit=${PAGE}`);
        if (S.active !== k || gen !== S.gen) return;
        S.msgs.set(k, d.messages);
        S.stale.delete(k);
        d.messages.forEach((m) => S.seen.add(m.id));
        if (d.messages.length < PAGE) S.done.add(k);
      } catch (e) {
        if (!hadCopy) { toast(e.message, 'error'); return; } // with a saved copy the chat stays readable offline
      }
    }
    renderThread(true);
    saveCacheSoon();
    $('#input').focus();
    if (c.unread) {
      c.unread = 0;
      renderList();
      updateUnread();
      api('POST', '/api/desk/read', { type: c.type, name: c.name }).catch(() => {});
    }
  }

  function renderThread(toEnd) {
    const k = S.active, c = S.convs.get(k), box = $('#thread');
    if (!c) return;
    const list = S.msgs.get(k) || [];
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const kids = [];
    if (!list.length) kids.push(el('div', { class: 'loading', text: `אין עדיין הודעות שמורות. ההיסטוריה נשמרת מרגע שהאפליקציה מחוברת (${S.retentionDays ? S.retentionDays + ' ימים' : 'עד 3000 הודעות'}).` }));
    let day = '';
    for (const m of list) {
      const d = dayLabel(m.at);
      if (d !== day) {
        day = d;
        if (!S.dayNodes.has(d)) S.dayNodes.set(d, el('div', { class: 'day', text: d }));
        kids.push(S.dayNodes.get(d));
      }
      kids.push(msgNode(m, c));
    }
    reconcile(box, kids);
    if (toEnd || atBottom) box.scrollTop = box.scrollHeight;
  }

  // A message that did not change keeps its DOM node, so a voice note or video that is playing is NOT interrupted when another
  // message arrives (re-building the whole thread used to stop it).
  function msgNode(m, c) {
    const sig = [m.status, m.text, (m.files || []).map((f) => f.mediaId || f.name).join(',')].join('|');
    const hit = S.msgNodes.get(m.id);
    if (hit && hit.sig === sig) return hit.node;
    const node = renderMsg(m, c);
    S.msgNodes.set(m.id, { sig, node });
    return node;
  }

  // puts `desired` into `box` touching as little as possible (moving a playing <audio>/<video> would pause it)
  function reconcile(box, desired) {
    const want = new Set(desired);
    for (const n of [...box.childNodes]) if (!want.has(n)) box.removeChild(n);
    let ref = box.firstChild;
    for (const n of desired) {
      if (n === ref) { ref = ref.nextSibling; continue; }
      box.insertBefore(n, ref);
    }
  }

  function renderMsg(m, c) {
    const [tick, tickTitle] = TICK[m.status] || ['', ''];
    const meta = el('div', { class: 'meta' }, el('span', { text: hhmm(m.at) }));
    if (m.dir === 'out') meta.append(el('span', { class: 'tick ' + m.status, title: tickTitle, text: tick }), el('button', { class: 'info', title: 'איפה ההודעה? (מסלול ואבחון)', text: 'ⓘ', on: { click: () => journeyDialog(m) } }));
    if (m.dir === 'out' && (m.status === 'queued' || m.status === 'picked')) meta.append(el('button', { text: 'בטל', on: { click: () => cancelMsg(m) } })); // also while the phone is (still) trying: a stuck message can be taken back
    if (m.dir === 'out' && m.status === 'failed' && m.text && !(m.files || []).length) meta.append(el('button', { text: 'שלח שוב', on: { click: () => resend(c, m.text) } }));
    const files = (m.files || []).map((f) => renderFile(f, m));
    return el('div', { class: 'msg ' + m.dir, 'data-id': m.id }, el('div', { class: 'bubble' }, ...files, m.text ? el('div', { class: 'text', dir: 'auto' }, ...linkify(m.text)) : null, meta));
  }

  async function loadOlder() {
    const k = S.active;
    if (!k || S.loadingOlder || S.done.has(k)) return;
    const list = S.msgs.get(k);
    if (!list || !list.length) return;
    S.loadingOlder = true;
    const c = S.convs.get(k), box = $('#thread'), before = box.scrollHeight;
    try {
      const d = await api('GET', `/api/desk/messages?type=${c.type}&name=${encodeURIComponent(c.name)}&before=${list[0].at}&limit=${PAGE}`);
      if (d.messages.length < PAGE) S.done.add(k);
      d.messages.forEach((m) => { S.seen.add(m.id); upsert(list, m); });
      if (S.active === k) { renderThread(false); box.scrollTop = box.scrollHeight - before; }
    } catch { /* try again on the next scroll */ } finally { S.loadingOlder = false; }
  }

  // ------------------------------------------------------------ pictures and files
  const IMG_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp']);
  const isImage = (mime) => IMG_MIMES.has(String(mime || '').toLowerCase());
  const AUDIO_EXT = /\.(opus|ogg|oga|m4a|aac|mp3|wav|amr)$/i;
  const VIDEO_EXT = /\.(mp4|m4v|mov|webm|3gp)$/i;
  const kindOf = (f) => {
    const m = String(f.mime || '').toLowerCase();
    if (isImage(m)) return 'image';
    if (m.startsWith('audio/') || AUDIO_EXT.test(f.name || '')) return 'audio';
    if (m.startsWith('video/') || VIDEO_EXT.test(f.name || '')) return 'video';
    return 'file';
  };
  const blobMime = (f, kind) => {
    const n = String(f.name || '').toLowerCase();
    if (/\.(opus|ogg|oga)$/.test(n) || f.mime === 'audio/ogg') return 'audio/ogg; codecs=opus'; // WhatsApp voice notes
    if (/\.m4a$/.test(n)) return 'audio/mp4';
    return f.mime || (kind === 'audio' ? 'audio/mpeg' : 'video/mp4');
  };

  // voice notes and videos: downloaded when the play button is pressed, then played from a local blob.
  // Result: {url} | {altered:true} (a content filter replaced the file) | {gone:true}
  async function getBlobUrl(f, kind) {
    if (S.blobUrl.has(f.mediaId)) return { url: S.blobUrl.get(f.mediaId) };
    const r = await wab.media(f.mediaId, S.activeId, { sha256: f.sha256, size: f.size });
    if (r && r.altered) return { altered: true };
    if (!r || !r.ok) return { gone: true };
    const bin = atob(r.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: blobMime(f, kind) }));
    S.blobUrl.set(f.mediaId, url);
    while (S.blobUrl.size > 6) { const [k0, u0] = S.blobUrl.entries().next().value; URL.revokeObjectURL(u0); S.blobUrl.delete(k0); }
    return { url };
  }
  // the file was swapped on the way (a content filter such as NetFree checks it first): say so and let the user try again
  function filterBox(f, again) {
    return el('div', { class: 'pic-wait' }, el('div', { class: 'ico', text: '⏳' }),
      el('div', { text: 'מסנן התוכן (למשל נטפרי) עדיין בודק את הקובץ הזה. נסה שוב בעוד כמה דקות.' }),
      el('div', { class: 'sub', text: 'הוא נשלח אליך גם במייל.' }),
      el('button', { class: 'link', text: 'נסה שוב', on: { click: (e) => e.target.closest('.pic-wait').replaceWith(again()) } }));
  }
  function playerFailed(box, f, why) {
    box.replaceWith(fileChip(f, why));
  }
  function audioPlayer(f) {
    const label = el('span', { text: `🎤 הקלטה · ${fmtSize(f.size || 0)}` });
    const btn = el('button', { class: 'play', title: 'השמע', text: '▶' });
    const box = el('div', { class: 'player' }, btn, label);
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = '…';
      const res = await getBlobUrl(f, 'audio').catch(() => ({ gone: true }));
      if (res.altered) return box.replaceWith(filterBox(f, () => audioPlayer(f)));
      if (!res.url) return playerFailed(box, f, 'ההקלטה כבר לא שמורה בשרת');
      const a = el('audio', { controls: true, autoplay: true, src: res.url });
      a.addEventListener('error', () => playerFailed(box, f, 'אי אפשר להשמיע את הפורמט הזה כאן, אפשר לשמור'));
      box.replaceChildren(a);
    });
    return box;
  }
  function videoPlayer(f) {
    const box = el('div', { class: 'vbox', title: f.name }, el('div', { class: 'big', text: '▶' }), el('div', { class: 'sub', dir: 'auto', text: `🎥 ${f.name} · ${fmtSize(f.size || 0)}` }));
    box.addEventListener('click', async () => {
      box.querySelector('.big').textContent = '…';
      const res = await getBlobUrl(f, 'video').catch(() => ({ gone: true }));
      if (res.altered) return box.replaceWith(filterBox(f, () => videoPlayer(f)));
      if (!res.url) return playerFailed(box, f, 'הסרטון כבר לא שמור בשרת');
      const v = el('video', { class: 'vid', controls: true, autoplay: true, playsinline: true, src: res.url });
      v.addEventListener('error', () => playerFailed(v, f, 'אי אפשר להפעיל את הפורמט הזה כאן, אפשר לשמור'));
      box.replaceWith(v);
    }, { once: true });
    return box;
  }

  // downloads through the main process (this window has no network access); only REAL pictures are cached.
  // Result: {src} | {altered:true} (stand-in from a content filter) | {gone:true}
  function getMediaSrc(f) {
    const id = f.mediaId;
    if (S.mediaSrc.has(id)) return Promise.resolve({ src: S.mediaSrc.get(id) });
    if (!S.mediaPending.has(id)) {
      const p = wab.media(id, S.activeId, { sha256: f.sha256, size: f.size })
        .then((r) => (r && r.ok ? { src: `data:${r.mime || 'image/png'};base64,${r.data}` } : r && r.altered ? { altered: true } : { gone: true }))
        .catch(() => ({ gone: true }))
        .then((res) => {
          S.mediaPending.delete(id);
          if (res.src) { S.mediaSrc.set(id, res.src); if (S.mediaSrc.size > 60) S.mediaSrc.delete(S.mediaSrc.keys().next().value); }
          return res;
        });
      S.mediaPending.set(id, p);
    }
    return S.mediaPending.get(id);
  }

  function fileChip(f, note) {
    return el('div', { class: 'file' }, '📎 ', f.url && /^https?:\/\//.test(f.url) ? el('a', { href: f.url, target: '_blank', rel: 'noopener noreferrer', text: f.name }) : el('span', { dir: 'auto', text: f.name }),
      f.size ? ` (${fmtSize(f.size)})` : '', f.mediaId ? el('button', { class: 'link', style: 'margin-inline-start:8px', text: 'שמור', on: { click: () => saveFile(f) } }) : null,
      note ? el('div', { class: 'sub', text: note }) : null);
  }

  // After NetFree (or any filter) has checked a picture, the same address returns the real one: so a stand-in is never shown
  // as the picture; the app waits and asks again (20 s, 40 s, 80 s ... up to about 50 minutes), or when the user presses the button.
  const RETRY_MS = window.__wabRetryMs || [20000, 40000, 80000, 160000, 300000, 600000, 900000, 900000];
  function pictureBox(f) {
    const box = el('div', { class: 'picbox' }, el('img', { class: 'pic' + (/^STK-/i.test(f.name || '') ? ' sticker' : ''), alt: f.name }));
    const showImg = (src) => {
      const img = el('img', { class: 'pic' + (/^STK-/i.test(f.name || '') ? ' sticker' : ''), alt: f.name, title: f.name + ' (לחץ להגדלה)', src });
      img.addEventListener('click', () => lightbox(f, src));
      box.replaceChildren(img);
    };
    const waiting = (attempt) => {
      const last = attempt >= RETRY_MS.length;
      box.replaceChildren(el('div', { class: 'pic-wait' }, el('div', { class: 'ico', text: last ? '⚠' : '⏳' }),
        el('div', { text: last ? 'מסנן התוכן עדיין לא אישר את התמונה הזו.' : 'התמונה ממתינה לבדיקה של מסנן התוכן (למשל נטפרי). ננסה שוב אוטומטית.' }),
        el('div', { class: 'sub', text: 'היא נשלחה אליך גם במייל.' }),
        el('button', { class: 'link', text: 'נסה שוב עכשיו', on: { click: () => { clearTimeout(box._retry); load(0); } } })));
      if (!last) box._retry = setTimeout(() => { if (document.body.contains(box)) load(attempt + 1); }, RETRY_MS[attempt]);
    };
    const load = (attempt) => getMediaSrc(f).then((res) => {
      if (res.src) return showImg(res.src);
      if (res.altered) return waiting(attempt);
      box.replaceWith(fileChip(f, 'התמונה כבר לא שמורה בשרת'));
    });
    if (S.mediaSrc.has(f.mediaId)) showImg(S.mediaSrc.get(f.mediaId));
    else if (typeof IntersectionObserver === 'function') {
      const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { io.disconnect(); load(0); } }, { root: $('#thread') });
      setTimeout(() => io.observe(box), 0);
    } else load(0);
    return box;
  }

  function renderFile(f, m) {
    if (f.mediaId && kindOf(f) === 'audio') return audioPlayer(f);
    if (f.mediaId && kindOf(f) === 'video') return videoPlayer(f);
    if (f.mediaId && isImage(f.mime)) return pictureBox(f);
    if (f.mediaId) return fileChip(f);
    return fileChip(f, m.dir === 'in' && !f.url ? 'נשלח אליך במייל' : '');
  }

  function lightbox(f, src) {
    $('#lb-img').src = src;
    $('#lb-name').textContent = f.name;
    $('#lb-save').onclick = () => saveFile(f);
    show('#lightbox');
  }
  const closeLightbox = () => { show('#lightbox', false); $('#lb-img').removeAttribute('src'); };

  async function saveFile(f) {
    const r = await wab.saveMedia(f.mediaId, f.name, S.activeId, { sha256: f.sha256, size: f.size });
    if (r && r.ok && !r.canceled) toast('נשמר: ' + r.path);
    else if (r && !r.ok) toast('השמירה נכשלה: ' + r.error, 'error');
  }

  // ------------------------------------------------------------ sending
  async function sendMessage() {
    const k = S.active;
    if (!k) return;
    const c = S.convs.get(k), input = $('#input'), btn = $('#b-send');
    const text = input.value.trim();
    if (!text && !S.pendingFiles.length) return;
    btn.disabled = true;
    try {
      const d = await api('POST', '/api/desk/send', { type: c.type, name: c.name, text, files: S.pendingFiles.map(({ name, data }) => ({ name, data })) });
      input.value = '';
      S.drafts.delete(S.activeId + '|' + k);
      S.pendingFiles = [];
      renderChips();
      autoGrow();
      if (d.message) {
        S.seen.add(d.message.id);
        const list = S.msgs.get(k) || [];
        S.msgs.set(k, list);
        upsert(list, d.message);
        c.last = slim(d.message);
        c.lastAt = d.message.at;
      }
      renderList();
      renderThread(true);
      if (d.skipped && d.skipped.length) toast('לא נשלחו: ' + d.skipped.join('; '), 'error');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
      input.focus();
    }
  }

  async function resend(c, text) {
    try {
      const d = await api('POST', '/api/desk/send', { type: c.type, name: c.name, text });
      if (d.message) { S.seen.add(d.message.id); const list = S.msgs.get(key(c.type, c.name)) || []; upsert(list, d.message); renderThread(true); }
    } catch (e) { toast(e.message, 'error'); }
  }

  async function cancelMsg(m) {
    try {
      await api('POST', '/api/desk/cancel', { id: m.id });
      m.status = 'cancelled';
      renderThread(false);
    } catch (e) { toast(e.message, 'error'); }
  }

  function renderChips() {
    const box = $('#chips');
    box.classList.toggle('hidden', !S.pendingFiles.length);
    box.replaceChildren(...S.pendingFiles.map((f, i) => el('span', { class: 'chip' },
      isImage(f.mime) ? el('img', { class: 'thumb', alt: '', src: `data:${f.mime};base64,${f.data}` }) : null,
      `${f.name} (${fmtSize(f.size)})`, el('button', { title: 'הסר', text: '×', on: { click: () => { S.pendingFiles.splice(i, 1); renderChips(); } } }))));
  }

  // pictures / files can only go to a contact that has a phone number (the phone sends them through the number)
  function canSendFiles() {
    const c = S.convs.get(S.active);
    if (c && c.type === 'private' && c.phone) return true;
    toast('אפשר לשלוח תמונות וקבצים רק לאיש קשר עם מספר טלפון (לא לקבוצה, ולא לשיחה שהתחילה בוואטסאפ בלי מספר, כמו Meta AI)', 'error');
    return false;
  }

  // File objects from paste / drag and drop
  const readAsBase64 = (file) => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
  async function addFiles(fileList) {
    if (!canSendFiles()) return;
    const skipped = [];
    for (const file of [...fileList]) {
      if (S.pendingFiles.length >= 12) { skipped.push(file.name + ' (עד 12 קבצים בהודעה)'); continue; }
      if (file.size > 25 * 1024 * 1024) { skipped.push(file.name + ' (גדול מ-25MB)'); continue; }
      const mime = file.type || '';
      const t = new Date();
      const ext = (mime.split('/')[1] || 'png').replace('jpeg', 'jpg');
      const name = file.name && file.name !== 'image.png' ? file.name : `תמונה-${String(t.getHours()).padStart(2, '0')}${String(t.getMinutes()).padStart(2, '0')}${String(t.getSeconds()).padStart(2, '0')}.${ext}`;
      try { S.pendingFiles.push({ name, size: file.size, mime, data: await readAsBase64(file) }); } catch { skipped.push(name); }
    }
    renderChips();
    if (skipped.length) toast('לא צורפו: ' + skipped.join('; '), 'error');
    $('#input').focus();
  }

  async function attach() {
    if (!canSendFiles()) return;
    const r = await wab.pickFiles();
    if (r.skipped && r.skipped.length) toast('לא צורפו: ' + r.skipped.join('; '), 'error');
    S.pendingFiles.push(...r.files);
    S.pendingFiles = S.pendingFiles.slice(0, 12);
    renderChips();
  }

  function autoGrow() {
    const t = $('#input');
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 140) + 'px';
  }

  // ------------------------------------------------------------ dialogs
  function openDialog(...kids) {
    $('#dialog').replaceChildren(...kids);
    show('#modal');
    const first = $('#dialog input, #dialog textarea');
    if (first) first.focus();
  }
  function closeDialog() { show('#modal', false); $('#dialog').replaceChildren(); }
  const field = (label, input) => el('label', { class: 'dlg-field' }, label, input);

  function newChatDialog(tab = 'contact') {
    const tabs = el('div', { class: 'tabs' },
      el('button', { class: 'tab' + (tab === 'contact' ? ' on' : ''), text: 'איש קשר חדש', on: { click: () => newChatDialog('contact') } }),
      el('button', { class: 'tab' + (tab === 'group' ? ' on' : ''), text: 'קבוצה', on: { click: () => newChatDialog('group') } }));
    const err = el('div', { class: 'error hidden' });
    const fail = (m) => { err.textContent = m; err.classList.remove('hidden'); };
    const cancel = el('button', { class: 'secondary', text: 'ביטול', on: { click: closeDialog } });

    if (tab === 'group') {
      const name = el('input', { type: 'text', dir: 'auto' });
      const save = el('button', { class: 'primary', text: 'הוסף קבוצה', on: { click: async () => {
        try {
          const d = await api('POST', '/api/desk/groups', { name: name.value });
          await bootstrap(true);
          closeDialog();
          openConv(key('group', d.group.name));
        } catch (e) { fail(e.message); }
      } } });
      openDialog(el('h3', { text: 'שיחה חדשה' }), tabs,
        el('p', { class: 'hint', text: 'כתוב את שם הקבוצה בדיוק כפי שהוא מופיע בוואטסאפ. לקבוצה אפשר לשלוח טקסט בלבד.' }),
        field('שם הקבוצה', name), err, el('div', { class: 'dlg-actions' }, cancel, save));
      return;
    }
    const name = el('input', { type: 'text', dir: 'auto', placeholder: 'למשל: דוד כהן' });
    const phone = el('input', { type: 'tel', dir: 'ltr', placeholder: '050-1234567 או +972501234567' });
    const text = el('textarea', { rows: '3', dir: 'auto', placeholder: 'ההודעה הראשונה (אפשר להשאיר ריק ולשמור רק את איש הקשר)' });
    const save = el('button', { class: 'primary', text: 'שמור ושלח', on: { click: async () => {
      save.disabled = true;
      try {
        const d = await api('POST', '/api/desk/contacts', { name: name.value, phone: phone.value, text: text.value });
        await bootstrap(true);
        if (d.message) { S.seen.add(d.message.id); const k = key('private', d.contact.name); const list = S.msgs.get(k) || []; upsert(list, d.message); S.msgs.set(k, list); }
        closeDialog();
        openConv(key('private', d.contact.name));
        toast(d.message ? 'איש הקשר נשמר וההודעה נשלחה לתור' : 'איש הקשר נשמר');
      } catch (e) { fail(e.message); save.disabled = false; }
    } } });
    openDialog(el('h3', { text: 'שיחה חדשה' }), tabs,
      el('p', { class: 'hint', text: 'איש הקשר נשמר בשרת, וההודעה תישלח מהטלפון דרך וואטסאפ.' }),
      field('שם', name), field('מספר טלפון', phone), field('הודעה', text), err, el('div', { class: 'dlg-actions' }, cancel, save));
  }

  function updateText(u) {
    switch (u.status) {
      case 'checking': return 'בודק עדכונים…';
      case 'downloading': return `מוריד גרסה ${u.version} (${Math.round(u.percent)}%)`;
      case 'ready': return `גרסה ${u.version} מוכנה להתקנה`;
      case 'none': return 'הגרסה שלך עדכנית';
      case 'error': return 'שגיאת עדכון: ' + u.error;
      case 'dev': return 'מצב פיתוח (אין עדכונים)';
      default: return '—';
    }
  }

  function settingsDialog() {
    const s = S.info.settings;
    const mk = (labelText, k) => {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = !!s[k];
      cb.addEventListener('change', async () => { S.info.settings = await wab.setSettings({ [k]: cb.checked }); });
      return el('label', { class: 'toggle' }, el('span', { text: labelText }), cb);
    };
    const upd = el('div', { class: 'kv' }, el('span', { text: 'עדכונים' }), el('b', { id: 'upd-text', text: updateText(S.info.update) }));
    const checkBtn = el('button', { class: 'secondary', text: 'בדוק עדכונים', on: { click: () => wab.checkUpdate() } });
    const installBtn = el('button', { class: 'primary', id: 'upd-install', text: 'התקן והפעל מחדש', on: { click: () => wab.installUpdate() } });
    installBtn.classList.toggle('hidden', S.info.update.status !== 'ready');
    openDialog(el('h3', { text: 'הגדרות' }),
      el('p', { class: 'hint', style: 'margin:0', text: 'מספרים מחוברים' }),
      ...S.info.accounts.map((a) => el('div', { class: 'toggle' }, el('span', { text: a.label + (a.id === S.activeId ? ' (פעיל)' : '') }), el('button', { class: 'secondary', text: 'הסר מהמחשב', on: { click: () => removeAccount(a.id) } }))),
      el('div', { class: 'kv' }, el('span', { text: 'שרת' }), el('b', { text: S.info.serverUrl })),
      el('div', { class: 'kv' }, el('span', { text: 'גרסה' }), el('b', { text: S.info.version })),
      upd,
      mk('הפעל עם Windows (ברקע, ליד השעון)', 'autoStart'),
      mk('הצג תוכן הודעות בהתראות', 'showPreview'),
      mk('שמור עותק מקומי מוצפן להפעלה מהירה', 'localCache'),
      el('div', { class: 'toggle' }, el('span', { text: S.lock.enabled ? 'נעילה בקוד: פעילה' : 'נעילה בקוד: כבויה' }), el('button', { class: 'secondary', text: S.lock.enabled ? 'הגדרות נעילה…' : 'הפעל נעילה…', on: { click: lockDialog } })),
      el('p', { class: 'hint', text: `היסטוריית הצ'אט נשמרת בשרת ${S.retentionDays ? S.retentionDays + ' ימים' : 'עד 3000 הודעות'} (ניתן לשנות באזור האישי באתר). איש הקשר נשמר לצמיתות.` }),
      el('div', { class: 'dlg-actions' },
        el('button', { class: 'secondary', text: 'הוסף מספר', on: { click: () => { closeDialog(); showLogin('', { add: true }); } } }),
        checkBtn, installBtn, el('button', { class: 'primary', text: 'סגור', on: { click: closeDialog } })));
  }


  // ------------------------------------------------------------ several numbers (accounts)
  const acctUnread = (id) => (S.acctSummary[id] && S.acctSummary[id].unread) || 0;

  function renderAccountMenu() {
    const menu = $('#acct-menu');
    const items = S.info.accounts.map((a, i) => el('button', { class: 'acct', on: { click: () => { menu.classList.add('hidden'); switchAccount(a.id); } } },
      avatar({ type: 'private', name: a.label }, true),
      el('span', { class: 'nm' }, el('b', { text: a.label }), el('span', { class: 'sub', text: i < 9 ? 'Ctrl+' + (i + 1) : '' })),
      a.id === S.activeId ? el('span', { class: 'check', text: '✓' }) : acctUnread(a.id) ? el('span', { class: 'badge', text: String(acctUnread(a.id)) }) : null));
    menu.replaceChildren(...items, el('div', { class: 'acct-sep' }),
      el('button', { class: 'acct', on: { click: () => { menu.classList.add('hidden'); showLogin('', { add: true }); } } }, el('span', { text: '➕' }), el('span', { class: 'nm', text: 'הוסף מספר (קישור אישי)' })));
  }

  async function switchAccount(id) {
    if (!id || id === S.activeId || !S.info.accounts.some((a) => a.id === id)) return;
    if (S.active) S.drafts.set(S.activeId + '|' + S.active, $('#input').value);
    clearTimeout(S.cacheTimer);
    saveCache(); // keep what this number looked like, for its next instant start
    stopSync();
    S.info = await wab.switchAccount(id);
    await startSession();
  }

  // unread counts of the numbers that are not open (so a message to the other number is never missed)
  let othersTimer = null;
  async function pollOthers() {
    clearTimeout(othersTimer);
    if (!running) return;
    const gen = S.gen;
    for (const a of S.info.accounts) {
      if (a.id === S.activeId) continue;
      const r = await wab.call('GET', '/api/desk/summary', null, a.id).catch(() => ({ ok: false }));
      if (gen !== S.gen) return;
      if (!r.ok) continue;
      const known = S.acctSummary[a.id] && 'unread' in S.acctSummary[a.id];
      const prev = known ? S.acctSummary[a.id].unread : 0;
      S.acctSummary[a.id] = { unread: r.data.unread, phoneLastPollAt: r.data.phoneLastPollAt };
      if (known && r.data.unread > prev) wab.notify({ key: 'acct:' + a.id, title: a.label, body: 'הודעות חדשות במספר הזה' });
    }
    updateUnread();
    renderAccountMenu();
    othersTimer = setTimeout(pollOthers, 20000);
  }

  async function removeAccount(id) {
    const a = S.info.accounts.find((x) => x.id === id);
    if (!a || !confirm(`להסיר את "${a.label}" מהמחשב הזה?\nהחשבון עצמו נשאר בשרת, ואפשר להוסיף אותו שוב בקישור האישי.`)) return;
    const wasActive = id === S.activeId;
    S.info = await wab.logout(id);
    delete S.acctSummary[id];
    closeDialog();
    if (!S.info.accounts.length) { S.info.loggedIn = false; showLogin(); return; }
    if (wasActive) { stopSync(); await startSession(); } else renderAccountMenu();
  }

  // ------------------------------------------------------------ status report + message journey
  const fmtDur = (ms) => { const s = Math.round(ms / 1000); return s < 60 ? s + ' שנ׳' : s < 3600 ? Math.round(s / 60) + ' דק׳' : Math.round(s / 3600) + ' שע׳'; };
  const dlgClose = () => el('div', { class: 'dlg-actions' }, el('button', { class: 'primary', text: 'סגור', on: { click: closeDialog } }));

  async function statusDialog() {
    const body = el('p', { class: 'sub', text: 'בודק…' });
    openDialog(el('h3', { text: 'דוח מצב' }), body,
      el('div', { class: 'dlg-actions' }, el('button', { class: 'secondary', text: 'רענן', on: { click: statusDialog } }), el('button', { class: 'primary', text: 'סגור', on: { click: closeDialog } })));
    try {
      const d = await api('GET', '/api/desk/status');
      const kids = d.health.map((h) => el('div', { class: 'hl ' + h.level }, el('i'), el('span', { text: h.text })));
      if (d.recentFailures.length) {
        kids.push(el('p', { class: 'hint', style: 'margin-top:12px', text: 'כשלונות אחרונים:' }));
        for (const f of d.recentFailures) kids.push(el('div', { class: 'sub', dir: 'auto', text: `${new Date(f.at).toLocaleString('he-IL')} · ${f.target} · ${f.reason || 'סיבה לא ידועה'}` }));
      }
      kids.push(el('div', { class: 'note', text: d.note }));
      body.replaceWith(el('div', { id: 'status-body' }, ...kids));
    } catch (e) {
      body.replaceWith(el('div', { class: 'error', text: e.status === 404 ? 'השרת עוד לא עודכן לגרסה שתומכת בדוח מצב. נסה שוב בעוד כמה דקות.' : e.message }));
    }
  }

  async function journeyDialog(m) {
    const body = el('p', { class: 'sub', text: 'טוען…' });
    openDialog(el('h3', { text: 'איפה ההודעה?' }), el('p', { class: 'sub', dir: 'auto', text: (m.text || '').slice(0, 100) || '📎 קובץ' }), body, dlgClose());
    try {
      const d = await api('GET', '/api/desk/message/' + encodeURIComponent(m.id));
      body.replaceWith(el('div', {},
        el('div', { class: 'diag ' + d.diagnosis.level }, el('b', { text: d.diagnosis.title }), el('span', { text: d.diagnosis.text })),
        el('ul', { class: 'tl' }, ...d.timeline.map((st) => el('li', { class: st.key }, el('div', {}, el('div', { dir: 'auto', text: st.label }), el('span', { class: 'when', text: new Date(st.at).toLocaleString('he-IL') + (st.afterMs ? `   (+${fmtDur(st.afterMs)})` : '') })))))));
    } catch (e) {
      body.replaceWith(el('div', { class: 'error', text: e.status === 404 || e.status === 400 ? 'לא נמצאו פרטים להודעה הזו (ייתכן שנמחקה לפי תקופת השמירה, או שהשרת עוד לא עודכן).' : e.message }));
    }
  }

  // ------------------------------------------------------------ search (all chats) and find in this chat
  let searchTimer = null;
  async function runMsgSearch() {
    const q = S.search.trim();
    const gen = S.gen;
    try {
      const d = await api('GET', '/api/desk/search?q=' + encodeURIComponent(q));
      if (gen !== S.gen || q !== S.search.trim()) return;
      S.msgResults = d.results;
      renderList();
    } catch { /* the chat list search still works */ }
  }

  // makes sure message `id` is loaded (older pages are fetched when needed), scrolls to it and flashes it
  async function jumpToMessage(k, id) {
    for (let i = 0; i < 25; i++) {
      if ((S.msgs.get(k) || []).some((m) => m.id === id)) break;
      if (S.done.has(k) || S.active !== k) return false;
      await loadOlder();
    }
    renderThread(false);
    const node = $(`#thread [data-id="${id}"]`);
    if (!node) return false;
    node.scrollIntoView({ block: 'center' });
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 1800);
    return true;
  }
  async function openConvAt(k, id) {
    if (!S.convs.has(k)) return;
    if (S.active !== k) await openConv(k);
    await jumpToMessage(k, id);
  }

  function openFind() {
    if (!S.active) return;
    show('#findbar');
    $('#find-q').focus();
    $('#find-q').select();
  }
  function closeFind() {
    show('#findbar', false);
    S.find = { q: '', results: [], idx: -1 };
    $('#find-q').value = '';
    $('#find-count').textContent = '';
  }
  async function runFind() {
    const q = $('#find-q').value.trim();
    const c = S.convs.get(S.active);
    if (!c || q.length < 2) { S.find = { q, results: [], idx: -1 }; $('#find-count').textContent = ''; return; }
    try {
      const d = await api('GET', `/api/desk/search?q=${encodeURIComponent(q)}&type=${c.type}&name=${encodeURIComponent(c.name)}`);
      if (q !== $('#find-q').value.trim()) return;
      S.find = { q, results: d.results, idx: -1 };
      gotoFind(0);
    } catch (e) { $('#find-count').textContent = e.message; }
  }
  function gotoFind(i) {
    const n = S.find.results.length;
    if (!n) { $('#find-count').textContent = S.find.q.length >= 2 ? 'אין תוצאות' : ''; return; }
    S.find.idx = ((i % n) + n) % n; // results are newest first: "next" goes to older messages
    $('#find-count').textContent = `${S.find.idx + 1} מתוך ${n}`;
    jumpToMessage(S.active, S.find.results[S.find.idx].id);
  }

  // ------------------------------------------------------------ per-chat menu: pin, mute, archive, ignore, schedule, delete
  const closeCtx = () => show('#ctx', false);
  function openCtx(items, x, y) {
    const box = $('#ctx');
    box.replaceChildren(...items.map((it) => (it === '-' ? el('div', { class: 'sep' }) : el('button', { class: it.danger ? 'danger' : '', text: it.label, on: { click: () => { closeCtx(); it.run(); } } }))));
    show('#ctx');
    box.style.left = Math.max(6, Math.min(x, window.innerWidth - 250)) + 'px';
    box.style.top = Math.max(6, Math.min(y, window.innerHeight - box.offsetHeight - 10)) + 'px';
  }

  async function setPref(k, patch) {
    const c = S.convs.get(k);
    if (!c) return;
    try {
      const r = await api('POST', '/api/desk/conv/prefs', { type: c.type, name: c.name, ...patch });
      c.prefs = r.prefs;
      renderList();
      updateUnread();
      saveCacheSoon();
    } catch (e) { toast(e.message, 'error'); }
  }

  function convMenu(k, x, y) {
    const c = S.convs.get(k);
    if (!c) return;
    const p = c.prefs || {};
    const n = S.sched.filter((j) => j.type === c.type && j.target === c.name).length;
    openCtx([
      { label: p.pinned ? '📌 בטל הצמדה' : '📌 הצמד לראש הרשימה', run: () => setPref(k, { pinned: !p.pinned }) },
      { label: p.muted ? '🔔 בטל השתקה' : '🔕 השתק (בלי התראות)', run: () => setPref(k, { muted: !p.muted }) },
      { label: p.archived ? '📤 הוצא מהארכיון' : '🗄 העבר לארכיון', run: () => setPref(k, { archived: !p.archived }) },
      ...(n ? [{ label: `⏰ הודעות מתוזמנות (${n})`, run: () => { if (S.active !== k) openConv(k); scheduledDialog(k); } }] : []),
      '-',
      { label: p.ignore ? '✅ התחל לשמור הודעות מהשיחה' : '🚫 התעלם מהשיחה (לא לשמור ולא לשלוח מייל)', run: () => {
        if (!p.ignore && !confirm(`להתעלם מהשיחה "${c.name}"?\nהודעות חדשות ממנה לא יישמרו ולא יישלחו אליך במייל. אפשר לבטל בכל רגע מאותו תפריט.`)) return;
        setPref(k, { ignore: !p.ignore });
      } },
      { label: '🗑 מחק שיחה', danger: true, run: () => deleteConv(k) },
    ], x, y);
  }

  // ------------------------------------------------------------ scheduled messages
  async function refreshScheduled() {
    try { S.sched = (await api('GET', '/api/desk/scheduled')).jobs || []; } catch { /* an older server: no scheduling */ }
    updateSub();
  }
  function updateSub() {
    const c = S.convs.get(S.active);
    if (!c) return;
    const n = S.sched.filter((j) => j.type === c.type && j.target === c.name).length;
    $('#c-sub').textContent = S.baseSub + (n ? ` · ⏰ ${n} מתוזמנות` : '');
  }
  const fmtWhen = (t) => new Date(t).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' });
  const toLocalInput = (t) => { const d = new Date(t); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
  const atToday = (h, m, plusDays = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); d.setDate(d.getDate() + plusDays); return d.getTime(); };

  function scheduleDialog() {
    const c = S.convs.get(S.active);
    if (!c) return;
    const text = $('#input').value.trim();
    if (!text) { toast('כתוב קודם את ההודעה בתיבה, ואז לחץ ⏰', 'error'); return; }
    if (S.pendingFiles.length) { toast('אפשר לתזמן הודעת טקסט בלבד (בלי קבצים)', 'error'); return; }
    const err = el('div', { class: 'error hidden' });
    const when = el('input', { type: 'datetime-local', id: 'sched-when', value: toLocalInput(Date.now() + 3600 * 1000) });
    const go = async (at) => {
      try {
        await api('POST', '/api/desk/schedule', { type: c.type, name: c.name, text, at });
        $('#input').value = '';
        S.drafts.delete(S.activeId + '|' + S.active);
        autoGrow();
        closeDialog();
        toast('ההודעה תישלח ב-' + fmtWhen(at));
        refreshScheduled();
      } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
    };
    const eve = atToday(20, 0) > Date.now() + 60000 ? atToday(20, 0) : atToday(20, 0, 1);
    const quick = (label, at) => el('button', { type: 'button', text: label, on: { click: () => go(at) } });
    openDialog(el('h3', { text: `שליחה מאוחרת ל-${c.name}` }), el('p', { class: 'sub', dir: 'auto', text: text.length > 140 ? text.slice(0, 140) + '…' : text }),
      el('div', { class: 'sched-quick' }, quick('בעוד שעה', Date.now() + 3600 * 1000), quick(eve > atToday(20, 0) ? 'מחר ב-20:00' : 'הערב ב-20:00', eve), quick('מחר ב-08:00', atToday(8, 0, 1)), quick('מחר ב-12:00', atToday(12, 0, 1))),
      field('או בחר זמן', when), err,
      el('div', { class: 'dlg-actions' }, el('button', { class: 'secondary', text: 'ביטול', on: { click: closeDialog } }), el('button', { class: 'primary', text: 'תזמן', on: { click: () => go(new Date(when.value).getTime()) } })));
  }

  function scheduledDialog(k = S.active) {
    const c = S.convs.get(k);
    if (!c) return;
    const jobs = S.sched.filter((j) => j.type === c.type && j.target === c.name);
    openDialog(el('h3', { text: `הודעות מתוזמנות: ${c.name}` }),
      ...(jobs.length ? jobs.map((j) => el('div', { class: 'sched-row' }, el('div', { dir: 'auto', text: j.text }), el('div', { style: 'display:flex;flex-direction:column;gap:4px;align-items:flex-end' }, el('span', { class: 't', text: fmtWhen(j.at) }), el('button', { class: 'link', text: 'בטל', on: { click: async () => { try { await api('POST', '/api/desk/schedule/cancel', { id: j.id }); await refreshScheduled(); scheduledDialog(k); } catch (e) { toast(e.message, 'error'); } } } })))) : [el('p', { class: 'sub', text: 'אין הודעות מתוזמנות לשיחה הזו.' })]),
      el('div', { class: 'dlg-actions' }, el('button', { class: 'primary', text: 'סגור', on: { click: closeDialog } })));
  }

  // ------------------------------------------------------------ local copy for an instant start
  const CACHE_CONVS = 25;
  const CACHE_MSGS = 40;
  function saveCacheSoon() {
    clearTimeout(S.cacheTimer);
    S.cacheTimer = setTimeout(saveCache, 4000);
  }
  function saveCache() {
    if (!S.activeId || !S.info.settings.localCache || S.fromCache || !S.convs.size) return; // never overwrite the copy with an empty/unconfirmed state
    const convs = [...S.convs.entries()].sort((a, b) => (b[1].lastAt || 0) - (a[1].lastAt || 0));
    const msgs = {};
    for (const [k] of convs.slice(0, CACHE_CONVS)) { const l = S.msgs.get(k); if (l && l.length) msgs[k] = l.slice(-CACHE_MSGS); }
    Promise.resolve(wab.cacheSave(S.activeId, JSON.stringify({ v: 1, at: Date.now(), convs: convs.map(([, c]) => c), msgs }))).catch(() => {});
  }
  async function loadCache() {
    if (!S.info.settings.localCache) return false;
    let raw = null;
    try { raw = await wab.cacheLoad(S.activeId); } catch { return false; }
    if (!raw) return false;
    let d;
    try { d = JSON.parse(raw); } catch { return false; }
    if (!d || d.v !== 1 || !Array.isArray(d.convs)) return false;
    for (const c of d.convs) S.convs.set(key(c.type, c.name), c);
    for (const [k, list] of Object.entries(d.msgs || {})) { S.msgs.set(k, list); S.stale.add(k); list.forEach((m) => S.seen.add(m.id)); }
    return true;
  }

  // ------------------------------------------------------------ app lock
  let idleTimer = null;
  function resetIdle() {
    clearTimeout(idleTimer);
    const st = S.lock;
    if (!st || !st.enabled || st.locked || !running) return;
    idleTimer = setTimeout(() => wab.lockNow().then(applyLock), window.__wabIdleMs || st.minutes * 60000);
  }
  function applyLock(st) {
    S.lock = st || S.lock;
    const locked = !!(S.lock.enabled && S.lock.locked);
    show('#lock', locked);
    $('#app').classList.toggle('locked', locked);
    if (locked) {
      $('#lock-pin').value = '';
      show('#lock-err', false);
      closeDialog(); closeLightbox(); closeCtx();
      setTimeout(() => $('#lock-pin').focus(), 0);
    }
    resetIdle();
  }
  async function tryUnlock() {
    const pin = $('#lock-pin').value;
    if (!pin) return;
    const r = await wab.lockVerify(pin);
    if (r.ok) { applyLock(await wab.lockState()); return; }
    const err = $('#lock-err');
    err.textContent = r.waitMs > 0 ? `יותר מדי ניסיונות. נסה שוב בעוד ${Math.ceil(r.waitMs / 1000)} שניות` : 'קוד שגוי';
    show('#lock-err');
    $('#lock-pin').value = '';
    $('#lock-pin').focus();
  }
  async function forgotPin() {
    if (!confirm('לאפס את הקוד?\nכל המספרים ייצאו מהמחשב הזה ותצטרך להתחבר מחדש עם הקישור האישי והסיסמה. השיחות עצמן נשארות בשרת.')) return;
    S.info = await wab.lockReset();
    stopSync();
    applyLock(S.info.lock);
    S.info.loggedIn = false;
    showLogin('הקוד אופס. התחבר מחדש.');
  }

  function lockDialog() {
    const st = S.lock;
    const sel = el('select', { id: 'lock-min' }, ...[1, 5, 15, 30, 60].map((m) => el('option', { value: String(m), text: m === 60 ? 'שעה' : `${m} דקות` })));
    sel.value = String(st.minutes || 5);
    const hide = el('input', { type: 'checkbox', id: 'lock-hide' });
    hide.checked = st.onHide !== false;
    const err = el('div', { class: 'error hidden' });
    const fail = (m) => { err.textContent = m; err.classList.remove('hidden'); };
    const opts = [el('label', { class: 'toggle' }, el('span', { text: 'נעל אחרי חוסר פעילות של' }), sel), el('label', { class: 'toggle' }, el('span', { text: 'נעל גם כשסוגרים את החלון (נשאר ליד השעון) וכש-Windows ננעל' }), hide)];
    if (!st.enabled) {
      const p1 = el('input', { type: 'password', inputmode: 'numeric', maxlength: '12', dir: 'ltr', id: 'lock-p1' });
      const p2 = el('input', { type: 'password', inputmode: 'numeric', maxlength: '12', dir: 'ltr', id: 'lock-p2' });
      openDialog(el('h3', { text: 'נעילת האפליקציה בקוד' }), el('p', { class: 'hint', text: 'הקוד מסתיר את השיחות מפני מי שפותח את המחשב. הוא לא מחליף נעילה של Windows.' }),
        field('קוד (4 עד 12 ספרות)', p1), field('הקלד שוב', p2), ...opts, err,
        el('div', { class: 'dlg-actions' }, el('button', { class: 'secondary', text: 'ביטול', on: { click: closeDialog } }), el('button', { class: 'primary', text: 'הפעל נעילה', on: { click: async () => {
          if (p1.value !== p2.value) return fail('שני הקודים לא זהים');
          const r = await wab.lockSetup({ pin: p1.value, minutes: Number(sel.value), onHide: hide.checked });
          if (!r.ok) return fail(r.error);
          applyLock(r.lock); closeDialog(); toast('הנעילה הופעלה');
        } } })));
      return;
    }
    const pin = el('input', { type: 'password', inputmode: 'numeric', maxlength: '12', dir: 'ltr', id: 'lock-off-pin' });
    sel.addEventListener('change', async () => applyLock(await wab.lockUpdate({ minutes: Number(sel.value) })));
    hide.addEventListener('change', async () => applyLock(await wab.lockUpdate({ onHide: hide.checked })));
    openDialog(el('h3', { text: 'נעילת האפליקציה בקוד' }), ...opts, field('כדי לבטל את הנעילה הקלד את הקוד', pin), err,
      el('div', { class: 'dlg-actions' }, el('button', { class: 'secondary', text: 'בטל נעילה', on: { click: async () => {
        const r = await wab.lockDisable(pin.value);
        if (!r.ok) return fail(r.waitMs > 0 ? `יותר מדי ניסיונות, נסה בעוד ${Math.ceil(r.waitMs / 1000)} שניות` : 'קוד שגוי');
        applyLock(r.lock); closeDialog(); toast('הנעילה בוטלה');
      } } }), el('button', { class: 'primary', text: 'סגור', on: { click: closeDialog } })));
  }

  // ------------------------------------------------------------ wiring
  function onUpdate(u) {
    S.info.update = u;
    const f = $('#foot-update');
    f.classList.toggle('hidden', !(u.status === 'ready' || u.status === 'downloading'));
    f.textContent = u.status === 'ready' ? `⬇ התקן עדכון ${u.version}` : `מוריד עדכון… ${Math.round(u.percent)}%`;
    f.onclick = u.status === 'ready' ? () => wab.installUpdate() : null;
    const t = $('#upd-text');
    if (t) t.textContent = updateText(u);
    const b = $('#upd-install');
    if (b) b.classList.toggle('hidden', u.status !== 'ready');
  }

  async function deleteConv(k = S.active) {
    const c = S.convs.get(k);
    if (!c || !confirm(`למחוק את השיחה עם "${c.name}"?\nאיש הקשר וההודעות השמורות ימחקו מהשרת.`)) return;
    try {
      await api('POST', '/api/desk/conversations/delete', { type: c.type, name: c.name });
      S.convs.delete(k);
      S.msgs.delete(k);
      if (S.active === k) { S.active = null; show('#chat', false); show('#empty'); }
      renderList();
      updateUnread();
      saveCacheSoon();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function init() {
    S.info = await wab.info();
    $('#login-form').addEventListener('submit', doLogin);
    $('#b-new').addEventListener('click', () => newChatDialog());
    $('#b-new2').addEventListener('click', () => newChatDialog());
    $('#b-settings').addEventListener('click', settingsDialog);
    $('#b-del').addEventListener('click', () => deleteConv());
    $('#b-status').addEventListener('click', statusDialog);
    $('#filters').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; S.filter = b.dataset.f; renderList(); });
    $('#b-find').addEventListener('click', openFind);
    $('#find-close').addEventListener('click', closeFind);
    $('#find-next').addEventListener('click', () => gotoFind(S.find.idx + 1));
    $('#find-prev').addEventListener('click', () => gotoFind(S.find.idx - 1));
    let findTimer = null;
    $('#find-q').addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(runFind, 250); });
    $('#find-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); gotoFind(S.find.idx + (e.shiftKey ? -1 : 1)); } });
    $('#b-more').addEventListener('click', (e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); convMenu(S.active, r.left, r.bottom + 4); });
    $('#b-sched').addEventListener('click', scheduleDialog);
    document.addEventListener('click', closeCtx);
    $('#lock-go').addEventListener('click', tryUnlock);
    $('#lock-pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });
    $('#lock-forgot').addEventListener('click', forgotPin);
    let lastActivity = 0;
    for (const ev of ['mousemove', 'mousedown', 'keydown', 'wheel']) document.addEventListener(ev, () => { const t = Date.now(); if (t - lastActivity > 1000) { lastActivity = t; resetIdle(); } }, true);
    wab.onLock((st) => applyLock(st));
    $('#l-cancel').addEventListener('click', () => { show('#login', false); startSession(); });
    $('#me-btn').addEventListener('click', (e) => { e.stopPropagation(); renderAccountMenu(); $('#acct-menu').classList.toggle('hidden'); });
    document.addEventListener('click', (e) => { if (!$('#acct-menu').contains(e.target)) $('#acct-menu').classList.add('hidden'); });
    $('#b-send').addEventListener('click', sendMessage);
    $('#b-attach').addEventListener('click', attach);
    $('#search').addEventListener('input', (e) => {
      S.search = e.target.value;
      renderList();
      clearTimeout(searchTimer);
      if (S.search.trim().length >= 2) searchTimer = setTimeout(runMsgSearch, 300);
      else if (S.msgResults.length) { S.msgResults = []; renderList(); }
    });
    $('#thread').addEventListener('scroll', (e) => { if (e.target.scrollTop < 60) loadOlder(); });
    $('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeDialog(); });
    const emoji = $('#emoji');
    emoji.replaceChildren(...EMOJIS.map((ch) => el('button', { type: 'button', text: ch, on: { click: () => { const i = $('#input'); i.setRangeText(ch, i.selectionStart, i.selectionEnd, 'end'); i.focus(); autoGrow(); } } })));
    $('#b-emoji').addEventListener('click', (e) => { e.stopPropagation(); emoji.classList.toggle('hidden'); });
    document.addEventListener('click', (e) => { if (!emoji.contains(e.target)) emoji.classList.add('hidden'); });
    const input = $('#input');
    input.addEventListener('paste', (e) => {
      const files = [...((e.clipboardData && e.clipboardData.files) || [])];
      if (files.length) { e.preventDefault(); addFiles(files); }
    });
    const chat = $('#chat');
    let dragDepth = 0;
    chat.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files')) { dragDepth++; chat.classList.add('drop'); } });
    chat.addEventListener('dragover', (e) => e.preventDefault());
    chat.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) chat.classList.remove('drop'); });
    chat.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; chat.classList.remove('drop'); if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
    $('#lb-close').addEventListener('click', closeLightbox);
    $('#lightbox').addEventListener('mousedown', (e) => { if (e.target.id === 'lightbox') closeLightbox(); });
    input.addEventListener('input', autoGrow);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); } });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeLightbox(); closeDialog(); closeCtx(); if (!$('#findbar').classList.contains('hidden')) closeFind(); emoji.classList.add('hidden'); }
      if (e.ctrlKey && e.key.toLowerCase() === 'f' && running) { e.preventDefault(); openFind(); }
      if (e.ctrlKey && e.key.toLowerCase() === 'n' && S.info.loggedIn !== false && running) { e.preventDefault(); newChatDialog(); }
      if (e.ctrlKey && e.key.toLowerCase() === 'k' && running) { e.preventDefault(); $('#search').focus(); }
      if (e.ctrlKey && /^[1-9]$/.test(e.key) && running) { const a = S.info.accounts[Number(e.key) - 1]; if (a) { e.preventDefault(); switchAccount(a.id); } }
    });
    window.addEventListener('focus', () => {
      const c = S.convs.get(S.active);
      if (running) syncOnce();
      if (c && c.unread) { c.unread = 0; renderList(); updateUnread(); api('POST', '/api/desk/read', { type: c.type, name: c.name }).catch(() => {}); }
    });
    wab.onUpdate(onUpdate);
    wab.onSettings((s) => { S.info.settings = s; });
    wab.onOpenConv((k) => { if (k.startsWith('acct:')) switchAccount(k.slice(5)); else if (S.convs.has(k)) openConv(k); });
    wab.onAuthExpired(async ({ id } = {}) => {
      S.info = await wab.info();
      if (!S.info.accounts.length) { S.info.loggedIn = false; showLogin('ההתחברות פגה (ייתכן שהסיסמה הוחלפה). התחבר שוב.'); return; }
      if (id === S.activeId) { toast('ההתחברות למספר הזה פגה, עברת למספר אחר. אפשר להוסיף אותו שוב בקישור האישי.', 'error'); stopSync(); await startSession(); }
      else { delete S.acctSummary[id]; renderAccountMenu(); toast('ההתחברות לאחד המספרים פגה. הוסף אותו מחדש בקישור האישי.', 'error'); }
    });
    onUpdate(S.info.update);
    S.lock = S.info.lock || S.lock;
    applyLock(S.lock);
    if (S.info.loggedIn) startSession();
    else showLogin();
  }

  init().catch((e) => { document.body.textContent = 'שגיאה בטעינת האפליקציה: ' + e.message; });
})();
