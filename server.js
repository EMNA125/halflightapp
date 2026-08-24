const express = require('express');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const { stmts, roomParticipants } = require('./db');

/* ---------------- Admins ----------------
   Anyone who signs up (or logs in) with an email in this list is flagged
   an admin and gets access to /api/admin/* routes. Set this in your
   environment before starting the server, e.g.:
     ADMIN_EMAILS=you@example.com,other@example.com npm start          */
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean);

function maybePromoteAdmin(user) {
  if (user && !user.is_admin && ADMIN_EMAILS.includes(user.email)) {
    stmts.setAdmin.run(user.id);
    user.is_admin = 1;
  }
  return user;
}

/* ---------------- Anonymous name rules ----------------
   Users now pick their own display name at signup. It's what everyone
   else in a chat room sees instead of their email. */
const NAME_RE = /^[a-zA-Z0-9 _-]{3,24}$/;
function validateAnonName(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return 'Choose a display name.';
  if (!NAME_RE.test(trimmed)) return 'Name must be 3-24 characters (letters, numbers, spaces, - or _ only).';
  return null;
}

/* ---------------- Keyword extraction ----------------
   Short, meaningful tokens (abbreviations, slang like "af", "rn", "jm")
   are kept — we only filter out true filler words, not anything under
   a fixed length. That was cutting good signal out of short confessions. */
const STOPWORDS = new Set((
  'a about above after again against all am an and any are as at be because been before being below between both ' +
  'but by can cannot could did do does doing down during each few for from further had has have having he her here ' +
  'hers herself him himself his how i if in into is it its itself just like me more most my myself no nor not of ' +
  'off on once only or other our ours ourselves out over own really same she should so some such than that the ' +
  'their theirs them themselves then there these they think thought this those through to too under until up very ' +
  'was we were what when where which while who whom why will with would you your yours yourself yourselves feel ' +
  'feeling know still even also ' +
  // short filler words we now additionally exclude now that the length
  // filter dropped from 3+ to 2+ characters
  'an at in on to is it my me we us he be do if or so up no ok hi yo um uh am as by of ah oh'
).split(' '));

function extractKeywords(text) {
  const words = (text.toLowerCase().match(/[a-z']+/g) || []).filter(w => w.length >= 2 && !STOPWORDS.has(w));
  const freq = {};
  words.forEach(w => (freq[w] = (freq[w] || 0) + 1));
  return Object.keys(freq).sort((a, b) => freq[b] - freq[a]).slice(0, 20);
}

/* ---------------- Express setup ---------------- */
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'halflight-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30, sameSite: 'lax' },
});
app.use(sessionMiddleware);

app.get('/api/check-name', (req, res) => {
  const name = (req.query.name || '').toString().trim();
  const err = validateAnonName(name);
  if (err) return res.json({ available: false, error: err });
  const taken = !!stmts.getUserByAnonName.get(name);
  res.json({ available: !taken, error: taken ? 'That name is already taken.' : null });
});

app.post('/api/signup', async (req, res) => {
  const { email, password, anonName } = req.body || {};
  const emailKey = (email || '').toLowerCase().trim();
  if (!emailKey || !emailKey.includes('@')) return res.status(400).json({ error: 'Enter a valid email.' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Password needs to be at least 6 characters.' });
  if (stmts.getUserByEmail.get(emailKey)) return res.status(400).json({ error: 'An account with that email already exists.' });

  const name = (anonName || '').trim();
  const nameErr = validateAnonName(name);
  if (nameErr) return res.status(400).json({ error: nameErr });
  if (stmts.getUserByAnonName.get(name)) return res.status(400).json({ error: 'That name is already taken — pick another.' });

  const hash = await bcrypt.hash(password, 10);
  const userId = uuidv4();
  const isAdmin = ADMIN_EMAILS.includes(emailKey) ? 1 : 0;
  stmts.insertUser.run(userId, emailKey, hash, name, isAdmin, Date.now());

  req.session.userId = userId;
  res.json({ ok: true, anonName: name, id: userId, isAdmin: !!isAdmin });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  const emailKey = (email || '').toLowerCase().trim();
  const user = stmts.getUserByEmail.get(emailKey);
  if (!user) return res.status(400).json({ error: 'No account with that email.' });
  const match = await bcrypt.compare(password || '', user.password_hash);
  if (!match) return res.status(400).json({ error: 'Incorrect password.' });
  maybePromoteAdmin(user);
  req.session.userId = user.id;
  res.json({ ok: true, anonName: user.anon_name, id: user.id, isAdmin: !!user.is_admin });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  const user = req.session.userId && stmts.getUserById.get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'not logged in' });
  maybePromoteAdmin(user);
  res.json({ anonName: user.anon_name, id: user.id, isAdmin: !!user.is_admin });
});

/* ---------------- Chat history ("My Chats") ----------------
   Every room a user has ever been part of, open or closed, so they can
   see past conversations after logging back in and optionally reconnect.
   A user can now be in many rooms at once, so this is a list, not a
   single "the" active room. */
app.get('/api/history', (req, res) => {
  const user = req.session.userId && stmts.getUserById.get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'not logged in' });

  const rooms = stmts.allRoomsForUser.all(user.id, user.id).map(room => {
    const partnerId = roomParticipants(room).find(p => p !== user.id);
    const partner = stmts.getUserById.get(partnerId);
    const last = stmts.lastMessageForRoom.get(room.id);
    const count = stmts.messageCountForRoom.get(room.id).n;
    const lastRead = stmts.getLastRead.get(room.id, user.id);
    const unread = stmts.unreadCountForRoom.get(room.id, lastRead ? lastRead.last_read_ts : 0, user.id).n;
    return {
      roomId: room.id,
      partnerName: partner ? partner.anon_name : 'Someone who left Halflight',
      partnerId,
      createdAt: room.created_at,
      closed: !!room.closed,
      messageCount: count,
      unreadCount: unread,
      lastMessageAt: last ? last.ts : room.created_at,
      lastMessagePreview: last ? last.text.slice(0, 80) : null,
    };
  });
  rooms.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  res.json({ rooms });
});

