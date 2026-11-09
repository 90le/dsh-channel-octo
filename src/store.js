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
      if (!columns.has('message_seq')) this.db.exec('ALTER TABLE jobs ADD COLUMN message_seq INTEGER')
      if (!columns.has('route_order')) {
        this.db.exec('ALTER TABLE jobs ADD COLUMN route_order REAL NOT NULL DEFAULT 0')
      }
      // A rollback can insert rows using the former schema's column list.
      this.db.exec(`UPDATE jobs SET route_order=COALESCE(message_seq, COALESCE((SELECT MAX(p.message_seq) FROM jobs p
            WHERE p.channel_type=jobs.channel_type AND COALESCE(p.channel_id,p.sender)=COALESCE(jobs.channel_id,jobs.sender)
              AND p.seq<jobs.seq),0)+0.5) WHERE route_order=0;`)
      this.db.exec('CREATE INDEX IF NOT EXISTS jobs_by_session ON jobs(session_id, seq)')
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS pending_card_acks (event_id TEXT PRIMARY KEY NOT NULL);
        CREATE TABLE IF NOT EXISTS inbox_routes (
          channel_type INTEGER NOT NULL, channel_id TEXT NOT NULL,
          floor_seq INTEGER NOT NULL, checkpoint INTEGER NOT NULL,
          blocked INTEGER NOT NULL DEFAULT 0, checked_ms INTEGER NOT NULL DEFAULT 0,
          retry_ms INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(channel_type, channel_id)
        );
        CREATE TABLE IF NOT EXISTS inbox_staged (
          message_id TEXT PRIMARY KEY, channel_type INTEGER NOT NULL, channel_id TEXT NOT NULL,
          message_seq INTEGER NOT NULL, event_id TEXT NOT NULL, message TEXT NOT NULL, live INTEGER NOT NULL, question_key TEXT
        );
        CREATE TABLE IF NOT EXISTS inbox_seen (message_id TEXT PRIMARY KEY);
        CREATE INDEX IF NOT EXISTS jobs_by_route
          ON jobs(channel_type, COALESCE(channel_id, sender), seq) WHERE state IN ('queued','ready','running','sending');
        CREATE INDEX IF NOT EXISTS jobs_route_history ON jobs(channel_type, COALESCE(channel_id, sender), seq);
        CREATE INDEX IF NOT EXISTS jobs_route_order ON jobs(channel_type, COALESCE(channel_id,sender),route_order,seq)
          WHERE state IN ('queued','ready','running','sending');
        COMMIT;
      `)
      this.db.exec("UPDATE jobs SET state='review', issue='interrupted_' || state WHERE state IN ('running','sending')")
    } catch (error) {
      this.close()
      throw error
    }
  }

  add(eventId, m) {
    return this.db.prepare(`
      INSERT INTO jobs (message_id,event_id,sender,input,channel_type,channel_id,ambient,metadata,message_seq,route_order) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(message_id) DO NOTHING
    `).run(m.messageId, eventId, m.sender, m.text, m.channelType ?? 1, m.channelId ?? m.sender, m.ambient ? 1 : 0,
      m.attachment || m.attachments || m.parts || m.quoteId || m.command || m.cardAction ? JSON.stringify({
        attachment: m.attachment, attachments: m.attachments, parts: m.parts, quoteId: m.quoteId, command: m.command, cardAction: m.cardAction,
      }) : null, m.messageSeq ?? null, m.messageSeq ??
        (this.db.prepare('SELECT MAX(message_seq) AS n FROM jobs WHERE channel_type=? AND COALESCE(channel_id,sender)=?')
          .get(m.channelType ?? 1, m.channelId ?? m.sender).n ?? 0) + 0.5)
  }

  // Enrol only from an actually received message. Old conversation/job rows are
  // not evidence that any preceding history was accepted for execution.
  enrolInbox(m, blocked = false) {
    this.db.prepare(`INSERT INTO inbox_routes(channel_type,channel_id,floor_seq,checkpoint,blocked,checked_ms)
      VALUES (?,?,?,?,?,?) ON CONFLICT(channel_type,channel_id) DO NOTHING`)
      .run(m.channelType, m.channelId, m.messageSeq - 1, m.messageSeq - 1, blocked ? 1 : 0, Date.now())
    return this.inboxRoute(m.channelType, m.channelId)
  }
  inboxRoute(type, id) {
    return this.db.prepare('SELECT * FROM inbox_routes WHERE channel_type=? AND channel_id=?').get(type, id)
  }
  blockInbox() { this.db.exec('UPDATE inbox_routes SET blocked=1,retry_ms=0') }
  dueInbox(now, interval) {
    return this.db.prepare('SELECT * FROM inbox_routes WHERE retry_ms<=? AND (blocked=1 OR checked_ms<=?) ORDER BY checked_ms LIMIT 100')
      .all(now, now - interval)
  }
  blockInboxRoute(route) {
    this.db.prepare('UPDATE inbox_routes SET blocked=1,checked_ms=? WHERE channel_type=? AND channel_id=?')
      .run(Date.now(), route.channel_type, route.channel_id)
  }
  failInbox(route, now = Date.now()) {
    this.db.prepare('UPDATE inbox_routes SET failed=1,retry_ms=? WHERE channel_type=? AND channel_id=?')
      .run(now + 30_000, route.channel_type, route.channel_id)
  }
  stageInbox(eventId, m, live = false, questionKey = null) {
    if (this.inboxSeen(m.messageId)) return
    this.db.prepare(`INSERT INTO inbox_staged(message_id,channel_type,channel_id,message_seq,event_id,message,live,question_key)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(message_id) DO NOTHING`)
      .run(m.messageId, m.channelType, m.channelId, m.messageSeq, eventId, JSON.stringify(m), live ? 1 : 0, questionKey)
  }
  inboxSeen(id) {
    return !!this.db.prepare('SELECT 1 FROM inbox_seen WHERE message_id=? UNION ALL SELECT 1 FROM jobs WHERE message_id=? LIMIT 1').get(id, id)
  }
  checkpointInbox(route, checkpoint, messages, observed = [], suppressed = []) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const m of messages) {
        this.stageInbox('history:' + m.messageId, m)
        const prior = this.db.prepare('SELECT * FROM inbox_staged WHERE message_id=?').get(m.messageId)
        if (prior) {
          if (prior.channel_type !== m.channelType || prior.channel_id !== m.channelId || prior.message_seq !== m.messageSeq) {
            throw new Error('inbox_message_conflict')
          }
          const old = JSON.parse(prior.message)
          this.db.prepare('UPDATE inbox_staged SET message=?,live=? WHERE message_id=?')
            .run(JSON.stringify(m), prior.live && old.text === m.text && old.command === m.command ? 1 : 0, m.messageId)
        }
      }
      for (const id of suppressed) {
        this.removeStagedInbox(id)
        this.db.prepare(`UPDATE jobs SET state='ignored',issue='inbox_revoked_or_ineligible',input='',metadata=NULL
          WHERE message_id=? AND state='queued'`).run(id)
      }
      const seen = this.db.prepare('INSERT OR IGNORE INTO inbox_seen(message_id) VALUES (?)')
      for (const id of observed) seen.run(id)
      this.db.prepare(`UPDATE inbox_routes SET checkpoint=MAX(checkpoint,?),failed=0,retry_ms=0 WHERE channel_type=? AND channel_id=?`)
        .run(checkpoint, route.channel_type, route.channel_id)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  stagedInbox(route) {
    return this.db.prepare(`SELECT * FROM inbox_staged WHERE channel_type=? AND channel_id=?
      ORDER BY message_seq,message_id LIMIT 250`).all(route.channel_type, route.channel_id)
  }
  removeStagedInbox(id) { this.db.prepare('DELETE FROM inbox_staged WHERE message_id=?').run(id) }
  releaseInbox(route) {
    this.db.prepare(`UPDATE inbox_routes SET blocked=0, failed=0,retry_ms=0,checked_ms=? WHERE channel_type=? AND channel_id=?`)
      .run(Date.now(), route.channel_type, route.channel_id)
  }

  rememberAnswer(eventId, message, sessionId) {
    return this.db.prepare(`INSERT INTO jobs (message_id,event_id,sender,input,channel_type,channel_id,state,session_id)
      VALUES (?,?,?,'',?,?,'ignored',?) ON CONFLICT(message_id) DO NOTHING`)
      .run(message.messageId, eventId, message.sender, message.channelType, message.channelId, sessionId ?? null).changes > 0
  }

  bindCard(binding) {
    this.db.prepare('DELETE FROM card_bindings WHERE expires_ms <= ?').run(Date.now())
    this.db.prepare('INSERT INTO card_bindings (message_id,binding,expires_ms) VALUES (?,?,?)')
      .run(binding.messageId, JSON.stringify(binding), binding.expiresAt)
  }

  hasEvent(id) {
    return !!this.db.prepare('SELECT 1 FROM jobs WHERE message_id=? AND event_id=?').get('card_action:' + id, id)
  }

  queueCardAck(id) {
    // Never coerce an int64 through Number, or enqueue an ACK without our receipt.
    if (typeof id !== 'string' || !/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) {
      throw new Error('invalid_card_event_id')
    }
    if (!this.hasEvent(id)) return false
    this.db.prepare('INSERT OR IGNORE INTO pending_card_acks (event_id) VALUES (?)').run(id)
    return true
  }

  pendingCardAcks() {
    return this.db.prepare('SELECT event_id FROM pending_card_acks ORDER BY rowid LIMIT 20').all().map(row => row.event_id)
  }

  cardAcked(id) {
    this.db.prepare('DELETE FROM pending_card_acks WHERE event_id=?').run(id)
  }

  hasOpenCard() {
    return !!this.db.prepare('SELECT 1 FROM card_bindings WHERE expires_ms>? AND claimed=0 LIMIT 1').get(Date.now())
  }

  unfinishedQuestionCards() {
    return this.db.prepare(`SELECT binding FROM card_bindings
      WHERE json_extract(binding,'$.questionKey') IS NOT NULL
      AND COALESCE(json_extract(binding,'$.questionFeedback'),0)=0
      ORDER BY expires_ms DESC LIMIT 50`).all().map(row => JSON.parse(row.binding))
  }
  finishQuestionCard(id, summary) {
    this.db.prepare(`UPDATE card_bindings SET claimed=1,
      binding=json_set(binding,'$.questionSummary',?) WHERE message_id=?`).run(summary, id)
  }
  questionFeedbackSent(id) {
    this.db.prepare("UPDATE card_bindings SET binding=json_set(binding,'$.questionFeedback',1) WHERE message_id=?").run(id)
  }

  cardBinding(id) {
    const row = this.db.prepare('SELECT binding FROM card_bindings WHERE message_id=? AND expires_ms>? AND claimed=0')
      .get(id, Date.now())
    return row ? JSON.parse(row.binding) : null
  }

  claimCard(action, m, sessionId) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const claimed = this.db.prepare('UPDATE card_bindings SET claimed=1 WHERE message_id=? AND expires_ms>? AND claimed=0')
        .run(action.messageId, Date.now()).changes > 0
      let inserted = false
      if (claimed) inserted = sessionId !== undefined ? this.rememberAnswer(action.eventId, m, sessionId)
        : this.add(action.eventId, m).changes > 0
      // Claim, local action receipt and retry obligation survive or roll back together.
      if (inserted) this.queueCardAck(action.eventId)
      this.db.exec('COMMIT')
      return inserted
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  steerCandidate(job) {
    return this.db.prepare(`SELECT * FROM jobs WHERE state='queued' AND seq>?
      AND channel_type=? AND COALESCE(channel_id,sender)=? AND sender=? ORDER BY seq LIMIT 1`)
      .get(job.seq, job.channel_type, job.channel_id ?? job.sender, job.sender)
  }

  next(now) {
    // Keep per-conversation reply order when an earlier send was rate-limited.
    return this.db.prepare(`
      SELECT j.* FROM jobs j WHERE j.state IN ('queued','ready') AND j.next_ms <= ?
        AND NOT EXISTS (SELECT 1 FROM inbox_routes r WHERE r.channel_type=j.channel_type
          AND r.channel_id=COALESCE(j.channel_id,j.sender) AND r.blocked=1)
        AND NOT EXISTS (
          SELECT 1 FROM jobs prior WHERE prior.channel_type=j.channel_type
            AND COALESCE(prior.channel_id, prior.sender)=COALESCE(j.channel_id, j.sender)
            AND (prior.route_order<j.route_order OR prior.route_order=j.route_order AND prior.seq<j.seq)
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
  knownSessions() {
    return this.db.prepare(`SELECT session_id FROM conversations WHERE created=1
      UNION SELECT session_id FROM conversation_history`).all().map(row => row.session_id)
  }
  forgetSession(sessionId) {
    // Forget only the routing/display mapping. Delivery receipts still prevent
    // replay, and existing native sessions/history are never deleted here.
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM conversations WHERE session_id=?').run(sessionId)
      this.db.prepare('DELETE FROM conversation_history WHERE session_id=?').run(sessionId)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
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
    const inbox = this.db.prepare(`SELECT COUNT(*) AS routes,COALESCE(SUM(blocked),0) AS recoveringRoutes,
      COALESCE(SUM(failed),0) AS failedRoutes,(SELECT COUNT(*) FROM inbox_staged) AS pendingMessages FROM inbox_routes`).get()
    return { conversations, counts, inbox }
  }
  retirePending() {
    this.db.prepare("UPDATE jobs SET state='review', issue='account_removed', input='', reply=NULL, metadata=NULL WHERE state IN ('queued','ready')").run()
    this.db.exec('DELETE FROM inbox_staged; DELETE FROM inbox_routes;')
  }
  hasPending() {
    return !!this.db.prepare("SELECT 1 FROM jobs WHERE state IN ('queued','running','ready','sending') LIMIT 1").get()
      || !!this.db.prepare('SELECT 1 FROM inbox_staged LIMIT 1').get()
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
