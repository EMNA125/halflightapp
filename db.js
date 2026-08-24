const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// By default the database file sits next to this script. On hosts whose
// filesystem resets on every redeploy (Render's free tier, for instance)
// you should mount a persistent disk/volume somewhere and point DB_PATH at
// a file inside it instead, e.g.  DB_PATH=/data/halflight.db
// See the README for which hosts actually support this on their free tier.
const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, 'halflight.db');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
console.log(`[halflight] using database file: ${dbPath}`);

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    anon_name TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  -- A "room" is created the moment someone confesses. It starts OPEN
  -- (participant_b IS NULL) and visible in the public Browse feed for
  -- everyone else to read and choose to join. It becomes a normal two-
  -- person room the moment someone joins it — either automatically
  -- (matching keywords) or manually (someone picked it from Browse).
  CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    participant_a TEXT NOT NULL,
    participant_b TEXT,
    created_at INTEGER NOT NULL,
    joined_at INTEGER,
    closed INTEGER NOT NULL DEFAULT 0,
    confession_a TEXT,
    confession_b TEXT,
    keywords_a TEXT,
    matched_keywords TEXT,
    match_type TEXT
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    text TEXT NOT NULL,
    time TEXT NOT NULL,
    ts INTEGER NOT NULL,
    is_admin_ghost INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (room_id) REFERENCES rooms(id)
  );

  CREATE TABLE IF NOT EXISTS room_reads (
    room_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    last_read_ts INTEGER NOT NULL,
    PRIMARY KEY (room_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS blocks (
    blocker_id TEXT NOT NULL,
    blocked_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id)
  );

  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    reporter_id TEXT NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id);
  CREATE INDEX IF NOT EXISTS idx_rooms_participants ON rooms(participant_a, participant_b);
  CREATE INDEX IF NOT EXISTS idx_rooms_open ON rooms(participant_b, closed);