app.get('/api/history/:roomId', (req, res) => {
  const user = req.session.userId && stmts.getUserById.get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'not logged in' });
  const room = stmts.getRoom.get(req.params.roomId);
  if (!room || !roomParticipants(room).includes(user.id)) return res.status(404).json({ error: 'Room not found.' });
  const partnerId = roomParticipants(room).find(p => p !== user.id);
  const partner = stmts.getUserById.get(partnerId);
  stmts.setLastRead.run(room.id, user.id, Date.now());
  res.json({
    roomId: room.id,
    closed: !!room.closed,
    partnerName: partner ? partner.anon_name : 'Someone who left Halflight',
    messages: serializeMessages(room.id),
  });
});

app.post('/api/report', (req, res) => {
  const user = req.session.userId && stmts.getUserById.get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'not logged in' });
  const { roomId, reason, block } = req.body || {};
  const room = stmts.getRoom.get(roomId);
  if (!room || !roomParticipants(room).includes(user.id)) return res.status(404).json({ error: 'Room not found.' });
  stmts.insertReport.run(uuidv4(), roomId, user.id, (reason || '').toString().slice(0, 300), Date.now());
  if (block) {
    const partnerId = roomParticipants(room).find(p => p !== user.id);
    if (partnerId) stmts.addBlock.run(user.id, partnerId, Date.now());
  }
  res.json({ ok: true });
});

/* ---------------- Browse ----------------
   Every confession is an open room the moment it's posted. Anyone can
   browse the open ones and choose to join, rather than only relying on
   automatic keyword matching (which can leave someone waiting forever if
   nobody else happens to write something similar). */
app.get('/api/browse', (req, res) => {
  const user = req.session.userId && stmts.getUserById.get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'not logged in' });
  const rooms = stmts.openRoomsExcept.all(user.id)
    .filter(r => !stmts.isBlocked.get(user.id, r.participant_a, r.participant_a, user.id))
    .map(r => {
      const poster = stmts.getUserById.get(r.participant_a);
      return {
        roomId: r.id,
        posterName: poster ? poster.anon_name : 'Someone',
        text: r.confession_a,
        keywords: r.keywords_a ? JSON.parse(r.keywords_a) : [],
        createdAt: r.created_at,
      };
    });
  res.json({ rooms });
});

/* ---------------- Admin ----------------
   Read-only access to every room, including which confessions caused the
   match, plus the ability to quietly join a room and speak in it under
   their own anonymous name (which reveals nothing about being an admin,
   since anonymous names never do). */
