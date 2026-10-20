/* 晨读 · 账号与同步
   Logged out: does nothing except show a small 「登录」 entry (only if /api exists).
   Logged in: every reader key in localStorage (chendu:notes|tr|recall:<date>) is synced
   to the account. localStorage stays the working copy, so the page never waits on the
   network and edits made offline are kept: a key is "dirty" whenever its local value
   differs from the last value the server confirmed (kept in chendu:sync:meta), and dirty
   keys are pushed on the next successful sync. Writes are compare-and-swap on a
   per-key revision; on a conflict both sides are merged item by item (three-way, using
   the last synced copy as the base), so neither device's edits are dropped. */
(function(){
  var API = '/api';
  var META = 'chendu:sync:meta';
  var RE = /^chendu:(notes|tr|recall):(\d{4}-\d{2}-\d{2})$/;
  var FIELD = {notes:'notes', tr:'items', recall:'done'};
  var user = null, apiOk = false, status = 'idle', lastOk = 0, busy = null, again = false;
  var pushTimer = null, retryTimer = null, retryDelay = 5000;
  var hooks = []; // UI repaint callbacks

  /* ------------------------------------------------ storage helpers */
  function lsGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
  function lsSet(k, v){ try{ localStorage.setItem(k, v); return true; }catch(e){ return false; } }
  function lsDel(k){ try{ localStorage.removeItem(k); }catch(e){} }
  function parse(s){ try{ return s == null ? null : JSON.parse(s); }catch(e){ return null; } }
  function loadMeta(){ var m = parse(lsGet(META)); return m && m.docs ? m : {user:null, docs:{}}; }
  function saveMeta(m){ lsSet(META, JSON.stringify(m)); }
  function readLocal(k){ return parse(lsGet(k)); }
  function writeLocal(k, v){
    if(!lsSet(k, JSON.stringify(v))) return;
    try{ window.dispatchEvent(new CustomEvent('chendu:sync', {detail:{key:k}})); }catch(e){}
  }
  function localKeys(){
    var out = [];
    try{ for(var i = 0; i < localStorage.length; i++){ var k = localStorage.key(i); if(RE.test(k)) out.push(k); } }catch(e){}
    return out;
  }
  function kindOf(k){ var m = RE.exec(k); return m ? m[1] : null; }

  // Postgres jsonb reorders object keys, so compare with a canonical form.
  function canon(v){
    if(Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if(v && typeof v === 'object') return '{' + Object.keys(v).sort().map(function(k){ return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }
  function list(kind, v){
    var a = v && Array.isArray(v[FIELD[kind]]) ? v[FIELD[kind]] : [];
    return a.filter(function(x){ return kind === 'recall' ? typeof x === 'string' : x && typeof x === 'object'; });
  }
  // translations rewrite every item's `updated` on each save; ignore it when comparing
  function norm(kind, v){
    var a = list(kind, v);
    if(kind === 'tr') a = a.map(function(x){ return {i:x.i, key:x.key, text:x.text}; });
    return canon(a);
  }
  function eq(kind, a, b){ return norm(kind, a) === norm(kind, b); }
  function idOf(kind, x){ return kind === 'notes' ? 'n' + x.id : kind === 'tr' ? x.key + '\u0000' + x.i : x; }
  function same(kind, a, b){
    if(kind === 'tr') return (a.text || '') === (b.text || '');
    if(kind === 'recall') return true;
    return canon(a) === canon(b);
  }
  function both(kind, a, b){ // changed on both sides: keep everything
    if(kind === 'tr') return {i:a.i, key:a.key, text:(a.text || '') + '\n——\n' + (b.text || ''), updated:Math.max(a.updated || 0, b.updated || 0)};
    if(kind === 'notes'){
      var ta = a.updated || a.created || 0, tb = b.updated || b.created || 0;
      var w = ta >= tb ? a : b, l = w === a ? b : a, r = {};
      for(var k in w) r[k] = w[k];
      if((l.text || '').trim() && (l.text || '') !== (w.text || '')) r.text = (w.text || '') + '\n——\n' + l.text;
      return r;
    }
    return a;
  }
  function index(kind, arr){ var m = {}; arr.forEach(function(x){ m[idOf(kind, x)] = x; }); return m; }
  /** three-way merge of local L and server S against base B (last synced copy, may be null) */
  function merge(kind, L, S, B){
    var la = list(kind, L), sa = list(kind, S), bm = index(kind, list(kind, B)), sm = index(kind, sa);
    var out = [], seen = {};
    la.forEach(function(x){
      var id = idOf(kind, x); if(seen[id]) return; seen[id] = 1;
      var s = sm[id], b = bm[id];
      if(s !== undefined){
        if(same(kind, x, s)) out.push(x);
        else if(b !== undefined && same(kind, x, b)) out.push(s);
        else if(b !== undefined && same(kind, s, b)) out.push(x);
        else out.push(both(kind, x, s));
      } else if(!(b !== undefined && same(kind, x, b))) out.push(x); // else: deleted on the server
    });
    sa.forEach(function(s){
      var id = idOf(kind, s); if(seen[id]) return; seen[id] = 1;
      var b = bm[id];
      if(!(b !== undefined && same(kind, s, b))) out.push(s); // else: deleted on this device
    });
    var r = {v:1}; r[FIELD[kind]] = out; return r;
  }

  /* ------------------------------------------------ network */
  function api(method, path, body, opts){
    var init = {method:method, credentials:'same-origin', headers:{'Accept':'application/json'}};
    if(body !== undefined){ init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    if(opts && opts.keepalive) init.keepalive = true;
    return fetch(API + path, init).then(function(r){
      var ct = r.headers.get('content-type') || '';
      if(ct.indexOf('application/json') < 0) throw {status:r.status, nojson:true};
      return r.json().then(function(j){ if(!r.ok) throw {status:r.status, body:j}; return j; });
    });
  }
  function setStatus(s){ status = s; if(s === 'ok') lastOk = Date.now(); paint(); }

  function dirtyDocs(meta, keys){
    var out = [];
    (keys || localKeys()).forEach(function(k){
      var kind = kindOf(k); if(!kind) return;
      var L = readLocal(k); if(!L) return;
      var m = meta.docs[k];
      if(m && eq(kind, L, parse(m.base))) return;
      if(!m && !list(kind, L).length) return; // nothing worth creating
      out.push({key:k, value:L, baseRev:m ? m.rev : 0});
    });
    return out;
  }
  function setBase(meta, k, v, rev){ meta.docs[k] = {rev:rev, base:JSON.stringify(v)}; }

  // Apply server docs: merge into local, return what still has to be pushed.
  function reconcile(meta, serverDocs, keys){
    var push = [];
    keys.forEach(function(k){
      var kind = kindOf(k); if(!kind) return;
      var S = serverDocs[k], L = readLocal(k), m = meta.docs[k], B = m ? parse(m.base) : null;
      if(S){
        if(m && m.rev === S.rev){
          if(!L) writeLocal(k, S.value);
          else if(!eq(kind, L, B)) push.push({key:k, value:L, baseRev:S.rev});
          return;
        }
        var M = merge(kind, L, S.value, B);
        if(!L || !eq(kind, M, L)) writeLocal(k, M);
        if(eq(kind, M, S.value)) setBase(meta, k, S.value, S.rev);
        else push.push({key:k, value:M, baseRev:S.rev});
      } else if(L && (list(kind, L).length || m)){
        push.push({key:k, value:L, baseRev:0});
      }
    });
    return push;
  }

  function pushDocs(meta, docs, round){
    if(!docs.length) return Promise.resolve();
    var batches = [];
    for(var i = 0; i < docs.length; i += 50) batches.push(docs.slice(i, i + 50));
    return batches.reduce(function(p, batch){
      return p.then(function(){ return api('PUT', '/sync', {docs:batch}); }).then(function(r){
        var retry = [], conflicts = {};
        (r.results || []).forEach(function(x){
          var sent = batch.filter(function(d){ return d.key === x.key; })[0];
          if(x.ok){ setBase(meta, x.key, sent.value, x.rev); return; }
          if(x.conflict) conflicts[x.key] = x.value ? {value:x.value, rev:x.rev} : null;
        });
        var ck = Object.keys(conflicts);
        if(ck.length){
          var srv = {}; ck.forEach(function(k){ if(conflicts[k]) srv[k] = conflicts[k]; else delete meta.docs[k]; });
          retry = reconcile(meta, srv, ck);
        }
        saveMeta(meta);
        if(retry.length && round < 3) return pushDocs(meta, retry, round + 1);
      });
    }, Promise.resolve());
  }

  /** full = pull everything from the server and merge; otherwise only push local edits */
  function sync(full){
    if(!user) return Promise.resolve();
    if(busy){ again = again || (full ? 'full' : true); return busy; }
    clearTimeout(retryTimer);
    setStatus('syncing');
    var meta = loadMeta();
    var run = full
      ? api('GET', '/sync').then(function(r){
          var srv = {}; (r.docs || []).forEach(function(d){ if(RE.test(d.key)) srv[d.key] = {value:d.value, rev:d.rev}; });
          var keys = localKeys(); Object.keys(srv).forEach(function(k){ if(keys.indexOf(k) < 0) keys.push(k); });
          var push = reconcile(meta, srv, keys);
          saveMeta(meta);
          return pushDocs(meta, push, 0);
        })
      : pushDocs(meta, dirtyDocs(meta), 0);
    busy = run.then(function(){
      retryDelay = 5000;
      setStatus('ok');
    }, function(e){
      if(e && e.status === 401){ signedOut(); return; }
      setStatus(navigator.onLine === false ? 'offline' : 'error');
      retryTimer = setTimeout(function(){ sync(true); }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 5 * 60 * 1000);
    }).then(function(){
      busy = null;
      if(again){ var f = again === 'full'; again = false; return sync(f); }
    });
    return busy;
  }

  function touch(){
    if(!user) return;
    if(status !== 'syncing') setStatus('pending');
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function(){ sync(false); }, 1200);
  }
  // Best effort when the tab is closing; anything that does not make it is still dirty next time.
  function flushNow(){
    if(!user) return;
    var meta = loadMeta(), docs = dirtyDocs(meta);
    if(!docs.length) return;
    try{ api('PUT', '/sync', {docs:docs.slice(0, 50)}, {keepalive:true}).catch(function(){}); }catch(e){}
  }

  /* ------------------------------------------------ account actions */
  function signedIn(u, first){
    user = u;
    var meta = loadMeta();
    if(meta.user !== u.email){ meta = {user:u.email, docs:{}}; saveMeta(meta); } // first login on this browser: merge everything
    paint();
    return sync(true);
  }
  function signedOut(){ user = null; clearTimeout(pushTimer); clearTimeout(retryTimer); setStatus('idle'); }
  function clearLocal(){
    localKeys().forEach(function(k){ lsDel(k); try{ window.dispatchEvent(new CustomEvent('chendu:sync', {detail:{key:k}})); }catch(e){} });
    lsDel(META);
  }
  function logout(wipe){
    // push pending edits first so nothing is lost, then end the session
    return sync(false).catch(function(){}).then(function(){ return api('POST', '/auth/logout', {}); })
      .catch(function(){}).then(function(){ signedOut(); if(wipe) clearLocal(); });
  }

  /* ------------------------------------------------ UI */
  function el(tag, cls, text){ var e = document.createElement(tag); if(cls) e.className = cls; if(text != null) e.textContent = text; return e; }
  var pill = null, menu = null, modal = null, hintOrig = [];

  function statusText(){
    if(status === 'syncing') return '同步中…';
    if(status === 'pending') return '有改动，稍后同步';
    if(status === 'offline') return '离线中，改动已存在本机，联网后自动同步';
    if(status === 'error') return '同步失败，改动已存在本机，稍后自动重试';
    if(status === 'ok'){ var d = new Date(lastOk); return '已同步 · ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
    return '';
  }
  function paint(){
    if(!pill) return;
    pill.classList.toggle('in', !!user);
    pill.dataset.status = user ? status : '';
    if(user){
      pill.querySelector('.acct-label').textContent = user.email.split('@')[0];
      pill.querySelector('.acct-more').hidden = true;
      pill.setAttribute('aria-label', '账号：' + user.email + '，' + statusText());
      pill.title = user.email + ' · ' + statusText();
    } else {
      pill.querySelector('.acct-label').textContent = '登录';
      pill.querySelector('.acct-more').hidden = false;
      pill.setAttribute('aria-label', '登录或注册，同步笔记');
      pill.title = '登录后，笔记、翻译和回顾勾选会同步到你的账号';
      closeMenu();
    }
    if(menu){ menu.querySelector('.acct-email').textContent = user ? user.email : ''; menu.querySelector('.acct-st').textContent = statusText(); }
    paintHints();
    hooks.forEach(function(f){ try{ f(user, status); }catch(e){} });
  }
  function paintHints(){
    var mn = document.querySelector('.mynotes .hint'), rh = document.querySelector('.recall-hint');
    [[mn, '已登录：会同步到你的账号，换设备登录也能看到。'], [rh, null]].forEach(function(p, i){
      var n = p[0]; if(!n) return;
      if(hintOrig[i] == null) hintOrig[i] = n.textContent;
      if(!user){ n.textContent = hintOrig[i]; return; }
      n.textContent = p[1] || hintOrig[i].replace('勾选只存在这台浏览器里。', '勾选会同步到你的账号。');
    });
  }

  function mountPill(){
    var host = document.querySelector('header.top') || document.querySelector('header.masthead');
    if(!host) return;
    pill = el('button', 'acct'); pill.type = 'button';
    pill.appendChild(el('span', 'acct-dot')); pill.appendChild(el('span', 'acct-label')); pill.appendChild(el('span', 'acct-more', ' · 同步笔记'));
    host.appendChild(pill);
    pill.addEventListener('click', function(e){ e.stopPropagation(); if(user) toggleMenu(); else openModal('login'); });
    document.addEventListener('click', function(e){ if(menu && !menu.hidden && !menu.contains(e.target)) closeMenu(); });
    paint();
  }
  function toggleMenu(){
    if(!menu){
      menu = el('div', 'acct-menu'); menu.hidden = true;
      menu.appendChild(el('div', 'acct-email'));
      menu.appendChild(el('div', 'acct-st'));
      var now = el('button', 'acct-btn', '立即同步'); now.type = 'button';
      var out = el('button', 'acct-btn', '退出登录'); out.type = 'button';
      var wipe = el('button', 'acct-btn acct-danger', '退出并清除本机笔记'); wipe.type = 'button';
      var note = el('p', 'acct-note', '退出后，这台设备上的笔记还在，只是不再同步。在公共电脑上请选「退出并清除本机笔记」。');
      [now, out, wipe, note].forEach(function(b){ menu.appendChild(b); });
      now.addEventListener('click', function(){ sync(true); });
      out.addEventListener('click', function(){ closeMenu(); logout(false); });
      wipe.addEventListener('click', function(){
        if(confirm('退出登录，并删除这台设备上保存的笔记、翻译和勾选？\n（已同步到账号的内容不受影响，重新登录即可恢复。）')){ closeMenu(); logout(true); }
      });
      pill.parentNode.appendChild(menu);
    }
    if(menu.hidden){ menu.hidden = false; paint(); } else closeMenu();
  }
  function closeMenu(){ if(menu) menu.hidden = true; }

  function openModal(mode){
    if(!modal) buildModal();
    modal.hidden = false;
    setMode(mode);
    setTimeout(function(){ modal.querySelector('input[type=email]').focus(); }, 30);
  }
  function closeModal(){ if(modal) modal.hidden = true; }
  var mode = 'login';
  function setMode(m){
    mode = m;
    modal.querySelectorAll('.am-tab').forEach(function(t){ var on = t.dataset.mode === m; t.classList.toggle('on', on); t.setAttribute('aria-selected', on); });
    modal.querySelector('.am-submit').textContent = m === 'login' ? '登录' : '注册并登录';
    var pw = modal.querySelector('input[type=password]');
    pw.autocomplete = m === 'login' ? 'current-password' : 'new-password';
    pw.placeholder = m === 'login' ? '密码' : '设置密码（至少 8 位）';
    modal.querySelector('.am-err').textContent = '';
  }
  function buildModal(){
    modal = el('div', 'acct-modal'); modal.hidden = true;
    modal.innerHTML =
      '<div class="am-card" role="dialog" aria-modal="true" aria-labelledby="am-title">' +
        '<button type="button" class="am-x" aria-label="关闭">×</button>' +
        '<h2 id="am-title" class="hand-zh">登录晨读</h2>' +
        '<p class="am-sub">登录后，笔记、翻译和回顾勾选会同步到你的账号，换一台设备登录也能看到。这台设备上已有的内容会自动合并进去。</p>' +
        '<div class="am-tabs" role="tablist"><button type="button" class="am-tab" role="tab" data-mode="login">登录</button><button type="button" class="am-tab" role="tab" data-mode="register">注册</button></div>' +
        '<form class="am-form" novalidate>' +
          '<input type="email" name="email" required maxlength="254" placeholder="邮箱" autocomplete="email" aria-label="邮箱">' +
          '<input type="password" name="password" required minlength="8" maxlength="128" aria-label="密码">' +
          '<div class="am-err" role="alert"></div>' +
          '<button type="submit" class="am-submit">登录</button>' +
        '</form>' +
      '</div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', function(e){ if(e.target === modal || e.target.closest('.am-x')) closeModal(); });
    document.addEventListener('keydown', function(e){ if(e.key === 'Escape' && !modal.hidden) closeModal(); });
    modal.querySelectorAll('.am-tab').forEach(function(t){ t.addEventListener('click', function(){ setMode(t.dataset.mode); }); });
    var form = modal.querySelector('form'), err = modal.querySelector('.am-err'), btn = modal.querySelector('.am-submit');
    form.addEventListener('submit', function(e){
      e.preventDefault();
      var email = form.email.value.trim(), pw = form.password.value;
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)){ err.textContent = '请填写正确的邮箱'; return; }
      if(mode === 'register' && pw.length < 8){ err.textContent = '密码至少 8 位'; return; }
      if(!pw){ err.textContent = '请填写密码'; return; }
      err.textContent = ''; btn.disabled = true; btn.textContent = mode === 'login' ? '登录中…' : '注册中…';
      api('POST', '/auth/' + mode, {email:email, password:pw}).then(function(r){
        form.password.value = '';
        closeModal();
        signedIn(r.user, true);
        return '';
      }, function(x){
        return (x && x.body && x.body.message) || (navigator.onLine === false ? '现在没有网络' : '出错了，请稍后再试');
      }).then(function(msg){ btn.disabled = false; setMode(mode); err.textContent = msg; });
    });
  }

  /* ------------------------------------------------ boot */
  window.ChenduSync = {
    touch: touch,
    user: function(){ return user; },
    onChange: function(f){ hooks.push(f); },
    _merge: merge // exposed for tests
  };

  function boot(){
    if(location.protocol === 'file:') return;
    api('GET', '/auth/me').then(function(r){
      apiOk = true;
      mountPill();
      if(r.user) signedIn(r.user, false);
    }, function(){ /* no backend here (static hosting): stay exactly as before */ });
    window.addEventListener('online', function(){ if(user) sync(true); });
    document.addEventListener('visibilitychange', function(){
      if(!user) return;
      if(document.visibilityState === 'hidden') flushNow();
      else if(Date.now() - lastOk > 15000) sync(true);
    });
    window.addEventListener('pagehide', flushNow);
  }
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