`);

/* ---------------- Migrations for DBs created before this version ---------------- */
(function migrate() {
  const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!cols.includes('is_admin')) db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
  const dupes = db.prepare('SELECT anon_name FROM users GROUP BY anon_name HAVING COUNT(*) > 1').all();
  if (dupes.length === 0) db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_anon_name ON users(anon_name)');

  const msgCols = db.prepare("PRAGMA table_info(messages)").all().map(c => c.name);
  if (!msgCols.includes('is_admin_ghost')) db.exec('ALTER TABLE messages ADD COLUMN is_admin_ghost INTEGER NOT NULL DEFAULT 0');

  // rooms used to require participant_b NOT NULL and had no keywords_a /
  // joined_at / match_type columns. Confessions are now open rooms from
  // the moment they're posted (participant_b starts NULL), so the table
  // needs rebuilding if it still has the old NOT NULL constraint.
  const roomInfo = db.prepare("PRAGMA table_info(rooms)").all();
  const participantBCol = roomInfo.find(c => c.name === 'participant_b');
  const needsRebuild = participantBCol && participantBCol.notnull === 1;

  if (needsRebuild) {
    db.exec('ALTER TABLE rooms RENAME TO rooms_old');
    db.exec(`
      CREATE TABLE rooms (
        id TEXT PRIMARY KEY,
        participant_a TEXT NOT NULL,
        participant_b TEXT,
        created_at INTEGER NOT NULL,
        joined_at INTEGER,
        closed INTEGER NOT NULL DEFAULT 0,
        confession_a TEXT,
        confession_b TEXT,
        keywords_a TEXT,
        matched_keywords TEXT,
        match_type TEXT
      );
    `);
    db.exec(`
      INSERT INTO rooms (id, participant_a, participant_b, created_at, joined_at, closed, confession_a, confession_b, matched_keywords, match_type)
      SELECT id, participant_a, participant_b, created_at, created_at, closed, confession_a, confession_b, matched_keywords, 'auto' FROM rooms_old
    `);
    db.exec('DROP TABLE rooms_old');
    db.exec('CREATE INDEX IF NOT EXISTS idx_rooms_participants ON rooms(participant_a, participant_b)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_rooms_open ON rooms(participant_b, closed)');
  } else {
    // table already nullable — just make sure newer columns exist
    const names = roomInfo.map(c => c.name);
    if (!names.includes('keywords_a')) db.exec('ALTER TABLE rooms ADD COLUMN keywords_a TEXT');
    if (!names.includes('joined_at')) db.exec('ALTER TABLE rooms ADD COLUMN joined_at INTEGER');
    if (!names.includes('match_type')) db.exec('ALTER TABLE rooms ADD COLUMN match_type TEXT');
    if (!names.includes('confession_a')) db.exec('ALTER TABLE rooms ADD COLUMN confession_a TEXT');
    if (!names.includes('confession_b')) db.exec('ALTER TABLE rooms ADD COLUMN confession_b TEXT');
    if (!names.includes('matched_keywords')) db.exec('ALTER TABLE rooms ADD COLUMN matched_keywords TEXT');
  }

  // The old "pending" table (one row per confession still searching) is
  // fully replaced by open rooms now — a confession IS a room from the
  // start. If an old pending table exists, fold any leftover rows into
  // open rooms so nobody's in-flight confession just vanishes on upgrade.
  const hasPending = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pending'").get();
  if (hasPending) {
    const rows = db.prepare('SELECT * FROM pending').all();
    const ins = db.prepare(`
      INSERT INTO rooms (id, participant_a, created_at, closed, confession_a, keywords_a)
      VALUES (?, ?, ?, 0, ?, ?)
    `);
    rows.forEach(r => ins.run(r.id, r.user_id, r.ts, r.text, r.keywords));
    db.exec('DROP TABLE pending');
  }
})();

/* ---------------- Prepared statements ---------------- */
const stmts = {
  insertUser: db.prepare('INSERT INTO users (id, email, password_hash, anon_name, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  getUserByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  getUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
  getUserByAnonName: db.prepare('SELECT * FROM users WHERE anon_name = ? COLLATE NOCASE'),
  setAdmin: db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?'),

  // A confession creates an OPEN room: participant_b is NULL until someone
  // joins, either automatically (good keyword overlap) or manually (picked
  // from the public Browse feed).
  insertOpenRoom: db.prepare(`
    INSERT INTO rooms (id, participant_a, created_at, closed, confession_a, keywords_a)
    VALUES (?, ?, ?, 0, ?, ?)
  `),
  fillRoomAuto: db.prepare(`
    UPDATE rooms SET participant_b = ?, confession_b = ?, matched_keywords = ?, joined_at = ?, match_type = 'auto'
    WHERE id = ? AND participant_b IS NULL
  `),
  fillRoomManual: db.prepare(`
    UPDATE rooms SET participant_b = ?, joined_at = ?, match_type = 'manual'
    WHERE id = ? AND participant_b IS NULL
  `),
  getRoom: db.prepare('SELECT * FROM rooms WHERE id = ?'),
  closeRoom: db.prepare('UPDATE rooms SET closed = 1 WHERE id = ?'),
  reopenRoom: db.prepare('UPDATE rooms SET closed = 0 WHERE id = ?'),
  deleteOpenRoom: db.prepare('DELETE FROM rooms WHERE id = ? AND participant_a = ? AND participant_b IS NULL'),
  deleteStaleOpenRooms: db.prepare('DELETE FROM rooms WHERE participant_b IS NULL AND closed = 0 AND created_at < ?'),

  // Confessions of mine still waiting for someone (shown under "My Chats").
  openRoomsForUser: db.prepare(
    'SELECT * FROM rooms WHERE participant_a = ? AND participant_b IS NULL AND closed = 0 ORDER BY created_at DESC'
  ),
  // Other people's open confessions, candidates for auto-matching or browsing.
  openRoomsExcept: db.prepare(
    'SELECT * FROM rooms WHERE participant_b IS NULL AND closed = 0 AND participant_a != ? ORDER BY created_at DESC'
  ),
  openRoomById: db.prepare('SELECT * FROM rooms WHERE id = ? AND participant_b IS NULL AND closed = 0'),

  activeRoomsForUser: db.prepare(
    'SELECT * FROM rooms WHERE closed = 0 AND participant_b IS NOT NULL AND (participant_a = ? OR participant_b = ?) ORDER BY created_at DESC'
  ),
  allRoomsForUser: db.prepare(
    'SELECT * FROM rooms WHERE participant_b IS NOT NULL AND (participant_a = ? OR participant_b = ?) ORDER BY created_at DESC'
  ),
  allRooms: db.prepare('SELECT * FROM rooms WHERE participant_b IS NOT NULL ORDER BY created_at DESC'),

  insertMessage: db.prepare(
    'INSERT INTO messages (room_id, sender, sender_name, text, time, ts, is_admin_ghost) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ),
  messagesForRoom: db.prepare('SELECT * FROM messages WHERE room_id = ? ORDER BY id ASC'),
  lastMessageForRoom: db.prepare('SELECT * FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT 1'),
  messageCountForRoom: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE room_id = ?'),
  unreadCountForRoom: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE room_id = ? AND ts > ? AND sender != ?'),

  setLastRead: db.prepare(`
    INSERT INTO room_reads (room_id, user_id, last_read_ts) VALUES (?, ?, ?)
    ON CONFLICT(room_id, user_id) DO UPDATE SET last_read_ts = excluded.last_read_ts
  `),
  getLastRead: db.prepare('SELECT * FROM room_reads WHERE room_id = ? AND user_id = ?'),

  addBlock: db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)'),
  isBlocked: db.prepare(`
    SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
  `),

  insertReport: db.prepare('INSERT INTO reports (id, room_id, reporter_id, reason, created_at) VALUES (?, ?, ?, ?, ?)'),
  allReports: db.prepare('SELECT * FROM reports ORDER BY created_at DESC'),
};

function roomParticipants(room) {
  return [room.participant_a, room.participant_b].filter(Boolean);
}

module.exports = { db, stmts, roomParticipants };
