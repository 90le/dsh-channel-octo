import { randomUUID } from 'node:crypto'
import { mkdirSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export class Store {
  constructor(dir, identity) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stat = lstatSync(dir)
    if (!stat.isDirectory() || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
      throw new Error('state_directory_must_be_private')
    }
    // Separate SQLite writer lock: OS releases it even on process termination.
    this.lease = new DatabaseSync(join(dir, 'worker.sqlite'))
    try {
      this.lease.exec('BEGIN IMMEDIATE')
      this.db = new DatabaseSync(join(dir, 'channel.sqlite'))
      this.db.exec(`
        PRAGMA busy_timeout = 2000;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS conversations (
          sender TEXT PRIMARY KEY, session_id TEXT NOT NULL, created INTEGER NOT NULL DEFAULT 0, last_ms INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS conversation_history (
          sender TEXT NOT NULL, session_id TEXT PRIMARY KEY, last_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS card_bindings (
          message_id TEXT PRIMARY KEY, binding TEXT NOT NULL, expires_ms INTEGER NOT NULL, claimed INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS jobs (
          seq INTEGER PRIMARY KEY, message_id TEXT NOT NULL UNIQUE, event_id TEXT NOT NULL,
          sender TEXT NOT NULL, input TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued',
          reply TEXT, result_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
          next_ms INTEGER NOT NULL DEFAULT 0, issue TEXT
        );
      `)
      this.db.prepare('INSERT OR IGNORE INTO binding VALUES (1, ?)').run(identity)
      if (this.db.prepare('SELECT identity FROM binding WHERE id=1').get().identity !== identity) {
        throw new Error('state_bound_to_another_bot')
      }
      this.db.exec('BEGIN IMMEDIATE')
      if (!this.db.prepare('PRAGMA table_info(conversations)').all().some(row => row.name === 'last_ms')) {
        this.db.exec('ALTER TABLE conversations ADD COLUMN last_ms INTEGER NOT NULL DEFAULT 0')
      }
      const columns = new Set(this.db.prepare('PRAGMA table_info(jobs)').all().map(row => row.name))
      if (!columns.has('channel_type')) this.db.exec('ALTER TABLE jobs ADD COLUMN channel_type INTEGER NOT NULL DEFAULT 1')
      if (!columns.has('channel_id')) this.db.exec('ALTER TABLE jobs ADD COLUMN channel_id TEXT')
      if (!columns.has('ambient')) this.db.exec('ALTER TABLE jobs ADD COLUMN ambient INTEGER NOT NULL DEFAULT 0')
      if (!columns.has('metadata')) this.db.exec('ALTER TABLE jobs ADD COLUMN metadata TEXT')
      if (!columns.has('session_id')) this.db.exec('ALTER TABLE jobs ADD COLUMN session_id TEXT')
      this.db.exec('CREATE INDEX IF NOT EXISTS jobs_by_session ON jobs(session_id, seq)')
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS jobs_by_route
          ON jobs(channel_type, COALESCE(channel_id, sender), seq) WHERE state IN ('queued','ready','running','sending');
        CREATE INDEX IF NOT EXISTS jobs_route_history ON jobs(channel_type, COALESCE(channel_id, sender), seq);
        COMMIT;
      `)
      this.db.exec("UPDATE jobs SET state='review', issue='interrupted_' || state WHERE state IN ('running','sending')")
    } catch (error) {
      this.close()
      throw error
    }
  }

  add(eventId, m) {
    this.db.prepare(`
      INSERT INTO jobs (message_id,event_id,sender,input,channel_type,channel_id,ambient,metadata) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(message_id) DO NOTHING
    `).run(m.messageId, eventId, m.sender, m.text, m.channelType ?? 1, m.channelId ?? m.sender, m.ambient ? 1 : 0,
      m.attachment || m.command || m.cardAction ? JSON.stringify({ attachment: m.attachment, command: m.command, cardAction: m.cardAction }) : null)
  }

  bindCard(binding) {
    this.db.prepare('DELETE FROM card_bindings WHERE expires_ms <= ?').run(Date.now())
    this.db.prepare('INSERT INTO card_bindings (message_id,binding,expires_ms) VALUES (?,?,?)')
      .run(binding.messageId, JSON.stringify(binding), binding.expiresAt)
  }

  hasEvent(id) {
    return !!this.db.prepare('SELECT 1 FROM jobs WHERE message_id=?').get('card_action:' + id)
  }

  hasOpenCard() {
    return !!this.db.prepare('SELECT 1 FROM card_bindings WHERE expires_ms>? AND claimed=0 LIMIT 1').get(Date.now())
  }

  cardBinding(id) {
    const row = this.db.prepare('SELECT binding FROM card_bindings WHERE message_id=? AND expires_ms>? AND claimed=0')
      .get(id, Date.now())
    return row ? JSON.parse(row.binding) : null
  }

  claimCard(action, m) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (this.db.prepare('UPDATE card_bindings SET claimed=1 WHERE message_id=? AND expires_ms>? AND claimed=0')
        .run(action.messageId, Date.now()).changes) this.add(action.eventId, m)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  steerCandidate(job) {
    return this.db.prepare(`SELECT * FROM jobs WHERE state='queued' AND seq>?
      AND channel_type=1 AND COALESCE(channel_id,sender)=? ORDER BY seq LIMIT 1`).get(job.seq, job.sender)
  }

  next(now) {
    // Keep per-conversation reply order when an earlier send was rate-limited.
    return this.db.prepare(`
      SELECT j.* FROM jobs j WHERE j.state IN ('queued','ready') AND j.next_ms <= ?
        AND NOT EXISTS (
          SELECT 1 FROM jobs prior WHERE prior.channel_type=j.channel_type
            AND COALESCE(prior.channel_id, prior.sender)=COALESCE(j.channel_id, j.sender) AND prior.seq<j.seq
            AND prior.state IN ('queued','ready','running','sending')
        )
      ORDER BY j.seq LIMIT 1
    `).get(now)
  }

  session(sender, idleMinutes = 0, now = Date.now(), rotate = false) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare('SELECT session_id,created,last_ms FROM conversations WHERE sender=?').get(sender)
      if (!row || rotate || (idleMinutes > 0 && row.last_ms > 0 && now - row.last_ms >= idleMinutes * 60_000)) {
        const fresh = 'session-' + randomUUID()
        if (row?.created) {
          this.db.prepare('INSERT INTO conversation_history (sender,session_id,last_ms) VALUES (?,?,?)')
            .run(sender, row.session_id, row.last_ms)
        }
        this.db.prepare(`INSERT INTO conversations (sender,session_id,last_ms) VALUES (?,?,?)
          ON CONFLICT(sender) DO UPDATE SET session_id=excluded.session_id, created=0, last_ms=excluded.last_ms`)
          .run(sender, fresh, now)
        this.db.exec('COMMIT')
        return { session_id: fresh, created: 0 }
      }
      this.db.prepare('UPDATE conversations SET last_ms=? WHERE sender=?').run(now, sender)
      this.db.exec('COMMIT')
      return { session_id: row.session_id, created: row.created }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  sessionCreated(sender) { this.db.prepare('UPDATE conversations SET created=1 WHERE sender=?').run(sender) }
  overview() {
    const conversations = this.db.prepare(`
      WITH known AS (
        SELECT sender,session_id,last_ms,0 AS historical FROM conversations WHERE created=1
        UNION ALL SELECT sender,session_id,last_ms,1 FROM conversation_history
      ), routes AS (
        SELECT session_id,
          CASE WHEN substr(sender, 1, 1)='[' THEN json_extract(sender, '$[0]') ELSE 1 END AS type,
          CASE WHEN substr(sender, 1, 1)='[' THEN json_extract(sender, '$[1]') ELSE sender END AS address,
          CASE WHEN substr(sender, 1, 1)='[' THEN json_extract(sender, '$[2]') END AS scope,
          last_ms,historical
        FROM known ORDER BY last_ms DESC LIMIT 250
      )
      SELECT r.session_id AS id, r.type, r.address, r.scope, r.historical, j.state, j.issue
      FROM routes r LEFT JOIN jobs j ON j.seq=(
        SELECT COALESCE(
          (SELECT seq FROM jobs WHERE session_id=r.session_id AND state <> 'ignored' ORDER BY seq DESC LIMIT 1),
          CASE WHEN r.historical=0 AND (SELECT COUNT(*) FROM routes other
            WHERE other.type=r.type AND other.address=r.address)=1 THEN
            (SELECT seq FROM jobs WHERE session_id IS NULL AND channel_type=r.type AND COALESCE(channel_id, sender)=r.address
              AND state IN ('sent','review') ORDER BY seq DESC LIMIT 1)
          END
        )
      )
      ORDER BY r.last_ms DESC,j.seq DESC
    `).all()
    const counts = this.db.prepare('SELECT state, count(*) AS total FROM jobs GROUP BY state').all()
    return { conversations, counts }
  }
  hasPending() {
    return !!this.db.prepare("SELECT 1 FROM jobs WHERE state IN ('queued','running','ready','sending') LIMIT 1").get()
  }
  running(seq, sessionId = null) {
    this.db.prepare("UPDATE jobs SET state='running', session_id=COALESCE(?,session_id) WHERE seq=?").run(sessionId, seq)
  }
  ready(seq, reply, metadata) {
    this.db.prepare("UPDATE jobs SET state='ready', reply=?, metadata=? WHERE seq=?")
      .run(reply, metadata ? JSON.stringify(metadata) : null, seq)
  }
  sending(seq) { this.db.prepare("UPDATE jobs SET state='sending', attempts=attempts+1 WHERE seq=?").run(seq) }
  sent(seq, id, merged = []) {
    const write = this.db.prepare("UPDATE jobs SET state='sent', result_id=?, input='', reply=NULL, metadata=NULL WHERE seq=?")
    if (!merged.length) { write.run(id, seq); return }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const item of [seq, ...merged]) write.run(id, item)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  recordDelivery(seq, id) { this.db.prepare("UPDATE jobs SET result_id=? WHERE seq=?").run(id, seq) }
  retry(seq, at) { this.db.prepare("UPDATE jobs SET state='ready', next_ms=? WHERE seq=?").run(at, seq) }
  review(seq, issue) { this.db.prepare("UPDATE jobs SET state='review', issue=? WHERE seq=?").run(issue, seq) }
  discard(seq, issue, state = 'ignored') {
    this.db.prepare("UPDATE jobs SET state=?, issue=?, input='', reply=NULL, metadata=NULL WHERE seq=?").run(state, issue, seq)
  }
  close() { try { this.db?.close() } finally { this.lease.close() } }
}