function requireAdmin(req, res, next) {
  const user = req.session.userId && stmts.getUserById.get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'not logged in' });
  if (!user.is_admin) return res.status(403).json({ error: 'Admins only.' });
  req.adminUser = user;
  next();
}

app.get('/api/admin/rooms', requireAdmin, (req, res) => {
  const rooms = stmts.allRooms.all().map(room => {
    const [aId, bId] = roomParticipants(room);
    const a = stmts.getUserById.get(aId);
    const b = stmts.getUserById.get(bId);
    const last = stmts.lastMessageForRoom.get(room.id);
    return {
      roomId: room.id,
      participantA: a ? a.anon_name : aId,
      participantB: b ? b.anon_name : bId,
      createdAt: room.created_at,
      closed: !!room.closed,
      messageCount: stmts.messageCountForRoom.get(room.id).n,
      lastMessageAt: last ? last.ts : room.created_at,
    };
  });
  res.json({ rooms });
});

app.get('/api/admin/rooms/:roomId', requireAdmin, (req, res) => {
  const room = stmts.getRoom.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found.' });
  const [aId, bId] = roomParticipants(room);
  const a = stmts.getUserById.get(aId);
  const b = stmts.getUserById.get(bId);
  res.json({
    roomId: room.id,
    closed: !!room.closed,
    participantA: a ? a.anon_name : aId,
    participantB: b ? b.anon_name : bId,
    confessionA: room.confession_a,
    confessionB: room.confession_b,
    matchedKeywords: room.matched_keywords ? JSON.parse(room.matched_keywords) : [],
    matchType: room.match_type || 'auto',
    messages: serializeMessages(room.id),
  });
});

app.get('/api/admin/reports', requireAdmin, (req, res) => {
  const reports = stmts.allReports.all().map(r => {
    const reporter = stmts.getUserById.get(r.reporter_id);
    return {
      id: r.id,
      roomId: r.room_id,
      reporterName: reporter ? reporter.anon_name : 'Unknown',
      reason: r.reason,
      createdAt: r.created_at,
    };
  });
  res.json({ reports });
});

const server = http.createServer(app);
const io = new Server(server);

// share the express session with socket.io
io.engine.use(sessionMiddleware);

const onlineSockets = {}; // userId -> socketId
const STALE_OPEN_ROOM_MS = 1000 * 60 * 60 * 6; // confessions open longer than 6h with nobody home are auto-cleared

setInterval(() => {
  stmts.deleteStaleOpenRooms.run(Date.now() - STALE_OPEN_ROOM_MS);
}, 1000 * 60 * 30);

function getPartnerName(room, userId) {
  const otherId = roomParticipants(room).find(p => p !== userId);
  const other = otherId && stmts.getUserById.get(otherId);
  return other ? other.anon_name : 'Someone';
}

function serializeMessages(roomId) {
  return stmts.messagesForRoom.all(roomId).map(m => ({
    sender: m.sender,
    senderName: m.sender_name,
    text: m.text,
    time: m.time,
    ts: m.ts,
  }));
}

// Confessions of mine that are still open, waiting for someone to join
// (either automatically via a good keyword match, or manually from Browse).
function pendingSummary(userId) {
  return stmts.openRoomsForUser.all(userId).map(r => ({
    id: r.id,
    text: r.confession_a,
    keywords: r.keywords_a ? JSON.parse(r.keywords_a) : [],
    ts: r.created_at,
  }));
}

function activeRoomSummary(userId) {
  return stmts.activeRoomsForUser.all(userId, userId).map(room => ({
    roomId: room.id,
    partnerName: getPartnerName(room, userId),
  }));
}

