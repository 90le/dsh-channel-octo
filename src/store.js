import { randomUUID } from 'node:crypto'
import { mkdirSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

function isDecimalInt64(id) {
  return typeof id === 'string' && /^[1-9]\d{0,18}$/.test(id) && BigInt(id) <= 9223372036854775807n
}

function isDirectoryGroup(id) {
  return typeof id === 'string' && id.length === 32 && /^[a-fA-F0-9]{32}$/.test(id)
}

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
          since_ms INTEGER NOT NULL DEFAULT 0,
          directory_at INTEGER NOT NULL DEFAULT 0, directory_all INTEGER NOT NULL DEFAULT 0, prefix_until_seq INTEGER NOT NULL DEFAULT 0,
          prefix_since_ms INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(channel_type, channel_id)
        );
        CREATE TABLE IF NOT EXISTS inbox_staged (
          message_id TEXT PRIMARY KEY, channel_type INTEGER NOT NULL, channel_id TEXT NOT NULL,
          message_seq INTEGER NOT NULL, event_id TEXT NOT NULL, message TEXT NOT NULL, live INTEGER NOT NULL, question_key TEXT
        );
        CREATE TABLE IF NOT EXISTS inbox_seen (message_id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS event_recovery (
          id INTEGER PRIMARY KEY CHECK(id=1), ready INTEGER NOT NULL DEFAULT 0,
          baseline TEXT NOT NULL DEFAULT '0', bootstrap_cursor TEXT NOT NULL DEFAULT '0',
          failed INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS directory_recovery (
          id INTEGER PRIMARY KEY CHECK(id=1), started_at INTEGER NOT NULL DEFAULT 0,
          ready INTEGER NOT NULL DEFAULT 0, completed_at INTEGER NOT NULL DEFAULT 0,
          failed INTEGER NOT NULL DEFAULT 0, listed_at INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS directory_groups (
          group_no TEXT PRIMARY KEY NOT NULL, page INTEGER NOT NULL DEFAULT 1,
          done INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0,
          checked_ms INTEGER NOT NULL DEFAULT 0, retry_ms INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS message_event_acks (
          event_id TEXT PRIMARY KEY NOT NULL, message_id TEXT NOT NULL, acked INTEGER NOT NULL DEFAULT 0,
          attempt INTEGER NOT NULL DEFAULT 0, retry_ms INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS inbox_event_discoveries (
          event_id TEXT PRIMARY KEY NOT NULL, message_id TEXT NOT NULL,
          channel_type INTEGER NOT NULL, channel_id TEXT NOT NULL, message_seq INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS inbox_event_discoveries_by_message ON inbox_event_discoveries(message_id);
        CREATE INDEX IF NOT EXISTS inbox_event_discoveries_by_route
          ON inbox_event_discoveries(channel_type,channel_id,message_seq);
        CREATE INDEX IF NOT EXISTS jobs_by_route
          ON jobs(channel_type, COALESCE(channel_id, sender), seq) WHERE state IN ('queued','ready','running','sending');
        CREATE INDEX IF NOT EXISTS jobs_route_history ON jobs(channel_type, COALESCE(channel_id, sender), seq);
        CREATE INDEX IF NOT EXISTS jobs_route_order ON jobs(channel_type, COALESCE(channel_id,sender),route_order,seq)
          WHERE state IN ('queued','ready','running','sending');
      `)
      const routeColumns = new Set(this.db.prepare('PRAGMA table_info(inbox_routes)').all().map(row => row.name))
      for (const column of ['since_ms', 'directory_at', 'directory_all', 'prefix_until_seq', 'prefix_since_ms']) {
        if (!routeColumns.has(column)) this.db.exec(`ALTER TABLE inbox_routes ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`)
      }
      if (!this.db.prepare('PRAGMA table_info(directory_groups)').all().some(row => row.name === 'retry_ms')) {
        this.db.exec('ALTER TABLE directory_groups ADD COLUMN retry_ms INTEGER NOT NULL DEFAULT 0')
      }
      if (!this.db.prepare('PRAGMA table_info(directory_recovery)').all().some(row => row.name === 'listed_at')) {
        this.db.exec('ALTER TABLE directory_recovery ADD COLUMN listed_at INTEGER NOT NULL DEFAULT 0')
      }
      const ackColumns = new Set(this.db.prepare('PRAGMA table_info(message_event_acks)').all().map(row => row.name))
      if (!ackColumns.has('attempt')) this.db.exec('ALTER TABLE message_event_acks ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0')
      if (!ackColumns.has('retry_ms')) this.db.exec('ALTER TABLE message_event_acks ADD COLUMN retry_ms INTEGER NOT NULL DEFAULT 0')
      this.db.prepare('INSERT OR IGNORE INTO event_recovery(id,started_at) VALUES (1,0)').run()
      this.db.prepare('INSERT OR IGNORE INTO directory_recovery(id) VALUES (1)').run()
      this.db.exec('COMMIT')
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
      m.attachment || m.attachments || m.parts || m.quoteId || m.command || m.cardAction || m.deferredForm || m.directoryRecovery ? JSON.stringify({
        attachment: m.attachment, attachments: m.attachments, parts: m.parts, quoteId: m.quoteId, command: m.command, cardAction: m.cardAction,
        deferredForm: m.deferredForm, directoryRecovery: m.directoryRecovery,
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
    this.promoteDirectoryRoute(m, 0)
    return this.inboxRoute(m.channelType, m.channelId)
  }

  // Actual delivery/events establish an accepted upper range independently of
  // directory auto-discovery. Replays of already handled rows do not expand it.
  promoteDirectoryRoute(m, since) {
    if (![2, 5].includes(m.channelType) || !Number.isSafeInteger(m.messageSeq)
      || m.messageSeq < 1 || m.messageSeq > 0xffffffff || this.inboxSeen(m.messageId)) return false
    return this.db.prepare(`UPDATE inbox_routes SET
      prefix_since_ms=MAX(since_ms,prefix_since_ms,directory_at),prefix_until_seq=?,
      since_ms=CASE WHEN directory_all=1 THEN ? ELSE MIN(since_ms,?) END,
      directory_all=0,checkpoint=MIN(checkpoint,?),blocked=1,retry_ms=0,checked_ms=0
      WHERE channel_type=? AND channel_id=? AND (directory_all=1 OR prefix_until_seq>=?)`)
      .run(m.messageSeq - 1, since, since, m.messageSeq - 1,
        m.channelType, m.channelId, m.messageSeq).changes > 0
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

  eventRecovery() {
    const row = this.db.prepare('SELECT ready,baseline,bootstrap_cursor,failed,started_at FROM event_recovery WHERE id=1').get()
    return { ready: !!row.ready, baseline: row.baseline, bootstrapCursor: row.bootstrap_cursor,
      failed: !!row.failed, startedAt: row.started_at }
  }

  activateEventRecovery(now = Date.now()) {
    if (!Number.isSafeInteger(now) || now <= 0) return false
    // Opening a disabled/non-WS account must not establish its recovery boundary.
    // The first actual recovery start wins, including across later restarts.
    return this.db.prepare('UPDATE event_recovery SET started_at=? WHERE id=1 AND started_at=0')
      .run(now).changes > 0
  }

  advanceEventBootstrap(id) {
    if (!isDecimalInt64(id)) return false
    // SQLite compares signed int64 values exactly; JS Number would lose precision.
    return this.db.prepare(`UPDATE event_recovery SET bootstrap_cursor=?
      WHERE id=1 AND ready=0 AND CAST(bootstrap_cursor AS INTEGER)<CAST(? AS INTEGER)`).run(id, id).changes > 0
  }

  finishEventBootstrap() {
    // Publishing the baseline and marking it ready must be one atomic write.
    this.db.exec('UPDATE event_recovery SET ready=1,baseline=bootstrap_cursor WHERE id=1 AND ready=0')
  }

  eventRecoveryFailed(failed) {
    this.db.prepare('UPDATE event_recovery SET failed=? WHERE id=1').run(failed ? 1 : 0)
  }

  directoryRecovery() {
    const row = this.db.prepare(`SELECT started_at,ready,completed_at,failed,
      (SELECT COUNT(*) FROM directory_groups WHERE done=0) AS pending_groups
      FROM directory_recovery WHERE id=1`).get()
    return { startedAt: row.started_at, ready: !!row.ready, completedAt: row.completed_at,
      failed: !!row.failed, pendingGroups: row.pending_groups }
  }

  activateDirectoryRecovery(now = Date.now()) {
    if (!Number.isSafeInteger(now) || now <= 0) return false
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const activated = this.db.prepare('UPDATE directory_recovery SET started_at=? WHERE id=1 AND started_at=0')
        .run(now).changes > 0
      // Only routes present at first activation retain their original recovery
      // range. Later WS/event discoveries need the directory prefix below.
      if (activated) this.db.prepare('UPDATE inbox_routes SET directory_at=? WHERE channel_type IN (2,5)').run(now)
      this.db.exec('COMMIT')
      return activated
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  beginDirectoryScan(groupIds, now = Date.now()) {
    if (this.directoryRecovery().pendingGroups) return false
    return this.mergeDirectoryScan(groupIds, now)
  }

  directoryListedAt() {
    // Scheduling metadata stays out of the public account recovery status.
    return this.db.prepare('SELECT listed_at FROM directory_recovery WHERE id=1').get().listed_at
  }

  mergeDirectoryScan(groupIds, now = Date.now()) {
    // Match the bounded group listing; reject a malformed/partial list before
    // merging any durable scan. Exact IDs are kept, without case rewriting.
    if (!Array.isArray(groupIds) || groupIds.length > 1000 || !Number.isSafeInteger(now) || now <= 0) return false
    const ids = new Set(groupIds)
    if (ids.size !== groupIds.length || [...ids].some(id => !isDirectoryGroup(id))) return false
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const recovery = this.directoryRecovery()
      if (!recovery.startedAt) { this.db.exec('ROLLBACK'); return false }
      this.db.prepare('DELETE FROM directory_groups WHERE group_no NOT IN (SELECT value FROM json_each(?))')
        .run(JSON.stringify(groupIds))
      // Pending pages retain their exact deadline and position. Completed
      // groups restart at page 1, retaining their last turn for fair scheduling.
      const insert = this.db.prepare(`INSERT INTO directory_groups(group_no) VALUES (?)
        ON CONFLICT(group_no) DO UPDATE SET page=1,done=0,failed=0,retry_ms=0 WHERE directory_groups.done=1`)
      for (const id of ids) insert.run(id)
      this.db.prepare(`UPDATE directory_recovery SET ready=?,completed_at=?,listed_at=?,
        failed=EXISTS(SELECT 1 FROM directory_groups WHERE failed=1) WHERE id=1`)
        .run(ids.size ? 0 : 1, ids.size ? 0 : now, now)
      this.db.exec('COMMIT')
      return true
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  nextDirectoryGroup(now = Date.now()) {
    return this.db.prepare('SELECT * FROM directory_groups WHERE done=0 AND retry_ms<=? ORDER BY checked_ms,group_no LIMIT 1').get(now)
  }

  retryDirectoryStep(group, retryAt, now = Date.now()) {
    if (!isDirectoryGroup(group) || !Number.isSafeInteger(now) || now <= 0
      || !Number.isSafeInteger(retryAt) || retryAt <= now) return false
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // Keep the failed page pending across restarts. Other due groups can run
      // while this one waits; it must not trigger a replacement catalog scan.
      const changed = this.db.prepare(`UPDATE directory_groups SET failed=1,retry_ms=?,checked_ms=?
        WHERE group_no=? AND done=0`).run(retryAt, now, group).changes > 0
      if (changed) this.db.exec('UPDATE directory_recovery SET failed=1 WHERE id=1')
      this.db.exec('COMMIT')
      return changed
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  completeDirectoryStep(group, nextPage = null, failed = false, now = Date.now()) {
    if (!isDirectoryGroup(group) || nextPage !== null && (!Number.isSafeInteger(nextPage) || nextPage <= 0)
      || !Number.isSafeInteger(now) || now <= 0) return false
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const changed = this.db.prepare(`UPDATE directory_groups
        SET page=COALESCE(?,page),done=?,failed=?,retry_ms=0,checked_ms=? WHERE group_no=? AND done=0`)
        .run(nextPage, nextPage === null ? 1 : 0, failed ? 1 : 0, now, group).changes > 0
      if (changed) this.db.exec(`UPDATE directory_recovery SET
        failed=EXISTS(SELECT 1 FROM directory_groups WHERE failed=1) WHERE id=1`)
      if (changed) this.db.prepare(`UPDATE directory_recovery SET ready=1,completed_at=?,
        failed=EXISTS(SELECT 1 FROM directory_groups WHERE failed=1)
        WHERE id=1 AND NOT EXISTS(SELECT 1 FROM directory_groups WHERE done=0)`).run(now)
      this.db.exec('COMMIT')
      return changed
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  directoryRecoveryFailed(failed) {
    this.db.prepare('UPDATE directory_recovery SET failed=? WHERE id=1').run(failed ? 1 : 0)
  }

  seedDirectoryRoute(type, id) {
    if (!(type === 2 ? isDirectoryGroup(id) : type === 5 && typeof id === 'string'
      && id === id.trim() && /^[a-fA-F0-9]{32}____[0-9]{15,20}$/.test(id))) return false
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const startedAt = this.directoryRecovery().startedAt
      if (!startedAt) { this.db.exec('ROLLBACK'); return false }
      let changed = this.db.prepare(`INSERT INTO inbox_routes
        (channel_type,channel_id,floor_seq,checkpoint,blocked,since_ms,directory_at,directory_all)
        VALUES (?,?,0,0,1,?,?,1) ON CONFLICT(channel_type,channel_id) DO NOTHING`)
        .run(type, id, startedAt, startedAt).changes > 0
      if (!changed) {
        // WS/events raced after activation. Bound only the newly added prefix
        // by directory time, retaining since_ms for the original upper range.
        changed = this.db.prepare(`UPDATE inbox_routes SET
          prefix_until_seq=CASE WHEN floor_seq>0 THEN floor_seq ELSE prefix_until_seq END,
          prefix_since_ms=CASE WHEN floor_seq>0 THEN ? ELSE prefix_since_ms END,
          checkpoint=CASE WHEN floor_seq>0 THEN 0 ELSE checkpoint END,
          blocked=CASE WHEN floor_seq>0 THEN 1 ELSE blocked END,
          retry_ms=CASE WHEN floor_seq>0 THEN 0 ELSE retry_ms END,
          checked_ms=CASE WHEN floor_seq>0 THEN 0 ELSE checked_ms END,
          floor_seq=0,directory_at=?
          WHERE channel_type=? AND channel_id=? AND directory_at=0`)
          .run(startedAt, startedAt, type, id).changes > 0
      }
      this.db.exec('COMMIT')
      return changed
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  queueMessageEventAck(eventId, messageId) {
    if (!isDecimalInt64(eventId) || !isDecimalInt64(messageId)) return false
    // Receipt validation and insertion share a statement (and any caller transaction).
    // Keep completed mappings: a duplicate must not reopen an ACK or change its message.
    return this.db.prepare(`INSERT INTO message_event_acks(event_id,message_id)
      SELECT ?,? WHERE EXISTS (
        SELECT 1 FROM jobs WHERE message_id=?
        UNION ALL SELECT 1 FROM inbox_staged WHERE message_id=?
        UNION ALL SELECT 1 FROM inbox_seen WHERE message_id=?
        UNION ALL SELECT 1 FROM inbox_event_discoveries WHERE message_id=?
      ) ON CONFLICT(event_id) DO UPDATE SET message_id=excluded.message_id
        WHERE message_event_acks.message_id=excluded.message_id`)
      .run(eventId, messageId, messageId, messageId, messageId, messageId).changes > 0
  }

  pendingMessageEventAcks(now = Date.now()) {
    return this.db.prepare('SELECT event_id FROM message_event_acks WHERE acked=0 AND retry_ms<=? ORDER BY retry_ms,rowid LIMIT 20')
      .all(now).map(row => row.event_id)
  }

  messageEventAckDue(id, now = Date.now()) {
    if (!isDecimalInt64(id)) return false
    return !!this.db.prepare('SELECT 1 FROM message_event_acks WHERE event_id=? AND (acked=1 OR retry_ms<=?)').get(id, now)
  }

  messageEventAckFailed(id, now = Date.now()) {
    if (!isDecimalInt64(id)) return
    // One failed ACK cannot monopolize the bounded pending batch. Saturate both
    // the exponent and counter: 1s, 2s, 4s, ... up to 60s, even after a restart.
    this.db.prepare(`UPDATE message_event_acks SET
      retry_ms=?+MIN(60000,1000*(1 << MIN(attempt,6))),attempt=MIN(attempt+1,7)
      WHERE event_id=? AND acked=0`).run(now, id)
  }

  messageEventAcked(id) {
    // Only an exact decimal string may complete an existing retry obligation.
    if (!isDecimalInt64(id)) return
    this.db.prepare('UPDATE message_event_acks SET acked=1,attempt=0,retry_ms=0 WHERE event_id=?').run(id)
  }

  pendingInboxDiscoveries(route) {
    // A stage or remote ACK is not proof that current history was observed.
    return this.db.prepare(`SELECT event_id,message_id,message_seq FROM inbox_event_discoveries d
      WHERE channel_type=? AND channel_id=?
        AND NOT EXISTS (SELECT 1 FROM inbox_seen WHERE message_id=d.message_id)
        AND NOT EXISTS (SELECT 1 FROM jobs WHERE message_id=d.message_id)
      ORDER BY message_seq,event_id LIMIT 100`).all(route.channel_type, route.channel_id)
  }

  seedInboxEvent(eventId, m) {
    if (!isDecimalInt64(eventId) || !isDecimalInt64(m?.messageId)
      || !Number.isSafeInteger(m.messageSeq) || m.messageSeq <= 0 || m.messageSeq > 0xffffffff
      || ![1, 2, 5].includes(m.channelType) || typeof m.channelId !== 'string' || !m.channelId) return false
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const startedAt = this.eventRecovery().startedAt
      if (!(startedAt > 0)) { this.db.exec('ROLLBACK'); return false }
      // An event only discovers an unknown route. History must fetch the current
      // body and apply revocations before any message becomes executable.
      let enrolled = this.db.prepare(`INSERT INTO inbox_routes(channel_type,channel_id,floor_seq,checkpoint,blocked,checked_ms,since_ms)
        VALUES (?,?,?,?,1,?,?) ON CONFLICT(channel_type,channel_id) DO NOTHING`)
        .run(m.channelType, m.channelId, m.messageSeq - 1, m.messageSeq - 1, Date.now(), startedAt).changes > 0
      if (!enrolled) enrolled = this.promoteDirectoryRoute(m, startedAt)
      // A smaller sequence may arrive after the first discovery. Only these
      // time-bounded routes can lower their floor; legacy live-route floors stay
      // intact. Existing message receipts suppress already handled rows.
      if (!enrolled && !this.inboxSeen(m.messageId)) enrolled = this.db.prepare(`UPDATE inbox_routes
        SET floor_seq=?,checkpoint=MIN(checkpoint,?),blocked=1,retry_ms=0,checked_ms=0
        WHERE channel_type=? AND channel_id=? AND since_ms>0 AND floor_seq>=?`)
        .run(m.messageSeq - 1, m.messageSeq - 1, m.channelType, m.channelId, m.messageSeq).changes > 0
      const recorded = enrolled && this.db.prepare(`INSERT INTO inbox_event_discoveries
        (event_id,message_id,channel_type,channel_id,message_seq) VALUES (?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING`)
        .run(eventId, m.messageId, m.channelType, m.channelId, m.messageSeq).changes > 0
      if (!recorded || !this.queueMessageEventAck(eventId, m.messageId)) {
        this.db.exec('ROLLBACK')
        return false
      }
      this.db.exec('COMMIT')
      return true
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  rememberAnswer(eventId, message, sessionId) {
    return this.db.prepare(`INSERT INTO jobs (message_id,event_id,sender,input,channel_type,channel_id,state,session_id)
      VALUES (?,?,?,'',?,?,'ignored',?) ON CONFLICT(message_id) DO NOTHING`)
      .run(message.messageId, eventId, message.sender, message.channelType, message.channelId, sessionId ?? null).changes > 0
  }

  bindCard(binding) {
    const now = Date.now()
    // Deferred feedback is a durable obligation, including after expiry/restart.
    this.db.prepare(`DELETE FROM card_bindings WHERE expires_ms <= ? AND (
      json_extract(binding,'$.deferred') IS NULL OR (expires_ms <= ?
        AND json_extract(binding,'$.deferred.state') <> 'pending'
        AND json_extract(binding,'$.deferred.feedback') = 1))`).run(now, now - 30 * 86_400_000)
    this.db.prepare('INSERT INTO card_bindings (message_id,binding,expires_ms) VALUES (?,?,?)')
      .run(binding.messageId, JSON.stringify(binding), binding.expiresAt)
  }

  canPublishDeferred(sessionId) {
    // Each Store is already bound to one account. Check before the external send;
    // confirmed receipts must still be saved if concurrent sends fill the quota.
    const row = this.db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(json_extract(binding,'$.deferred.sessionId') = ?),0) AS session_total
      FROM card_bindings WHERE expires_ms > ? AND claimed=0
        AND json_extract(binding,'$.deferred.state') = 'pending'`).get(sessionId, Date.now())
    return row.total < 50 && row.session_total < 10
  }

  bindDeferredCard(binding, jobSeq) {
    if (binding.deferred?.state !== 'pending') throw new Error('invalid_deferred_card_state')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.bindCard(binding)
      const recorded = this.db.prepare('UPDATE jobs SET result_id=? WHERE seq=?').run(binding.messageId, jobSeq)
      if (!recorded.changes) throw new Error('deferred_job_missing')
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  deferredCard(id) {
    const row = this.db.prepare(`SELECT binding FROM card_bindings WHERE message_id=?
      AND json_extract(binding,'$.deferred') IS NOT NULL`).get(id)
    if (!row) return null
    const binding = JSON.parse(row.binding)
    if (binding.deferred.responseId) {
      const response = this.db.prepare('SELECT state FROM jobs WHERE message_id=?').get(binding.deferred.responseId)
      if (response) binding.responseState = response.state
    }
    return binding
  }

  claimDeferredCard(action, m) {
    if (m.messageId !== 'card_action:' + action.eventId) throw new Error('invalid_deferred_response_id')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const claimed = this.db.prepare(`UPDATE card_bindings SET claimed=1,
        binding=json_set(binding,'$.deferred.state','submitted','$.deferred.responseId',?,
          '$.deferred.feedback',json('false'))
        WHERE message_id=? AND expires_ms>? AND claimed=0
          AND json_extract(binding,'$.deferred.state')='pending'`).run(m.messageId, action.messageId, Date.now()).changes > 0
      if (!claimed || !this.add(action.eventId, m).changes) {
        this.db.exec('ROLLBACK')
        return false
      }
      if (!this.queueCardAck(action.eventId)) throw new Error('deferred_ack_receipt_missing')
      this.db.exec('COMMIT')
      return true
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  closeDeferredCard(id, state, summary) {
    if (!['cancelled', 'expired', 'invalid', 'unavailable'].includes(state)) throw new Error('invalid_deferred_card_state')
    // One statement, so rejection can include this transition in its transaction.
    return this.db.prepare(`UPDATE card_bindings SET claimed=1,
      binding=json_set(binding,'$.deferred.state',?,'$.deferred.summary',?,'$.deferred.feedback',json('false'))
      WHERE message_id=? AND json_extract(binding,'$.deferred.state')='pending'`).run(state, summary, id).changes > 0
  }

  rejectDeferredCard(action, m, state, summary) {
    if (m.messageId !== 'card_action:' + action.eventId) throw new Error('invalid_deferred_response_id')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const eligible = this.db.prepare(`SELECT 1 FROM card_bindings WHERE message_id=? AND expires_ms>? AND claimed=0
        AND json_extract(binding,'$.deferred.state')='pending'`).get(action.messageId, Date.now())
      if (!eligible || !this.closeDeferredCard(action.messageId, state, summary)
        || !this.rememberAnswer(action.eventId, m, null)) {
        this.db.exec('ROLLBACK')
        return false
      }
      if (!this.queueCardAck(action.eventId)) throw new Error('deferred_ack_receipt_missing')
      this.db.exec('COMMIT')
      return true
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  acknowledgeDeferredEvent(action, m) {
    if (m.messageId !== 'card_action:' + action.eventId) throw new Error('invalid_deferred_response_id')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // The caller validates account/route/operator/nonce/action even for a
      // closed card. A new event on that card is a receipt, never another task.
      const known = this.db.prepare(`SELECT 1 FROM card_bindings WHERE message_id=?
        AND json_extract(binding,'$.deferred.state') IS NOT NULL
        AND (json_extract(binding,'$.deferred.state') <> 'pending' OR expires_ms<=?)`).get(action.messageId, Date.now())
      if (!known) {
        this.db.exec('ROLLBACK')
        return false
      }
      const inserted = this.rememberAnswer(action.eventId, m, null)
      if (!this.queueCardAck(action.eventId)) throw new Error('deferred_ack_receipt_missing')
      this.db.exec('COMMIT')
      return inserted
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  expireDeferredCards(now = Date.now()) {
    return this.db.prepare(`UPDATE card_bindings SET claimed=1,
      binding=json_set(binding,'$.deferred.state','expired','$.deferred.summary','表单已过期，无法继续提交。',
        '$.deferred.feedback',json('false'))
      WHERE message_id IN (SELECT message_id FROM card_bindings WHERE expires_ms<=?
        AND json_extract(binding,'$.deferred.state')='pending' ORDER BY expires_ms,message_id LIMIT 50)`).run(now).changes
  }

  deferredFeedback() {
    return this.db.prepare(`SELECT binding FROM card_bindings
      WHERE json_extract(binding,'$.deferred.state') <> 'pending'
        AND COALESCE(json_extract(binding,'$.deferred.feedback'),0)=0
        AND COALESCE(json_extract(binding,'$.deferred.nextFeedbackAt'),0)<=?
      ORDER BY expires_ms,message_id LIMIT 20`).all(Date.now()).map(row => JSON.parse(row.binding))
  }

  deferredFeedbackAttempt(id) {
    this.db.prepare(`UPDATE card_bindings SET binding=json_set(binding,'$.deferred.nextFeedbackAt',?)
      WHERE message_id=? AND json_extract(binding,'$.deferred.state') <> 'pending'`).run(Date.now() + 60000, id)
  }

  deferredFeedbackSent(id) {
    this.db.prepare(`UPDATE card_bindings SET binding=json_set(binding,'$.deferred.feedback',json('true'))
      WHERE message_id=? AND json_extract(binding,'$.deferred.state') <> 'pending'`).run(id)
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

  hasDeferredCards() {
    return !!this.db.prepare(`SELECT 1 FROM card_bindings WHERE expires_ms>?
      AND json_extract(binding,'$.deferred') IS NOT NULL LIMIT 1`).get(Date.now() - 30 * 86_400_000)
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
    return this.db.prepare(`SELECT * FROM jobs WHERE state='queued'
      AND channel_type=? AND COALESCE(channel_id,sender)=? AND sender=?
      AND (route_order>? OR route_order=? AND seq>?) ORDER BY route_order,seq LIMIT 1`)
      .get(job.channel_type, job.channel_id ?? job.sender, job.sender, job.route_order, job.route_order, job.seq)
  }

  followupHead(job) {
    return this.db.prepare(`SELECT * FROM jobs WHERE state IN ('queued','ready')
      AND channel_type=? AND COALESCE(channel_id,sender)=?
      AND (route_order>? OR route_order=? AND seq>?) ORDER BY route_order,seq LIMIT 1`)
      .get(job.channel_type, job.channel_id ?? job.sender, job.route_order, job.route_order, job.seq)
  }

  next(now, busy = []) {
    // Keep per-conversation reply order when an earlier send was rate-limited.
    return this.db.prepare(`
      SELECT j.* FROM jobs j WHERE j.state IN ('queued','ready') AND j.next_ms <= ?
        AND NOT EXISTS (SELECT 1 FROM json_each(?) lane WHERE json_extract(lane.value,'$[0]')=j.channel_type
          AND json_extract(lane.value,'$[1]')=COALESCE(j.channel_id,j.sender))
        AND NOT EXISTS (SELECT 1 FROM inbox_routes r WHERE r.channel_type=j.channel_type
          AND r.channel_id=COALESCE(j.channel_id,j.sender) AND r.blocked=1)
        AND NOT EXISTS (
          SELECT 1 FROM jobs prior WHERE prior.channel_type=j.channel_type
            AND COALESCE(prior.channel_id, prior.sender)=COALESCE(j.channel_id, j.sender)
            AND (prior.route_order<j.route_order OR prior.route_order=j.route_order AND prior.seq<j.seq)
            AND prior.state IN ('queued','ready','running','sending')
        )
      ORDER BY j.seq LIMIT 1
    `).get(now, JSON.stringify(busy))
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

  boundSession(conversation, sessionId) {
    const row = this.db.prepare(`SELECT session_id FROM conversations WHERE sender=? AND session_id=? AND created=1
      UNION ALL SELECT session_id FROM conversation_history WHERE sender=? AND session_id=? LIMIT 1`)
      .get(conversation, sessionId, conversation, sessionId)
    return row ? { session_id: row.session_id, created: 1 } : null
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
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare("UPDATE jobs SET state='review', issue='account_removed', input='', reply=NULL, metadata=NULL WHERE state IN ('queued','ready')").run()
      // A staged/discovered message may already be ACKed. Retain its receipt
      // before retiring it, including for older versions that only consult inbox_seen.
      // Activation boundaries and pending/completed ACK mappings survive. A
      // re-added account needs a fresh directory scan, not abandoned page work.
      this.db.exec(`INSERT OR IGNORE INTO inbox_seen(message_id) SELECT message_id FROM inbox_staged;
        INSERT OR IGNORE INTO inbox_seen(message_id) SELECT message_id FROM inbox_event_discoveries;
        DELETE FROM inbox_staged; DELETE FROM inbox_routes; DELETE FROM directory_groups;
        UPDATE directory_recovery SET ready=0,completed_at=0,failed=0,listed_at=0 WHERE id=1; COMMIT;`)
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
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
  stopWork(seq, merged = []) {
    const stop = this.db.prepare(`UPDATE jobs SET state='stopped', issue='stopped_by_user', input='', reply=NULL, metadata=NULL
      WHERE seq=? AND state IN ('queued','running','ready','sending')`)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const stopped = stop.run(seq).changes > 0
      if (stopped) for (const item of merged) stop.run(item)
      this.db.exec('COMMIT')
      return stopped
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  discard(seq, issue, state = 'ignored') {
    this.db.prepare("UPDATE jobs SET state=?, issue=?, input='', reply=NULL, metadata=NULL WHERE seq=?").run(state, issue, seq)
  }
  close() { try { this.db?.close() } finally { this.lease.close() } }
}
