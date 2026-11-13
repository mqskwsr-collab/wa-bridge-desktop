'use strict';
(() => {
  const wab = window.wab;
  const $ = (s, r = document) => r.querySelector(s);
  const PAGE = 60;
  const EMOJIS = ['😀', '😂', '🙂', '😉', '😍', '🥰', '😘', '😊', '🙏', '👍', '👏', '🎉', '❤️', '💪', '🤝', '😢', '😮', '🤔', '😅', '🙌', '✅', '❌', '⭐', '🔥', '🌹', '🎂', '🎁', '☕', '🍎', '🕯️', '📞', '📍'];

  const S = {
    info: null, convs: new Map(), msgs: new Map(), seen: new Set(), done: new Set(), drafts: new Map(),
    active: null, cursor: 0, phoneLastPollAt: 0, skew: 0, online: true, search: '', pendingFiles: [], loadingOlder: false, retentionDays: 30,
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
    const r = await wab.call(method, path, body);
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
  const TICK = { queued: ['🕓', 'ממתין לטלפון'], sent: ['✓', 'נשלח'], failed: ['⚠', 'השליחה נכשלה'], cancelled: ['✕', 'בוטל'] };
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
  function showLogin(message) {
    stopSync();
    S.active = null;
    show('#app', false);
    show('#login');
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
  }

  // ------------------------------------------------------------ session / sync
  let syncTimer = null, syncing = false, running = false;

  async function startSession() {
    running = true;
    show('#login', false);
    show('#app');
    $('#me-name').textContent = S.info.label || '';
    $('#me-avatar').textContent = initial({ type: 'private', name: S.info.label || '?' });
    $('#me-avatar').style.background = colorOf(S.info.label || '?');
    $('#foot-ver').textContent = 'גרסה ' + S.info.version;
    S.convs.clear(); S.msgs.clear(); S.seen.clear(); S.done.clear();
    try {
      await bootstrap(false);
    } catch (e) {
      if (e.status === 401) return;
      setOnline(false, e.message);
    }
    renderList();
    scheduleSync();
  }

  function stopSync() { running = false; clearTimeout(syncTimer); }

  async function bootstrap(keepCursor) {
    const d = await api('GET', '/api/desk/bootstrap');
    if (!keepCursor) S.cursor = d.cursor;
    S.phoneLastPollAt = d.phoneLastPollAt;
    S.skew = d.serverTime - Date.now();
    S.retentionDays = d.retentionDays;
    const fresh = new Map();
    for (const c of d.conversations) fresh.set(key(c.type, c.name), c);
    S.convs = fresh;
    setOnline(true);
    renderList();
    updateUnread();
    updateBanner();
  }

  function scheduleSync() {
    clearTimeout(syncTimer);
    if (!running) return;
    syncTimer = setTimeout(async () => { await syncOnce(); scheduleSync(); }, document.hasFocus() ? 2500 : 6000);
  }

  async function syncOnce() {
    if (syncing || !running) return;
    syncing = true;
    try {
      for (let i = 0; i < 5; i++) {
        const d = await api('GET', '/api/desk/sync?since=' + S.cursor);
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
    if (!S.online) { text = (S.offlineMsg || 'אין חיבור לשרת') + ' — מנסה שוב…'; bad = true; }
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
        else { c.unread = (c.unread || 0) + 1; wab.notify({ key: k, title: c.name, body: m.text || (m.files && m.files.length ? '📎 ' + m.files[0].name : '') }); }
      }
    }
    renderList();
    updateUnread();
    if (touchedActive) renderThread(false);
    if (unknown) bootstrap(true).catch(() => {});
  }

  function updateUnread() {
    let n = 0;
    for (const c of S.convs.values()) n += c.unread || 0;
    wab.setUnread(n);
    document.title = (n ? `(${n}) ` : '') + 'WA Bridge';
  }

  // ------------------------------------------------------------ conversation list
  function renderList() {
    const q = S.search.trim().toLowerCase();
    const items = [...S.convs.entries()]
      .filter(([, c]) => !q || c.name.toLowerCase().includes(q) || (c.phone || '').includes(q) || (c.last && c.last.text.toLowerCase().includes(q)))
      .sort((a, b) => (b[1].lastAt || 0) - (a[1].lastAt || 0) || a[1].name.localeCompare(b[1].name, 'he'));
    const list = $('#list');
    if (!items.length) {
      list.replaceChildren(el('div', { class: 'list-empty', text: q ? 'לא נמצאו שיחות' : 'אין עדיין שיחות. לחץ ✎ כדי להתחיל שיחה חדשה.' }));
      return;
    }
    list.replaceChildren(...items.map(([k, c]) => {
      const last = c.last;
      let preview = c.type === 'group' ? 'קבוצה' : c.phone ? '+' + c.phone : '';
      if (last) {
        const body = last.text || (last.files ? '📎 קובץ' : '');
        preview = (last.dir === 'out' ? (TICK[last.status] || TICK.queued)[0] + ' ' : '') + body;
      }
      return el('div', { class: 'conv' + (k === S.active ? ' active' : ''), 'data-key': k, on: { click: () => openConv(k) } },
        avatar(c),
        el('div', { class: 'conv-main' },
          el('div', { class: 'row1' }, el('span', { class: 'name', text: c.name }), el('span', { class: 'time' + (c.unread ? ' unread' : ''), text: listTime(c.lastAt) })),
          el('div', { class: 'row2' }, el('span', { class: 'preview', dir: 'auto', text: preview }), c.unread ? el('span', { class: 'badge', text: c.unread > 99 ? '99+' : String(c.unread) }) : null)));
    }));
  }

  // ------------------------------------------------------------ chat view
  async function openConv(k) {
    if (S.active) S.drafts.set(S.active, $('#input').value);
    S.active = k;
    S.pendingFiles = [];
    renderChips();
    const c = S.convs.get(k);
    if (!c) return;
    show('#empty', false);
    show('#chat');
    $('#c-avatar').replaceWith(Object.assign(avatar(c), { id: 'c-avatar' }));
    $('#c-name').textContent = c.name;
    $('#c-sub').textContent = c.type === 'group' ? 'קבוצה (הודעות טקסט בלבד)' : c.phone ? '+' + c.phone : 'ללא מספר טלפון (ניתן להשיב רק לשיחות שהתחילו בוואטסאפ)';
    $('#input').value = S.drafts.get(k) || '';
    autoGrow();
    renderList();
    if (!S.msgs.has(k)) {
      $('#thread').replaceChildren(el('div', { class: 'loading', text: 'טוען…' }));
      try {
        const d = await api('GET', `/api/desk/messages?type=${c.type}&name=${encodeURIComponent(c.name)}&limit=${PAGE}`);
        if (S.active !== k) return;
        S.msgs.set(k, d.messages);
        d.messages.forEach((m) => S.seen.add(m.id));
        if (d.messages.length < PAGE) S.done.add(k);
      } catch (e) {
        toast(e.message, 'error');
        return;
      }
    }
    renderThread(true);
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
      if (d !== day) { day = d; kids.push(el('div', { class: 'day', text: d })); }
      kids.push(renderMsg(m, c));
    }
    box.replaceChildren(...kids);
    if (toEnd || atBottom) box.scrollTop = box.scrollHeight;
  }

  function renderMsg(m, c) {
    const [tick, tickTitle] = TICK[m.status] || ['', ''];
    const meta = el('div', { class: 'meta' }, el('span', { text: hhmm(m.at) }));
    if (m.dir === 'out') meta.append(el('span', { class: 'tick ' + m.status, title: tickTitle, text: tick }));
    if (m.dir === 'out' && m.status === 'queued') meta.append(el('button', { text: 'בטל', on: { click: () => cancelMsg(m) } }));
    if (m.dir === 'out' && m.status === 'failed' && m.text && !(m.files || []).length) meta.append(el('button', { text: 'שלח שוב', on: { click: () => resend(c, m.text) } }));
    const files = (m.files || []).map((f) => el('div', { class: 'file' },
      '📎 ',
      f.url && /^https?:\/\//.test(f.url) ? el('a', { href: f.url, target: '_blank', rel: 'noopener noreferrer', text: f.name }) : el('span', { text: f.name }),
      f.size ? ` (${fmtSize(f.size)})` : '',
      m.dir === 'in' && !f.url ? el('div', { class: 'sub', text: 'נשלח אליך במייל' }) : null));
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
      S.drafts.delete(k);
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
    box.replaceChildren(...S.pendingFiles.map((f, i) => el('span', { class: 'chip' }, `${f.name} (${fmtSize(f.size)})`, el('button', { title: 'הסר', text: '×', on: { click: () => { S.pendingFiles.splice(i, 1); renderChips(); } } }))));
  }

  async function attach() {
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
      el('div', { class: 'kv' }, el('span', { text: 'חשבון' }), el('b', { text: S.info.label })),
      el('div', { class: 'kv' }, el('span', { text: 'שרת' }), el('b', { text: S.info.serverUrl })),
      el('div', { class: 'kv' }, el('span', { text: 'גרסה' }), el('b', { text: S.info.version })),
      upd,
      mk('הפעל עם Windows (ברקע, ליד השעון)', 'autoStart'),
      mk('הצג תוכן הודעות בהתראות', 'showPreview'),
      el('p', { class: 'hint', text: `היסטוריית הצ'אט נשמרת בשרת ${S.retentionDays ? S.retentionDays + ' ימים' : 'עד 3000 הודעות'} (ניתן לשנות באזור האישי באתר). איש הקשר נשמר לצמיתות.` }),
      el('div', { class: 'dlg-actions' },
        el('button', { class: 'secondary', text: 'התנתק', on: { click: async () => { if (!confirm('להתנתק מהחשבון במחשב הזה?')) return; await wab.logout(); closeDialog(); showLogin(); } } }),
        checkBtn, installBtn, el('button', { class: 'primary', text: 'סגור', on: { click: closeDialog } })));
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

  async function deleteConv() {
    const c = S.convs.get(S.active);
    if (!c || !confirm(`למחוק את השיחה עם "${c.name}"?\nאיש הקשר וההודעות השמורות ימחקו מהשרת.`)) return;
    try {
      await api('POST', '/api/desk/conversations/delete', { type: c.type, name: c.name });
      S.convs.delete(S.active);
      S.msgs.delete(S.active);
      S.active = null;
      show('#chat', false);
      show('#empty');
      renderList();
      updateUnread();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function init() {
    S.info = await wab.info();
    $('#login-form').addEventListener('submit', doLogin);
    $('#b-new').addEventListener('click', () => newChatDialog());
    $('#b-new2').addEventListener('click', () => newChatDialog());
    $('#b-settings').addEventListener('click', settingsDialog);
    $('#b-del').addEventListener('click', deleteConv);
    $('#b-send').addEventListener('click', sendMessage);
    $('#b-attach').addEventListener('click', attach);
    $('#search').addEventListener('input', (e) => { S.search = e.target.value; renderList(); });
    $('#thread').addEventListener('scroll', (e) => { if (e.target.scrollTop < 60) loadOlder(); });
    $('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeDialog(); });
    const emoji = $('#emoji');
    emoji.replaceChildren(...EMOJIS.map((ch) => el('button', { type: 'button', text: ch, on: { click: () => { const i = $('#input'); i.setRangeText(ch, i.selectionStart, i.selectionEnd, 'end'); i.focus(); autoGrow(); } } })));
    $('#b-emoji').addEventListener('click', (e) => { e.stopPropagation(); emoji.classList.toggle('hidden'); });
    document.addEventListener('click', (e) => { if (!emoji.contains(e.target)) emoji.classList.add('hidden'); });
    const input = $('#input');
    input.addEventListener('input', autoGrow);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); } });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeDialog(); emoji.classList.add('hidden'); }
      if (e.ctrlKey && e.key.toLowerCase() === 'n' && S.info.loggedIn !== false && running) { e.preventDefault(); newChatDialog(); }
      if (e.ctrlKey && e.key.toLowerCase() === 'k' && running) { e.preventDefault(); $('#search').focus(); }
    });
    window.addEventListener('focus', () => {
      const c = S.convs.get(S.active);
      if (running) syncOnce();
      if (c && c.unread) { c.unread = 0; renderList(); updateUnread(); api('POST', '/api/desk/read', { type: c.type, name: c.name }).catch(() => {}); }
    });
    wab.onUpdate(onUpdate);
    wab.onSettings((s) => { S.info.settings = s; });
    wab.onOpenConv((k) => { if (S.convs.has(k)) openConv(k); });
    wab.onAuthExpired(() => { S.info.loggedIn = false; showLogin('ההתחברות פגה (ייתכן שהסיסמה הוחלפה). התחבר שוב.'); });
    onUpdate(S.info.update);
    if (S.info.loggedIn) startSession();
    else showLogin();
  }

  init().catch((e) => { document.body.textContent = 'שגיאה בטעינת האפליקציה: ' + e.message; });
})();