io.on('connection', socket => {
  const sess = socket.request.session;
  const userId = sess && sess.userId;
  const user = userId && stmts.getUserById.get(userId);

  if (!user) {
    socket.emit('auth_error', 'Not logged in.');
    socket.disconnect(true);
    return;
  }

  onlineSockets[userId] = socket.id;

  // Rejoin every active room silently (no auto-navigation — the client
  // just uses this to populate "My Chats" and badge counts) and report
  // any confessions still waiting for a match.
  const rooms = stmts.activeRoomsForUser.all(userId, userId);
  rooms.forEach(room => socket.join(room.id));
  socket.emit('bootstrap', {
    activeRooms: activeRoomSummary(userId),
    pending: pendingSummary(userId),
  });

  socket.on('submit_confession', text => {
    text = (text || '').toString().trim().slice(0, 600);
    if (text.length < 8) return socket.emit('confession_error', 'Say a little more first.');

    const keywords = extractKeywords(text);

    // Every confession becomes its own open room immediately, visible to
    // everyone else in Browse. As a bonus, if it overlaps strongly with
    // someone else's already-open confession, we pair the two of you up
    // automatically instead of making you both wait.
    const candidates = stmts.openRoomsExcept.all(userId)
      .filter(c => !stmts.isBlocked.get(userId, c.participant_a, c.participant_a, userId));

    let matched = null;
    let bestScore = 0;
    let bestSharedKeywords = [];
    for (const cand of candidates) {
      const candKeywords = cand.keywords_a ? JSON.parse(cand.keywords_a) : [];
      const shared = candKeywords.filter(k => keywords.includes(k));
      if (shared.length > bestScore) {
        bestScore = shared.length;
        matched = cand;
        bestSharedKeywords = shared;
      }
    }

    // Require at least 2 shared keywords for an automatic pairing — a
    // single overlapping word is often coincidence. Weaker overlaps just
    // stay open for people to find by browsing instead.
    if (matched && bestScore >= 2) {
      stmts.fillRoomAuto.run(userId, text, JSON.stringify(bestSharedKeywords), Date.now(), matched.id);
      socket.join(matched.id);
      const matchedUser = stmts.getUserById.get(matched.participant_a);
      socket.emit('matched', { roomId: matched.id, messages: [], partnerName: matchedUser.anon_name });

      const otherSocketId = onlineSockets[matched.participant_a];
      if (otherSocketId) {
        const otherSocket = io.sockets.sockets.get(otherSocketId);
        if (otherSocket) {
          otherSocket.join(matched.id);
          otherSocket.emit('matched', { roomId: matched.id, messages: [], partnerName: user.anon_name });
          otherSocket.emit('pending_update', { pending: pendingSummary(matched.participant_a) });
        }
      }
      io.emit('browse_changed');
    } else {
      const roomId = uuidv4();
      stmts.insertOpenRoom.run(roomId, userId, Date.now(), text, JSON.stringify(keywords));
      socket.join(roomId);
      socket.emit('searching', { id: roomId, keywords });
      socket.emit('pending_update', { pending: pendingSummary(userId) });
      io.emit('browse_changed');
    }
  });

  socket.on('cancel_search', ({ id } = {}) => {
    if (id) stmts.deleteOpenRoom.run(id, userId);
    socket.emit('pending_update', { pending: pendingSummary(userId) });
    io.emit('browse_changed');
  });

  // Pick an open confession straight out of the public Browse feed,
  // instead of waiting on a keyword match.
  socket.on('browse_join', ({ roomId }) => {
    const room = stmts.openRoomById.get(roomId);
    if (!room || room.participant_a === userId) return;
    if (stmts.isBlocked.get(userId, room.participant_a, room.participant_a, userId)) return;
    stmts.fillRoomManual.run(userId, Date.now(), roomId);
    socket.join(roomId);
    const poster = stmts.getUserById.get(room.participant_a);
    socket.emit('matched', { roomId, messages: [], partnerName: poster.anon_name });
    const posterSocketId = onlineSockets[room.participant_a];
    if (posterSocketId) {
      const posterSocket = io.sockets.sockets.get(posterSocketId);
      if (posterSocket) {
        posterSocket.join(roomId);
        posterSocket.emit('matched', { roomId, messages: [], partnerName: user.anon_name });
        posterSocket.emit('pending_update', { pending: pendingSummary(room.participant_a) });
      }
    }
    io.emit('browse_changed');
  });

  // Rejoin a room you're already a participant in (e.g. opening an active
  // chat from "My Chats" rather than fresh off a match).
  socket.on('join_room', ({ roomId }) => {
    const room = stmts.getRoom.get(roomId);
    if (!room || room.closed || !roomParticipants(room).includes(userId)) return;
    socket.join(roomId);
    stmts.setLastRead.run(roomId, userId, Date.now());
    socket.emit('matched', { roomId, messages: serializeMessages(roomId), partnerName: getPartnerName(room, userId) });
  });

  socket.on('send_message', ({ roomId, text }) => {
    text = (text || '').toString().trim().slice(0, 500);
    const room = stmts.getRoom.get(roomId);
    if (!room || room.closed || !text || !roomParticipants(room).includes(userId)) return;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const ts = Date.now();
    stmts.insertMessage.run(roomId, userId, user.anon_name, text, time, ts, 0);
    stmts.setLastRead.run(roomId, userId, ts);
    io.to(roomId).emit('new_message', { roomId, sender: userId, senderName: user.anon_name, text, time, ts });
  });

  socket.on('typing', ({ roomId }) => {
    const room = stmts.getRoom.get(roomId);
    if (!room || room.closed || !roomParticipants(room).includes(userId)) return;
    socket.to(roomId).emit('partner_typing', { roomId, name: user.anon_name });
  });

  socket.on('leave_room', ({ roomId }) => {
    const room = stmts.getRoom.get(roomId);
    if (room) {
      stmts.closeRoom.run(roomId);
      io.to(roomId).emit('partner_left');
    }
    socket.leave(roomId);
  });

  /* ---------------- Reconnecting with a past chat partner ---------------- */
  socket.on('reconnect_request', ({ roomId }) => {
    const room = stmts.getRoom.get(roomId);
    if (!room || !roomParticipants(room).includes(userId)) return;
    const partnerId = roomParticipants(room).find(p => p !== userId);
    const partnerSocketId = onlineSockets[partnerId];
    const partnerSocket = partnerSocketId && io.sockets.sockets.get(partnerSocketId);
    if (!partnerSocket) {
      socket.emit('reconnect_status', { roomId, status: 'partner_offline' });
      return;
    }
    socket.emit('reconnect_status', { roomId, status: 'requested' });
    partnerSocket.emit('reconnect_offer', { roomId, fromName: user.anon_name });
  });

  socket.on('reconnect_respond', ({ roomId, accept }) => {
    const room = stmts.getRoom.get(roomId);
    if (!room || !roomParticipants(room).includes(userId)) return;
    const partnerId = roomParticipants(room).find(p => p !== userId);
    const partnerSocketId = onlineSockets[partnerId];
    const partnerSocket = partnerSocketId && io.sockets.sockets.get(partnerSocketId);

    if (!accept) {
      if (partnerSocket) partnerSocket.emit('reconnect_status', { roomId, status: 'declined' });
      return;
    }

    stmts.reopenRoom.run(roomId);
    socket.join(roomId);
    socket.emit('matched', { roomId, messages: serializeMessages(roomId), partnerName: getPartnerName(room, userId) });
    if (partnerSocket) {
      partnerSocket.join(roomId);
      partnerSocket.emit('matched', { roomId, messages: serializeMessages(roomId), partnerName: getPartnerName(room, partnerId) });
    }
  });

  /* ---------------- Admin: quietly join a room and speak in it ----------------
     The admin's messages use their own anonymous name, exactly like any
     other user's — there is nothing in the room that marks them as staff. */
  socket.on('admin_join_room', ({ roomId }) => {
    if (!user.is_admin) return;
    const room = stmts.getRoom.get(roomId);
    if (!room) return;
    socket.join(roomId);
    const [aId, bId] = roomParticipants(room);
    const a = stmts.getUserById.get(aId);
    const b = stmts.getUserById.get(bId);
    socket.emit('admin_room_joined', {
      roomId,
      participantA: a ? a.anon_name : aId,
      participantB: b ? b.anon_name : bId,
      confessionA: room.confession_a,
      confessionB: room.confession_b,
      matchedKeywords: room.matched_keywords ? JSON.parse(room.matched_keywords) : [],
      matchType: room.match_type || 'auto',
      messages: serializeMessages(roomId),
    });
  });

  socket.on('admin_send_message', ({ roomId, text }) => {
    if (!user.is_admin) return;
    text = (text || '').toString().trim().slice(0, 500);
    const room = stmts.getRoom.get(roomId);
    if (!room || !text) return;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const ts = Date.now();
    stmts.insertMessage.run(roomId, userId, user.anon_name, text, time, ts, 1);
    io.to(roomId).emit('new_message', { roomId, sender: userId, senderName: user.anon_name, text, time, ts });
  });

  socket.on('disconnect', () => {
    if (onlineSockets[userId] === socket.id) delete onlineSockets[userId];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Halflight running on http://localhost:${PORT}`));
