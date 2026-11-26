// 상태 저장소(bun:sqlite, WAL). 여러 메인 세션이 공유하고, 잡은 owner_session으로 나눈다.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface JobRow {
	job_id: string;
	gen: number;
	target: string;
	owner_session: string;
	repo_path: string;
	repo_id: string;
	base_sha: string;
	branch: string;
	model: string;
	est_min: number;
	state: string;
	failure: string | null;
	cap: string | null;
	last_seq: number;
	head: string | null;
	local_ref: string | null;
	evidence_sha256: string | null;
	checks_json: string;
	created_at: string;
	updated_at: string;
}

export interface EventRow {
	job_id: string;
	seq: number;
	ts: string;
	kind: string;
	data: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY, gen INTEGER NOT NULL, target TEXT NOT NULL, owner_session TEXT NOT NULL,
  repo_path TEXT NOT NULL, repo_id TEXT NOT NULL, base_sha TEXT NOT NULL, branch TEXT NOT NULL,
  model TEXT NOT NULL, est_min INTEGER NOT NULL, state TEXT NOT NULL, failure TEXT, cap TEXT,
  last_seq INTEGER NOT NULL DEFAULT 0, head TEXT, local_ref TEXT, evidence_sha256 TEXT,
  checks_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS jobs_owner ON jobs(owner_session, state);
CREATE INDEX IF NOT EXISTS jobs_target ON jobs(target, state);
CREATE TABLE IF NOT EXISTS events (
  job_id TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (job_id, seq));
CREATE TABLE IF NOT EXISTS messages (
  msg_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, reply_to TEXT, text TEXT NOT NULL,
  state TEXT NOT NULL, created_at TEXT NOT NULL);
-- 박스 풀 원장(원점). 신뢰 호스트의 원격 slots.json과 같은 역할: 반납은 박스 반납 증명이 있을 때만.
CREATE TABLE IF NOT EXISTS box_slots (
  job_id TEXT PRIMARY KEY, target TEXT NOT NULL, gen INTEGER NOT NULL, created_at TEXT NOT NULL,
  released_at TEXT, proof TEXT);
-- 깨움(AC-5). notified_seq: 메인에 알렸거나 메인이 직접 읽은(await·inbox) 마지막 seq.
CREATE TABLE IF NOT EXISTS notify_cursor (job_id TEXT PRIMARY KEY, seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notifies (
  notify_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, seq INTEGER NOT NULL, state TEXT NOT NULL,
  attempts INTEGER NOT NULL, sent_at TEXT NOT NULL, recorded_at TEXT, turn_at TEXT);
`;

/** 아직 대상 슬롯을 차지할 수 있는 상태(로컬 선예약 계산용). */
export const LIVE_STATES = ["reserving", "reserved", "staged", "launching", "running", "uncertain"];

export class Store {
	readonly db: Database;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.db = new Database(path, { create: true });
		this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
		this.db.exec(SCHEMA);
		this.db.run("INSERT OR IGNORE INTO meta(k, v) VALUES ('schema', '1')");
	}

	/**
	 * 시작 단계(reserving·reserved·staged)에 오래 머문 행은 그 잡을 시작하던 프로세스가 사라진 것이다.
	 * 원격 예약도 lease(기본 900초)가 지나면 회수되므로, 로컬에서도 실패로 닫아 슬롯을 돌려준다.
	 */
	reapAbandoned(olderThanMs: number, now = Date.now()): string[] {
		const cutoff = new Date(now - olderThanMs).toISOString();
		const rows = this.db
			.query("SELECT job_id FROM jobs WHERE state IN ('reserving', 'reserved', 'staged') AND updated_at < ?")
			.all(cutoff) as { job_id: string }[];
		for (const r of rows) {
			this.db.run("UPDATE jobs SET state = 'failed', failure = 'start_abandoned', updated_at = ? WHERE job_id = ? AND state IN ('reserving', 'reserved', 'staged')", [
				new Date(now).toISOString(),
				r.job_id,
			]);
		}
		return rows.map(r => r.job_id);
	}

	/** 박스 슬롯 예약(BEGIN IMMEDIATE로 직렬화). 같은 잡이 이미 있으면 그대로 성공. */
	boxReserve(target: string, job: string, gen: number, maxSlots: number): boolean {
		const tx = this.db.transaction(() => {
			if (this.db.query("SELECT 1 FROM box_slots WHERE job_id = ?").get(job)) return true;
			const n = (this.db.query("SELECT COUNT(*) AS n FROM box_slots WHERE target = ? AND released_at IS NULL").get(target) as { n: number }).n;
			if (n >= maxSlots) return false;
			this.db.run("INSERT INTO box_slots (job_id, target, gen, created_at) VALUES (?, ?, ?, ?)", [job, target, gen, new Date().toISOString()]);
			return true;
		});
		return tx.immediate();
	}

	/** 반납은 한 번만 일어난다(이미 반납됐으면 false). */
	boxRelease(job: string, proof: string): boolean {
		const r = this.db.run("UPDATE box_slots SET released_at = ?, proof = ? WHERE job_id = ? AND released_at IS NULL", [
			new Date().toISOString(),
			proof,
			job,
		]);
		return r.changes === 1;
	}

	boxOpen(target: string): string[] {
		return (this.db.query("SELECT job_id FROM box_slots WHERE target = ? AND released_at IS NULL").all(target) as { job_id: string }[]).map(r => r.job_id);
	}

	boxUsed(target: string): number {
		return (this.db.query("SELECT COUNT(*) AS n FROM box_slots WHERE target = ? AND released_at IS NULL").get(target) as { n: number }).n;
	}

	boxSlot(job: string): { target: string; gen: number; released_at: string | null; proof: string | null } | null {
		return (this.db.query("SELECT target, gen, released_at, proof FROM box_slots WHERE job_id = ?").get(job) as never) ?? null;
	}

	meta(k: string): string | undefined {
		return (this.db.query("SELECT v FROM meta WHERE k = ?").get(k) as { v: string } | null)?.v;
	}

	setMeta(k: string, v: string): void {
		this.db.run("INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [k, v]);
	}

	/**
	 * 로컬 선예약: 같은 대상의 살아 있는 잡 수가 상한보다 작을 때만 행을 넣는다.
	 * BEGIN IMMEDIATE로 같은 호스트의 병렬 start를 직렬화한다.
	 * 박스 슬롯을 반납 증명과 함께 돌려받은 잡은 세지 않는다(주인 세션이 끝나 잡 행이 살아 있는 상태로 남아도
	 * 박스에서는 끝났다는 증명이 있다).
	 */
	reserveLocal(row: JobRow, maxSlots: number): boolean {
		const tx = this.db.transaction(() => {
			const placeholders = LIVE_STATES.map(() => "?").join(",");
			const n = (this.db
				.query(
					`SELECT COUNT(*) AS n FROM jobs WHERE target = ? AND state IN (${placeholders})
					 AND job_id NOT IN (SELECT job_id FROM box_slots WHERE released_at IS NOT NULL)`,
				)
				.get(row.target, ...LIVE_STATES) as { n: number }).n;
			if (n >= maxSlots) return false;
			this.db
				.query(
					`INSERT INTO jobs (job_id, gen, target, owner_session, repo_path, repo_id, base_sha, branch, model, est_min,
					 state, failure, cap, last_seq, head, local_ref, evidence_sha256, checks_json, created_at, updated_at)
					 VALUES ($job_id, $gen, $target, $owner_session, $repo_path, $repo_id, $base_sha, $branch, $model, $est_min,
					 $state, $failure, $cap, $last_seq, $head, $local_ref, $evidence_sha256, $checks_json, $created_at, $updated_at)`,
				)
				.run(Object.fromEntries(Object.entries(row).map(([k, v]) => [`$${k}`, v])) as never);
			return true;
		});
		return tx.immediate();
	}

	job(jobId: string): JobRow | undefined {
		return (this.db.query("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as JobRow | null) ?? undefined;
	}

	jobs(owner?: string): JobRow[] {
		if (owner) return this.db.query("SELECT * FROM jobs WHERE owner_session = ? ORDER BY created_at").all(owner) as JobRow[];
		return this.db.query("SELECT * FROM jobs ORDER BY created_at").all() as JobRow[];
	}

	liveCount(target: string): number {
		const placeholders = LIVE_STATES.map(() => "?").join(",");
		return (this.db
			.query(`SELECT COUNT(*) AS n FROM jobs WHERE target = ? AND state IN (${placeholders})`)
			.get(target, ...LIVE_STATES) as { n: number }).n;
	}

	update(jobId: string, fields: Partial<JobRow>): void {
		const keys = Object.keys(fields);
		if (keys.length === 0) return;
		const set = keys.map(k => `${k} = $${k}`).join(", ");
		const params: Record<string, unknown> = { $job_id: jobId, $updated_at: new Date().toISOString() };
		for (const k of keys) params[`$${k}`] = (fields as Record<string, unknown>)[k];
		this.db.query(`UPDATE jobs SET ${set}, updated_at = $updated_at WHERE job_id = $job_id`).run(params as never);
	}

	/** 원격 이벤트를 미러에 넣는다(seq 중복은 무시). 들어간 것만 돌려준다. */
	addEvents(jobId: string, events: { seq: number; ts: string; kind: string; data: unknown }[]): EventRow[] {
		const added: EventRow[] = [];
		const ins = this.db.query("INSERT OR IGNORE INTO events (job_id, seq, ts, kind, data) VALUES (?, ?, ?, ?, ?)");
		const tx = this.db.transaction(() => {
			let maxSeq = 0;
			for (const e of events) {
				const data = JSON.stringify(e.data ?? {});
				const r = ins.run(jobId, e.seq, e.ts, e.kind, data);
				if (r.changes > 0) added.push({ job_id: jobId, seq: e.seq, ts: e.ts, kind: e.kind, data });
				maxSeq = Math.max(maxSeq, e.seq);
			}
			if (maxSeq > 0) this.db.run("UPDATE jobs SET last_seq = MAX(last_seq, ?) WHERE job_id = ?", [maxSeq, jobId]);
		});
		tx();
		return added;
	}

	eventsAfter(jobId: string, after: number, limit = 200): EventRow[] {
		return this.db
			.query("SELECT * FROM events WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?")
			.all(jobId, after, limit) as EventRow[];
	}

	maxSeq(jobId: string): number {
		return ((this.db.query("SELECT MAX(seq) AS m FROM events WHERE job_id = ?").get(jobId) as { m: number | null }).m ?? 0);
	}

	addMessage(msgId: string, jobId: string, replyTo: string | null, text: string): void {
		this.db.run("INSERT OR IGNORE INTO messages (msg_id, job_id, reply_to, text, state, created_at) VALUES (?, ?, ?, ?, 'pending', ?)", [
			msgId,
			jobId,
			replyTo,
			text,
			new Date().toISOString(),
		]);
	}

	setMessageState(msgId: string, state: string): void {
		this.db.run("UPDATE messages SET state = ? WHERE msg_id = ?", [state, msgId]);
	}

	notifiedSeq(jobId: string): number {
		return ((this.db.query("SELECT seq FROM notify_cursor WHERE job_id = ?").get(jobId) as { seq: number } | null)?.seq ?? 0);
	}

	/** 알림 위치는 앞으로만 간다. */
	advanceNotified(jobId: string, seq: number): void {
		this.db.run(
			"INSERT INTO notify_cursor (job_id, seq) VALUES (?, ?) ON CONFLICT(job_id) DO UPDATE SET seq = MAX(seq, excluded.seq)",
			[jobId, seq],
		);
	}

	addNotify(notifyId: string, jobId: string, seq: number): void {
		this.db.run(
			`INSERT INTO notifies (notify_id, job_id, seq, state, attempts, sent_at) VALUES (?, ?, ?, 'sent', 1, ?)
			 ON CONFLICT(notify_id) DO UPDATE SET attempts = attempts + 1, sent_at = excluded.sent_at`,
			[notifyId, jobId, seq, new Date().toISOString()],
		);
	}

	/** 관측: recorded(대화 기록에 들어감) → turn_started(그 뒤 새 턴). 뒤로 가지 않는다. */
	markNotify(notifyId: string, state: "recorded" | "turn_started" | "unknown"): boolean {
		const now = new Date().toISOString();
		if (state === "recorded") {
			return this.db.run("UPDATE notifies SET state = 'recorded', recorded_at = ? WHERE notify_id = ? AND state IN ('sent', 'unknown')", [now, notifyId]).changes === 1;
		}
		if (state === "turn_started") {
			return this.db.run("UPDATE notifies SET state = 'turn_started', turn_at = ? WHERE notify_id = ? AND state = 'recorded'", [now, notifyId]).changes === 1;
		}
		return this.db.run("UPDATE notifies SET state = 'unknown' WHERE notify_id = ? AND state = 'sent'", [notifyId]).changes === 1;
	}

	notify(notifyId: string): { notify_id: string; job_id: string; seq: number; state: string; attempts: number; sent_at: string } | null {
		return (this.db.query("SELECT * FROM notifies WHERE notify_id = ?").get(notifyId) as never) ?? null;
	}

	notifies(jobId: string): { notify_id: string; seq: number; state: string; attempts: number }[] {
		return this.db.query("SELECT notify_id, seq, state, attempts FROM notifies WHERE job_id = ? ORDER BY seq").all(jobId) as never;
	}

	close(): void {
		this.db.close();
	}
}
