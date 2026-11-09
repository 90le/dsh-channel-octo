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
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY CHECK(id=1), identity TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS conversations (
          sender TEXT PRIMARY KEY, session_id TEXT NOT NULL, created INTEGER NOT NULL DEFAULT 0
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
      const columns = new Set(this.db.prepare('PRAGMA table_info(jobs)').all().map(row => row.name))
      if (!columns.has('channel_type')) this.db.exec('ALTER TABLE jobs ADD COLUMN channel_type INTEGER NOT NULL DEFAULT 1')
      if (!columns.has('channel_id')) this.db.exec('ALTER TABLE jobs ADD COLUMN channel_id TEXT')
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS jobs_by_route
          ON jobs(channel_type, COALESCE(channel_id, sender), seq) WHERE state IN ('queued','ready','running','sending');
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
      INSERT INTO jobs (message_id,event_id,sender,input,channel_type,channel_id) VALUES (?,?,?,?,?,?)
      ON CONFLICT(message_id) DO NOTHING
    `).run(m.messageId, eventId, m.sender, m.text, m.channelType ?? 1, m.channelId ?? m.sender)
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

  session(sender) {
    this.db.prepare('INSERT OR IGNORE INTO conversations (sender,session_id) VALUES (?,?)')
      .run(sender, 'session-' + randomUUID())
    return this.db.prepare('SELECT session_id,created FROM conversations WHERE sender=?').get(sender)
  }

  sessionCreated(sender) { this.db.prepare('UPDATE conversations SET created=1 WHERE sender=?').run(sender) }
  running(seq) { this.db.prepare("UPDATE jobs SET state='running' WHERE seq=?").run(seq) }
  ready(seq, reply) { this.db.prepare("UPDATE jobs SET state='ready', reply=? WHERE seq=?").run(reply, seq) }
  sending(seq) { this.db.prepare("UPDATE jobs SET state='sending', attempts=attempts+1 WHERE seq=?").run(seq) }
  sent(seq, id) { this.db.prepare("UPDATE jobs SET state='sent', result_id=?, input='', reply=NULL WHERE seq=?").run(id, seq) }
  retry(seq, at) { this.db.prepare("UPDATE jobs SET state='ready', next_ms=? WHERE seq=?").run(at, seq) }
  review(seq, issue) { this.db.prepare("UPDATE jobs SET state='review', issue=? WHERE seq=?").run(issue, seq) }
  close() { try { this.db?.close() } finally { this.lease.close() } }
}
