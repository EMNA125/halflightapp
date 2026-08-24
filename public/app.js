(function () {
  "use strict";

  /* ---------------- Theme ---------------- */
  const hour = new Date().getHours();
  if (hour >= 7 && hour < 19) document.body.classList.add('day');
  document.getElementById('themeToggle').addEventListener('click', () => {
    document.body.classList.toggle('day');
  });

  (function starfield() {
    const el = document.getElementById('stars');
    let html = '';
    for (let i = 0; i < 40; i++) {
      const top = Math.random() * 100, left = Math.random() * 100, delay = (Math.random() * 4).toFixed(2);
      html += `<div class="star" style="top:${top}%;left:${left}%;animation-delay:${delay}s;"></div>`;
    }
    el.innerHTML = html;
  })();

  function timeNow() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }
  function showError(containerId, message, retryFn) {
    const el = document.getElementById(containerId);
    el.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'error-box';
    box.innerHTML = `<span>${escapeHtml(message)}</span>`;
    if (retryFn) {
      const btn = document.createElement('button');
      btn.textContent = 'Retry';
      btn.addEventListener('click', retryFn);
      box.appendChild(btn);
    }
    el.appendChild(box);
  }
  function clearError(containerId) {
    document.getElementById(containerId).innerHTML = '';
  }
  function fmtDate(ts) {
    return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  const screens = ['landing', 'confess', 'browse', 'searching', 'chat', 'history', 'history-thread', 'admin', 'admin-thread', 'admin-reports'];
  let currentScreenName = 'landing';
  function show(name) {
    currentScreenName = name;
    screens.forEach(s => (document.getElementById('screen-' + s).hidden = s !== name));
  }

  let socket = null;
  let currentRoomId = null;
  let myAnonName = null;
  let myUserId = null;
  let iAmAdmin = false;

  // Multi-room / multi-search state, kept in sync with the server via
  // 'bootstrap' (on connect) and 'pending_update' (whenever it changes).
  let myPending = [];      // confessions still waiting for a match
  let myActiveRooms = [];  // rooms currently open (not ended)
  let manualJoinRoomId = null; // set right before we explicitly ask to join a room (click from My Chats), so the 'matched' handler knows to force-enter the chat even if we weren't on landing/confess/searching

  /* ---------------- Auth ---------------- */
  let authMode = 'signup';
  const tabSignup = document.getElementById('tabSignup');
  const tabLogin = document.getElementById('tabLogin');
  const authForm = document.getElementById('authForm');
  const authSubmit = document.getElementById('authSubmit');
  const authNote = document.getElementById('authNote');
  const authNameWrap = document.getElementById('authNameWrap');
  const authAnonName = document.getElementById('authAnonName');
  const authNameStatus = document.getElementById('authNameStatus');

  function setAuthMode(mode) {
    authMode = mode;
    tabSignup.classList.toggle('active', mode === 'signup');
    tabLogin.classList.toggle('active', mode === 'login');
    authSubmit.textContent = mode === 'signup' ? 'Create account' : 'Sign in';
    authNameWrap.hidden = mode !== 'signup';
    authAnonName.required = mode === 'signup';
    authNote.textContent = mode === 'signup'
      ? 'Your email is only ever used to sign you back in. Everyone else in Halflight sees the anonymous name you choose — never your email.'
      : 'Signing back in restores your anonymous name and reconnects you to any rooms you were in.';
    clearError('authError');
  }
  tabSignup.addEventListener('click', () => setAuthMode('signup'));
  tabLogin.addEventListener('click', () => setAuthMode('login'));
  setAuthMode('signup');

  /* Live availability check for the chosen anonymous name */
  let nameCheckT = null;
  authAnonName.addEventListener('input', () => {
    const val = authAnonName.value.trim();
    clearTimeout(nameCheckT);
    if (!val) { authNameStatus.textContent = ''; authNameStatus.className = 'name-status'; return; }
    authNameStatus.textContent = 'Checking…';
    authNameStatus.className = 'name-status checking';
    nameCheckT = setTimeout(async () => {
      try {
        const res = await fetch(`/api/check-name?name=${encodeURIComponent(val)}`);
        const data = await res.json();
        authNameStatus.textContent = data.available ? 'Name is free — nice.' : (data.error || 'That name is taken.');
        authNameStatus.className = 'name-status ' + (data.available ? 'ok' : 'bad');
      } catch (e) {
        authNameStatus.textContent = '';
        authNameStatus.className = 'name-status';
      }
    }, 350);
  });

  authForm.addEventListener('submit', async e => {
    e.preventDefault();
    clearError('authError');
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    const anonName = authAnonName.value.trim();
    if (authMode === 'signup' && !anonName) {
      showError('authError', 'Choose an anonymous display name.');
      return;
    }
    authSubmit.disabled = true;
    const originalText = authSubmit.textContent;
    authSubmit.textContent = 'Please wait…';
    try {
      const res = await fetch(`/api/${authMode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, anonName }),
      });
      const data = await res.json();
      if (!res.ok) {
        showError('authError', data.error || 'Something went wrong.');
        return;
      }
      myAnonName = data.anonName;
      myUserId = data.id;
      iAmAdmin = !!data.isAdmin;
      afterAuth();
    } catch (err) {
      showError('authError', "Couldn't reach the server. Check your connection and try again.");
    } finally {
      authSubmit.disabled = false;
      authSubmit.textContent = originalText;
    }
  });

  function afterAuth() {
    document.getElementById('myName').textContent = myAnonName;
    document.getElementById('adminBtn').hidden = !iAmAdmin;
    show('confess');
    connectSocket();
  }

  document.getElementById('signOutBtn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    if (socket) socket.disconnect();
    socket = null;
    location.reload();
  });

  /* ---------------- Boot: check existing session ---------------- */
  (async function boot() {
    try {
      const res = await fetch('/api/me');
      if (res.ok) {
        const data = await res.json();
        myAnonName = data.anonName;
        myUserId = data.id;
        iAmAdmin = !!data.isAdmin;
        afterAuth();
      }
    } catch (e) {
      /* not logged in / server unreachable, stay on landing */
    }
  })();

  /* ---------------- Browser notifications ----------------
     Purely additive: if the person grants permission, we surface a real
     OS/browser notification for matches and reconnect offers that happen
     while the tab isn't focused. Nothing changes if they never opt in. */
  const notifBtn = document.getElementById('notifBtn');
  function refreshNotifBtn() {
    if (!('Notification' in window)) { notifBtn.hidden = true; return; }
    notifBtn.classList.toggle('enabled', Notification.permission === 'granted');
    notifBtn.title = Notification.permission === 'granted'
      ? 'Notifications on'
      : 'Enable notifications for matches and reconnect requests';
  }
  refreshNotifBtn();
  notifBtn.addEventListener('click', async () => {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
      await Notification.requestPermission();
      refreshNotifBtn();
    }
  });
  function notifyIfAway(title, body) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (document.hasFocus()) return;
    try { new Notification(title, { body, icon: undefined }); } catch (e) { /* ignore */ }
  }

  /* ---------------- Socket setup ---------------- */
  function connectSocket() {
    socket = io();

    socket.on('connect_error', () => {
      showError('confessError', "Couldn't connect to the live server. Retrying…");
    });

    socket.on('auth_error', () => {
      show('landing');
    });

    // Sent once right after connecting: everything currently waiting or
    // open for this user, so "My Chats" and the badge counts are correct
    // without yanking anyone into a screen they didn't ask for.
    socket.on('bootstrap', ({ activeRooms, pending }) => {
      myActiveRooms = activeRooms || [];
      myPending = pending || [];
      refreshChatsBadge();
      if (myPending.length) {
        document.getElementById('stillSearchingBtn').hidden = false;
        currentSearchKeywords = myPending[0].keywords || [];
      }
    });

    socket.on('pending_update', ({ pending }) => {
      myPending = pending || [];
      document.getElementById('stillSearchingBtn').hidden = myPending.length === 0;
      if (myPending.length) currentSearchKeywords = myPending[0].keywords || [];
      refreshChatsBadge();
    });

    socket.on('searching', ({ id, keywords }) => {
      enterSearchingUI(id, keywords || []);
    });

    socket.on('confession_error', msg => {
      showError('confessError', msg);
      submitBtn.disabled = false;
      submitBtn.textContent = 'Release it';
    });

    socket.on('matched', ({ roomId, messages, partnerName }) => {
      const wasOnSearchScreen = currentScreenName === 'searching';
      // Only auto-jump into the new chat if the person wasn't already doing
      // something else (browsing history/admin, or mid another live chat) —
      // UNLESS they just explicitly clicked to open this exact room (e.g.
      // from My Chats), in which case we always take them into it.
      const explicitJoin = manualJoinRoomId === roomId;
      if (explicitJoin) manualJoinRoomId = null;
      const safeToAutoEnter = explicitJoin || ['landing', 'confess', 'searching'].includes(currentScreenName);

      if (!myActiveRooms.find(r => r.roomId === roomId)) {
        myActiveRooms.push({ roomId, partnerName });
      }
      refreshChatsBadge();
      notifyIfAway('New match on Halflight', `Matched with ${partnerName || 'someone'} — open the app to chat.`);

      if (safeToAutoEnter) {
        if (!wasOnSearchScreen) flashMatchToast(`Matched with ${partnerName || 'someone'} — opening your chat…`);
        enterChat(roomId, partnerName, messages || []);
      } else {
        flashMatchToast(`New match with ${partnerName || 'someone'} — find it under My Chats.`);
      }
    });

    socket.on('new_message', msg => {
      if (msg.roomId === currentRoomId && currentScreenName === 'chat') {
        if (msg.sender !== myUserId) document.getElementById('typingIndicator').hidden = true;
        appendMessage(msg);
      } else {
        flashMatchToast(`${msg.senderName}: ${msg.text.slice(0, 60)}`);
      }
    });

    socket.on('partner_typing', ({ roomId }) => {
      if (roomId !== currentRoomId || currentScreenName !== 'chat') return;
      const el = document.getElementById('typingIndicator');
      el.textContent = 'They\u2019re typing…';
      el.hidden = false;
      clearTimeout(el._t);
      el._t = setTimeout(() => { el.hidden = true; }, 2500);
    });

    socket.on('partner_left', () => {
      showError('chatError', 'The other person left this room.', null);
    });

    socket.on('reconnect_status', ({ status }) => {
      if (status === 'partner_offline') {
        showError('historyThreadError', "They're not online right now — try again when they might be around.");
      } else if (status === 'requested') {
        showError('historyThreadError', 'Request sent — waiting for them to accept…');
      } else if (status === 'declined') {
        showError('historyThreadError', 'They said not right now.');
      }
    });

    socket.on('reconnect_offer', ({ roomId, fromName }) => {
      pendingOffer = roomId;
      document.getElementById('reconnectToastText').textContent = `${fromName} wants to reconnect and pick up your old chat.`;
      document.getElementById('reconnectToast').hidden = false;
      notifyIfAway('Reconnect request', `${fromName} wants to pick up an old chat.`);
    });

    // Admin-only events (harmless no-ops for regular users, server never
    // sends these unless the socket's session user is an admin).
    socket.on('admin_room_joined', data => {
      renderAdminThread(data);
    });

    // Fired whenever the open-confessions pool changes anywhere (someone
    // posted, someone got matched, someone withdrew). Only worth acting on
    // if we're actually looking at the Browse list right now.
    socket.on('browse_changed', () => {
      if (currentScreenName === 'browse') loadBrowseList();
    });
  }

  /* ---------------- Reconnect offer toast ---------------- */
  let pendingOffer = null;
  document.getElementById('reconnectAccept').addEventListener('click', () => {
    if (socket && pendingOffer) socket.emit('reconnect_respond', { roomId: pendingOffer, accept: true });
    document.getElementById('reconnectToast').hidden = true;
    pendingOffer = null;
  });
  document.getElementById('reconnectDecline').addEventListener('click', () => {
    if (socket && pendingOffer) socket.emit('reconnect_respond', { roomId: pendingOffer, accept: false });
    document.getElementById('reconnectToast').hidden = true;
    pendingOffer = null;
  });

  /* ---------------- Match / activity toast ---------------- */
  let matchToastT = null;
  function flashMatchToast(text) {
    const el = document.getElementById('matchToast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(matchToastT);
    matchToastT = setTimeout(() => { el.hidden = true; }, 3500);
  }

  /* ---------------- "My Chats" badge ---------------- */
  function refreshChatsBadge() {
    const badge = document.getElementById('chatsBadge');
    const count = myPending.length + myActiveRooms.length;
    badge.textContent = count;
    badge.hidden = count === 0;
  }

  /* ---------------- Confess ---------------- */
  const confessText = document.getElementById('confessText');
  const charCount = document.getElementById('charCount');
  const livePreviewChips = document.getElementById('livePreviewChips');
  const submitBtn = document.getElementById('submitBtn');

  // Kept in sync with the server's keyword extraction: short meaningful
  // tokens (abbreviations/slang) count now, only true filler is dropped.
  const STOPWORDS = new Set((
    'a about above after again against all am an and any are as at be because been before being below between both but by can cannot could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just like me more most my myself no nor not of off on once only or other our ours ourselves out over own really same she should so some such than that the their theirs them themselves then there these they think thought this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves feel feeling know still even also ' +
    'an at in on to is it my me we us he be do if or so up no ok hi yo um uh am as by of ah oh'
  ).split(' '));
  function previewKeywords(text) {
    const words = (text.toLowerCase().match(/[a-z']+/g) || []).filter(w => w.length >= 2 && !STOPWORDS.has(w));
    const freq = {};
    words.forEach(w => (freq[w] = (freq[w] || 0) + 1));
    return Object.keys(freq).sort((a, b) => freq[b] - freq[a]).slice(0, 8);
  }

  let debounceT = null;
  confessText.addEventListener('input', () => {
    charCount.textContent = confessText.value.length;
    submitBtn.disabled = confessText.value.trim().length < 8;
    clearTimeout(debounceT);
    debounceT = setTimeout(() => {
      livePreviewChips.innerHTML = previewKeywords(confessText.value).map(k => `<span class="chip">${escapeHtml(k)}</span>`).join('');
    }, 300);
  });

  submitBtn.addEventListener('click', () => {
    clearError('confessError');
    const text = confessText.value.trim();
    if (text.length < 8 || !socket) return;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Releasing…';
    socket.emit('submit_confession', text);
    confessText.value = '';
    charCount.textContent = '0';
    livePreviewChips.innerHTML = '';
  });

  /* ---------------- Searching ---------------- */
  const orbitPath = document.getElementById('orbitPath');
  const youDot = document.getElementById('youDot');
  const themDot = document.getElementById('themDot');
  const searchKeywordChips = document.getElementById('searchKeywordChips');
  const searchingSub = document.getElementById('searchingSub');
  let orbitAngle = 0;
  let orbitAnimId = null;
  let searchStart = null;
  let currentSearchKeywords = [];
  let currentSearchRoomId = null;

  function animateOrbit() {
    const elapsed = (Date.now() - searchStart) / 1000;
    const radius = Math.max(30, 78 - elapsed * 1.2);
    orbitPath.style.width = orbitPath.style.height = radius * 2 + 'px';
    orbitAngle += 0.018;
    const yx = Math.cos(orbitAngle) * radius, yy = Math.sin(orbitAngle) * radius;
    const tx = Math.cos(orbitAngle + Math.PI) * radius, ty = Math.sin(orbitAngle + Math.PI) * radius;
    youDot.style.transform = `translate(${yx}px, ${yy}px)`;
    themDot.style.transform = `translate(${tx}px, ${ty}px)`;
    orbitAnimId = requestAnimationFrame(animateOrbit);

    if (elapsed > 20) {
      searchingSub.textContent = "Still listening. The moment someone else's words overlap with yours, you'll be moved into a room automatically.";
    }
  }

  function enterSearchingUI(id, keywords) {
    currentSearchKeywords = keywords;
    currentSearchRoomId = id;
    submitBtn.disabled = false;
    submitBtn.textContent = 'Release it';
    show('searching');
    clearError('searchError');
    searchStart = Date.now();
    searchingSub.textContent = "Your words are out there, and visible to browse — anyone can read it and choose to jump in. We're also comparing it against everyone else's, in case there's a strong match.";
    searchKeywordChips.innerHTML = keywords.slice(0, 8).map(k => `<span class="chip">${escapeHtml(k)}</span>`).join('');
    if (orbitAnimId) cancelAnimationFrame(orbitAnimId);
    animateOrbit();
  }

  document.getElementById('cancelSearch').addEventListener('click', () => {
    if (orbitAnimId) cancelAnimationFrame(orbitAnimId);
    if (socket && currentSearchRoomId) socket.emit('cancel_search', { id: currentSearchRoomId });
    currentSearchRoomId = null;
    document.getElementById('stillSearchingBtn').hidden = myPending.length <= 1;
    show('confess');
  });

  document.getElementById('browseWhileWaiting').addEventListener('click', () => {
    // Don't cancel the search — just step away from the orbit animation.
    // We keep listening for a match on the socket and pull you into the
    // chat automatically (or notify you) the moment one happens.
    if (orbitAnimId) cancelAnimationFrame(orbitAnimId);
    document.getElementById('stillSearchingBtn').hidden = false;
    show('browse');
    loadBrowseList();
  });

  document.getElementById('stillSearchingBtn').addEventListener('click', () => {
    if (!myPending.length) return;
    currentSearchRoomId = myPending[0].id;
    currentSearchKeywords = myPending[0].keywords || [];
    show('searching');
    searchStart = Date.now();
    searchKeywordChips.innerHTML = currentSearchKeywords.slice(0, 8).map(k => `<span class="chip">${escapeHtml(k)}</span>`).join('');
    if (orbitAnimId) cancelAnimationFrame(orbitAnimId);
    animateOrbit();
  });

  /* ---------------- Chat ---------------- */
  const thread = document.getElementById('thread');
  const msgInput = document.getElementById('msgInput');
  const sendBtn = document.getElementById('sendBtn');
  const chatSub = document.getElementById('chatSub');

  function enterChat(roomId, partnerName, messages) {
    if (orbitAnimId) cancelAnimationFrame(orbitAnimId);
    currentRoomId = roomId;
    document.getElementById('chatPartnerName').textContent = partnerName || 'Your match';
    chatSub.textContent = `Say what you want — it disappears when you leave.`;
    document.getElementById('reportPanel').hidden = true;
    document.getElementById('typingIndicator').hidden = true;
    show('chat');
    clearError('chatError');
    thread.innerHTML = `<div class="msg system">You're both here for a reason. Be kind.</div>`;
    messages.forEach(appendMessage);
    if (!myActiveRooms.find(r => r.roomId === roomId)) myActiveRooms.push({ roomId, partnerName });
    refreshChatsBadge();
  }

  function appendMessage(msg) {
    const div = document.createElement('div');
    const mine = msg.sender === myUserId;
    div.className = 'msg ' + (mine ? 'me' : 'them');
    const label = mine ? 'You' : (msg.senderName || 'Them');
    div.innerHTML = `<span class="msg-name">${escapeHtml(label)}</span>${escapeHtml(msg.text)}<span class="msg-time">${escapeHtml(msg.time || '')}</span>`;
    thread.appendChild(div);
    thread.scrollTop = thread.scrollHeight;
  }

  function sendMessage() {
    const text = msgInput.value.trim();
    if (!text || !socket || !currentRoomId) return;
    socket.emit('send_message', { roomId: currentRoomId, text });
    msgInput.value = '';
  }
  sendBtn.addEventListener('click', sendMessage);
  msgInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });

  let typingT = null;
  msgInput.addEventListener('input', () => {
    if (!socket || !currentRoomId) return;
    clearTimeout(typingT);
    typingT = setTimeout(() => socket.emit('typing', { roomId: currentRoomId }), 150);
  });

  document.getElementById('leaveChat').addEventListener('click', () => {
    if (socket && currentRoomId) socket.emit('leave_room', { roomId: currentRoomId });
    myActiveRooms = myActiveRooms.filter(r => r.roomId !== currentRoomId);
    refreshChatsBadge();
    currentRoomId = null;
    confessText.value = '';
    charCount.textContent = '0';
    livePreviewChips.innerHTML = '';
    submitBtn.disabled = true;
    show('confess');
  });

  /* ---------------- Report / block ---------------- */
  const reportPanel = document.getElementById('reportPanel');
  document.getElementById('reportBtn').addEventListener('click', () => {
    reportPanel.hidden = !reportPanel.hidden;
    document.getElementById('reportStatus').innerHTML = '';
  });
  document.getElementById('reportCancel').addEventListener('click', () => { reportPanel.hidden = true; });
  document.getElementById('reportSubmit').addEventListener('click', async () => {
    if (!currentRoomId) return;
    const reason = document.getElementById('reportReason').value.trim();
    const block = document.getElementById('reportBlockToo').checked;
    try {
      const res = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: currentRoomId, reason, block }),
      });
      if (!res.ok) throw new Error();
      document.getElementById('reportStatus').innerHTML = '<div class="error-box"><span>Report sent. Thank you.</span></div>';
      document.getElementById('reportReason').value = '';
      setTimeout(() => { reportPanel.hidden = true; }, 1400);
    } catch (e) {
      document.getElementById('reportStatus').innerHTML = '<div class="error-box"><span>Could not send the report. Try again.</span></div>';
    }
  });

  /* ---------------- Browse: open confessions anyone can join ---------------- */
  async function loadBrowseList() {
    clearError('browseError');
    const listEl = document.getElementById('browseList');
    listEl.innerHTML = '<div class="list-empty">Loading…</div>';
    try {
      const res = await fetch('/api/browse');
      const data = await res.json();
      if (!res.ok) { showError('browseError', data.error || 'Could not load open confessions.'); return; }
      listEl.innerHTML = '';
      if (!data.rooms.length) {
        listEl.innerHTML = '<div class="list-empty">Nothing open right now — be the first to say something, or check back soon.</div>';
        return;
      }
      data.rooms.forEach(r => {
        const item = document.createElement('div');
        item.className = 'list-item';
        item.style.cursor = 'default';
        item.innerHTML = `
          <div class="row1"><span class="name">${escapeHtml(r.posterName)}</span></div>
          <div class="preview" style="white-space:normal;">${escapeHtml(r.text)}</div>
          <div class="chips">${r.keywords.slice(0, 6).map(k => `<span class="chip">${escapeHtml(k)}</span>`).join('')}</div>
          <div class="meta">${fmtDate(r.createdAt)}</div>`;
        const joinBtn = document.createElement('button');
        joinBtn.className = 'btn btn-primary btn-block';
        joinBtn.style.marginTop = '6px';
        joinBtn.textContent = 'Join this conversation';
        joinBtn.addEventListener('click', () => {
          if (!socket) return;
          joinBtn.disabled = true;
          joinBtn.textContent = 'Joining…';
          manualJoinRoomId = r.roomId;
          socket.emit('browse_join', { roomId: r.roomId });
        });
        item.appendChild(joinBtn);
        listEl.appendChild(item);
      });
    } catch (e) {
      showError('browseError', "Couldn't reach the server. Try again.");
    }
  }

  document.getElementById('browseBtn').addEventListener('click', () => {
    show('browse');
    loadBrowseList();
  });
  document.getElementById('browseBack').addEventListener('click', () => show('confess'));

  /* ---------------- My Chats (pending searches + active/ended rooms) ---------------- */
  function renderThreadInto(containerId, messages, rightName) {
    const el = document.getElementById(containerId);
    el.innerHTML = '';
    messages.forEach(msg => {
      const div = document.createElement('div');
      div.className = 'msg ' + (msg.senderName === rightName ? 'me' : 'them');
      div.innerHTML = `<span class="msg-name">${escapeHtml(msg.senderName)}</span>${escapeHtml(msg.text)}<span class="msg-time">${escapeHtml(msg.time || '')}</span>`;
      el.appendChild(div);
    });
    el.scrollTop = el.scrollHeight;
  }

  let currentHistoryRoomId = null;

  function renderPendingList() {
    const wrap = document.getElementById('pendingList');
    const subhead = document.getElementById('pendingSubhead');
    wrap.innerHTML = '';
    subhead.hidden = myPending.length === 0;
    myPending.forEach(p => {
      const item = document.createElement('div');
      item.className = 'list-item';
      item.style.cursor = 'default';
      item.innerHTML = `
        <div class="row1">
          <span class="name">${escapeHtml(p.text.slice(0, 40))}${p.text.length > 40 ? '…' : ''}</span>
          <span class="badge searching">Searching</span>
        </div>
        <div class="chips">${p.keywords.slice(0, 6).map(k => `<span class="chip">${escapeHtml(k)}</span>`).join('')}</div>
        <div class="meta">${fmtDate(p.ts)}</div>`;
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn btn-ghost';
      cancelBtn.style.marginTop = '4px';
      cancelBtn.textContent = 'Stop looking for this one';
      cancelBtn.addEventListener('click', () => {
        if (socket) socket.emit('cancel_search', { id: p.id });
      });
      item.appendChild(cancelBtn);
      wrap.appendChild(item);
    });
  }

  async function loadHistoryList() {
    clearError('historyError');
    renderPendingList();
    const listEl = document.getElementById('historyList');
    listEl.innerHTML = '';
    try {
      const res = await fetch('/api/history');
      const data = await res.json();
      if (!res.ok) { showError('historyError', data.error || 'Could not load your chats.'); return; }
      if (!data.rooms.length) {
        listEl.innerHTML = '<div class="list-empty">No rooms yet — once you match with someone, it\'ll show up here.</div>';
        return;
      }
      data.rooms.forEach(r => {
        const item = document.createElement('div');
        item.className = 'list-item';
        item.innerHTML = `
          <div class="row1">
            <span class="name">${escapeHtml(r.partnerName)}${r.unreadCount ? '<span class="unread-dot"></span>' : ''}</span>
            <span class="badge ${r.closed ? 'closed' : 'open'}">${r.closed ? 'Ended' : 'Active'}</span>
          </div>
          <div class="preview">${r.lastMessagePreview ? escapeHtml(r.lastMessagePreview) : 'No messages yet'}</div>
          <div class="meta">${fmtDate(r.lastMessageAt)} · ${r.messageCount} message${r.messageCount === 1 ? '' : 's'}</div>`;
        item.addEventListener('click', () => openHistoryThread(r.roomId, r.closed));
        listEl.appendChild(item);
      });
    } catch (e) {
      showError('historyError', "Couldn't reach the server. Try again.");
    }
  }

  async function openHistoryThread(roomId, closed) {
    // Active rooms open straight into the live, interactive chat screen.
    if (!closed) {
      manualJoinRoomId = roomId;
      if (socket) socket.emit('join_room', { roomId });
      return;
    }
    show('history-thread');
    clearError('historyThreadError');
    document.getElementById('historyThread').innerHTML = '';
    document.getElementById('historyThreadName').textContent = '—';
    try {
      const res = await fetch('/api/history/' + encodeURIComponent(roomId));
      const data = await res.json();
      if (!res.ok) { showError('historyThreadError', data.error || 'Could not load this chat.'); return; }
      currentHistoryRoomId = roomId;
      document.getElementById('historyThreadName').textContent = data.partnerName;
      document.getElementById('historyThreadStatus').textContent = 'This room ended — you can ask to reopen it.';
      renderThreadInto('historyThread', data.messages, myAnonName);
      const reconnectBtn = document.getElementById('reconnectBtn');
      reconnectBtn.hidden = false;
      reconnectBtn.disabled = false;
      reconnectBtn.textContent = 'Ask to reconnect';
    } catch (e) {
      showError('historyThreadError', "Couldn't reach the server. Try again.");
    }
  }

  document.getElementById('reconnectBtn').addEventListener('click', () => {
    if (!socket || !currentHistoryRoomId) return;
    clearError('historyThreadError');
    document.getElementById('reconnectBtn').disabled = true;
    document.getElementById('reconnectBtn').textContent = 'Waiting for them…';
    socket.emit('reconnect_request', { roomId: currentHistoryRoomId });
  });

  document.getElementById('historyBtn').addEventListener('click', () => {
    show('history');
    loadHistoryList();
  });
  document.getElementById('historyBack').addEventListener('click', () => show('confess'));
  document.getElementById('historyThreadBack').addEventListener('click', () => show('history'));

  /* ---------------- Admin: view every room + join anonymously ---------------- */
  let currentAdminRoomId = null;

  async function loadAdminList() {
    clearError('adminError');
    const listEl = document.getElementById('adminList');
    listEl.innerHTML = '';
    try {
      const res = await fetch('/api/admin/rooms');
      const data = await res.json();
      if (!res.ok) { showError('adminError', data.error || 'Could not load rooms.'); return; }
      if (!data.rooms.length) {
        listEl.innerHTML = '<div class="list-empty">No rooms have been created yet.</div>';
        return;
      }
      data.rooms.forEach(r => {
        const item = document.createElement('div');
        item.className = 'list-item';
        item.innerHTML = `
          <div class="row1">
            <span class="name">${escapeHtml(r.participantA)} &harr; ${escapeHtml(r.participantB)}</span>
            <span class="badge ${r.closed ? 'closed' : 'open'}">${r.closed ? 'Ended' : 'Active'}</span>
          </div>
          <div class="meta">${fmtDate(r.lastMessageAt)} · ${r.messageCount} message${r.messageCount === 1 ? '' : 's'}</div>`;
        item.addEventListener('click', () => openAdminThread(r.roomId));
        listEl.appendChild(item);
      });
    } catch (e) {
      showError('adminError', "Couldn't reach the server. Try again.");
    }
  }

  async function openAdminThread(roomId) {
    show('admin-thread');
    document.getElementById('adminThread').innerHTML = '';
    document.getElementById('adminThreadName').textContent = '—';
    document.getElementById('adminConfessions').innerHTML = '';
    currentAdminRoomId = roomId;
    try {
      const res = await fetch('/api/admin/rooms/' + encodeURIComponent(roomId));
      const data = await res.json();
      if (!res.ok) return;
      renderAdminThread(data);
      // Also join the live socket room so the admin can send messages and
      // see new ones arrive in real time, under their own anonymous name.
      if (socket) socket.emit('admin_join_room', { roomId });
    } catch (e) { /* ignore */ }
  }

  function renderAdminThread(data) {
    if (data.roomId !== currentAdminRoomId) return;
    document.getElementById('adminThreadName').textContent = `${data.participantA} \u2194 ${data.participantB}`;
    const confEl = document.getElementById('adminConfessions');
    const confA = data.confessionA, confB = data.confessionB;
    const matchLabel = data.matchType === 'manual' ? 'Manually joined from Browse' : 'Auto-matched by keyword overlap';
    if (confA || confB) {
      confEl.innerHTML = `
        <div class="meta" style="margin-bottom:2px;">${escapeHtml(matchLabel)}</div>
        ${confA ? `<div class="conf-item"><span class="conf-label">${escapeHtml(data.participantA)}'s confession</span>${escapeHtml(confA)}</div>` : ''}
        ${confB ? `<div class="conf-item"><span class="conf-label">${escapeHtml(data.participantB)}'s confession</span>${escapeHtml(confB)}</div>` : ''}
        ${data.matchedKeywords && data.matchedKeywords.length ? `<div class="chips">${data.matchedKeywords.map(k => `<span class="chip">${escapeHtml(k)}</span>`).join('')}</div>` : ''}`;
    }
    renderThreadInto('adminThread', data.messages, data.participantA);
  }

  document.getElementById('adminSendBtn').addEventListener('click', () => {
    const input = document.getElementById('adminMsgInput');
    const text = input.value.trim();
    if (!text || !socket || !currentAdminRoomId) return;
    socket.emit('admin_send_message', { roomId: currentAdminRoomId, text });
    input.value = '';
  });
  document.getElementById('adminMsgInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('adminSendBtn').click();
  });

  async function loadAdminReports() {
    clearError('adminReportsError');
    const listEl = document.getElementById('adminReportsList');
    listEl.innerHTML = '';
    try {
      const res = await fetch('/api/admin/reports');
      const data = await res.json();
      if (!res.ok) { showError('adminReportsError', data.error || 'Could not load reports.'); return; }
      if (!data.reports.length) {
        listEl.innerHTML = '<div class="list-empty">No reports yet.</div>';
        return;
      }
      data.reports.forEach(r => {
        const item = document.createElement('div');
        item.className = 'list-item';
        item.innerHTML = `
          <div class="row1"><span class="name">Reported by ${escapeHtml(r.reporterName)}</span></div>
          <div class="preview">${r.reason ? escapeHtml(r.reason) : 'No reason given'}</div>
          <div class="meta">${fmtDate(r.createdAt)}</div>`;
        item.addEventListener('click', () => openAdminThread(r.roomId));
        listEl.appendChild(item);
      });
    } catch (e) {
      showError('adminReportsError', "Couldn't reach the server. Try again.");
    }
  }

  document.getElementById('adminBtn').addEventListener('click', () => {
    show('admin');
    loadAdminList();
  });
  document.getElementById('adminBack').addEventListener('click', () => show('confess'));
  document.getElementById('adminThreadBack').addEventListener('click', () => show('admin'));
  document.getElementById('adminReportsBtn').addEventListener('click', () => {
    show('admin-reports');
    loadAdminReports();
  });
  document.getElementById('adminReportsBack').addEventListener('click', () => show('admin'));
})();
