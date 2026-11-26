// remote_task 동작 본체. 도구 껍데기(tool.ts)와 분리해 시험에서 직접 부른다.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { loadConfig, rtHome, type RtConfig } from "./core/config";
import { makeCursor, parseCursor } from "./core/cursor";
import { git, GitError, makeBaseBundle, repoFacts, sha256File, verifyAndImport } from "./core/gitops";
import { evaluate, localSnapshot, type TargetProbe } from "./core/rules";
import { assertTransition, type JobState, newJobId, newMsgId, phaseOf } from "./core/state";
import { type EventRow, type JobRow, Store } from "./core/store";
import { BoxCheckError, boxPreflight, githubSlug, isPublicRepo, loadFingerprints } from "./core/boxcheck";
import { BoxTransport } from "./transport/box";
import { RemoteError, readSecretFile, SshTransport } from "./transport/ssh";

type Transport = SshTransport | BoxTransport;

export class ToolFailure extends Error {
	constructor(
		readonly code: string,
		readonly extra: Record<string, unknown> = {},
	) {
		super(code);
	}
}

export interface CheckSpec {
	id: string;
	cmd: string;
	timeout_s?: number;
}

export interface StartInput {
	target: string;
	task: string;
	context?: string;
	constraints?: string;
	acceptance?: string;
	checks?: CheckSpec[];
	estimated_minutes: number;
	model?: string;
	base_ref?: string;
	repo?: string;
	verify?: "runner" | "off";
	/** 작업에 필요한 특권(박스는 받지 않는다: box_needs_privilege). */
	needs?: ("docker" | "sudo")[];
}

const INBOX_KINDS = new Set(["question", "final", "progress", "error", "ended", "verify", "commit", "started", "consumed", "answer_consumed", "role_check"]);

/** 원격 문자열은 데이터다. 태그로 감싸고, 닫는 태그 흉내를 지운다(P-3). */
export function wrapRemote(job: string, events: EventRow[]): string {
	const body = events
		.map(e => {
			const data = e.data.replaceAll("</remote-task-inbox", "<\\/remote-task-inbox");
			return `{"seq":${e.seq},"ts":"${e.ts}","kind":"${e.kind}","data":${data}}`;
		})
		.join("\n");
	return `<remote-task-inbox job="${job}">\n${body}\n</remote-task-inbox>`;
}

/** 저장소 경로: 없으면 세션 cwd. 모델은 `~/…`나 상대 경로를 흔히 준다(G007 측정에서 `~/tmp/…`가 repo_not_found로 한 번 헛돎).
 * `~`는 홈으로, 상대 경로는 세션 cwd 기준으로 푼다(`~user` 형태는 풀지 않는다 — cwd 아래 상대 경로가 되어 없으면 repo_not_found). */
export function repoPath(repo: string | undefined, cwd: string): string {
	if (!repo) return cwd;
	if (repo === "~") return homedir();
	if (repo.startsWith("~/")) return join(homedir(), repo.slice(2));
	return isAbsolute(repo) ? repo : resolve(cwd, repo);
}

export class RemoteTasks {
	readonly home: string;
	readonly config: RtConfig;
	readonly store: Store;
	private readonly transports = new Map<string, Transport>();
	/** 박스 투입 전 검사 주입점(시험용). */
	boxFetch: typeof fetch = fetch;
	private readonly background = new Map<string, Promise<void>>();
	/** 메인이 await 중인 잡(깨움 생략용). 값은 겹친 await 수. */
	private readonly awaiting = new Map<string, number>();

	isAwaiting(jobId: string): boolean {
		return (this.awaiting.get(jobId) ?? 0) > 0;
	}

	constructor(opts: { home?: string; config?: RtConfig } = {}) {
		this.home = opts.home ?? rtHome();
		mkdirSync(this.home, { recursive: true, mode: 0o700 });
		this.config = opts.config ?? loadConfig(join(this.home, "config.yml"));
		this.store = new Store(join(this.home, "state.db"));
		// 원격 예약 lease(900초)보다 넉넉히 지난 시작 단계 행만 닫는다.
		this.store.reapAbandoned(20 * 60_000);
	}

	transport(target: string): Transport {
		const t = this.config.targets[target];
		if (!t) throw new ToolFailure("unknown_target", { target });
		let tr = this.transports.get(target);
		if (!tr) {
			tr = t.kind === "box" ? new BoxTransport(target, t, this.home, this.config, this.store) : new SshTransport(target, t, this.home, this.config.sshConnectTimeoutS);
			this.transports.set(target, tr);
		}
		return tr;
	}

	isBox(target: string): boolean {
		return this.config.targets[target]?.kind === "box";
	}

	private regAuth(target: string): string {
		// 박스는 원점의 원장과 instabox-q 계정 키로 움직인다. 호스트 등록 토큰이 없다.
		if (this.isBox(target)) return "";
		const p = join(this.home, "hosts", `${target}.token`);
		if (!existsSync(p)) throw new ToolFailure("credential_missing", { target, detail: "host token" });
		return `reg ${readSecretFile(p)}`;
	}

	private capAuth(job: JobRow): string {
		if (!job.cap) throw new ToolFailure("job_not_started", { job_id: job.job_id });
		return `cap ${job.owner_session} ${job.cap}`;
	}

	private jobDir(job: string): string {
		return join(this.home, "jobs", job);
	}

	private setState(job: JobRow, to: JobState, extra: Partial<JobRow> = {}): void {
		const cur = this.store.job(job.job_id)!;
		assertTransition(cur.state, to);
		this.store.update(job.job_id, { state: to, ...extra });
	}

	ownJob(jobId: string, session: string): JobRow {
		const job = this.store.job(jobId);
		if (!job || job.owner_session !== session) throw new ToolFailure("job_unknown", { job_id: jobId });
		return job;
	}

	// ------------------------------------------------------------------ plan (P-2: 쓰기·깨우기 없음)

	async probe(target: string, model: string, repoId?: string, estMin?: number): Promise<TargetProbe> {
		try {
			const args = ["--model", model, ...(repoId ? ["--repo", repoId] : []), ...(this.isBox(target) && estMin ? ["--est", String(estMin)] : [])];
			return (await this.transport(target).call<TargetProbe>("probe", args, { timeoutMs: 30_000 })) as TargetProbe;
		} catch (e) {
			if (e instanceof RemoteError) return { error: e.code };
			if (e instanceof ToolFailure) return { error: e.code };
			return { error: "unreachable" };
		}
	}

	async plan(input: { repo?: string; estimated_minutes?: number; model?: string; cwd: string }) {
		const model = input.model ?? this.config.defaultModel;
		const planDir = repoPath(input.repo, input.cwd);
		const facts = existsSync(planDir) ? await repoFacts(planDir).catch(() => null) : null;
		const names = Object.keys(this.config.targets);
		const probes: Record<string, TargetProbe> = {};
		await Promise.all(names.map(async n => (probes[n] = await this.probe(n, model, undefined, input.estimated_minutes))));
		const localLive: Record<string, number> = {};
		for (const n of names) localLive[n] = this.isBox(n) ? this.store.boxUsed(n) : this.store.liveCount(n);
		// 박스는 공개 원본만 받는다(AC-12). 익명 API 조회 하나로 판정한다(쓰기·박스 깨우기 없음).
		const boxRejections: string[] = [];
		if (names.some(n => this.isBox(n))) {
			const slug = githubSlug(facts?.originUrl ?? null);
			if (!slug || !(await isPublicRepo(slug, this.boxFetch))) boxRejections.push("origin_not_public");
		}
		const out = evaluate({
			config: this.config,
			local: localSnapshot(),
			model,
			repo: { dirty: facts?.dirty ?? false, submodules: facts?.submodules ?? false },
			probes,
			localLive,
			repoRejections: { box: boxRejections, ssh: facts?.shallow ? ["shallow_repo"] : [] },
		});
		return { ...out, model, repo: facts ? { root: facts.root, base: facts.baseSha, dirty: facts.dirty } : { error: existsSync(planDir) ? "not_a_git_repo" : "repo_not_found", path: planDir } };
	}

	// ------------------------------------------------------------------ start

	async start(input: StartInput, ctx: { session: string; cwd: string }) {
		const target = input.target;
		const tcfg = this.config.targets[target];
		if (!tcfg) throw new ToolFailure("unknown_target", { target });
		const model = input.model ?? this.config.defaultModel;
		if (!model) throw new ToolFailure("model_required", { hint: "model 인자나 config.yml defaultModel" });
		const repoDir = repoPath(input.repo, ctx.cwd);
		// 없는 경로를 cwd로 주면 git 실행이 ENOENT('git')로 실패해 git이 없는 것처럼 보인다. 경로를 먼저 본다.
		if (!existsSync(repoDir)) throw new ToolFailure("repo_not_found", { repo: repoDir });
		const pre: Record<string, number> = {};
		let p0 = performance.now();
		const plap = (k: string) => {
			const now = performance.now();
			pre[k] = Math.round(now - p0);
			p0 = now;
		};
		const facts = await repoFacts(repoDir, input.base_ref ?? "HEAD").catch(e => {
			throw new ToolFailure("not_a_git_repo", { detail: String(e).slice(0, 200) });
		});
		plap("pre_facts");
		const estMin = Math.max(1, Math.min(480, Math.round(input.estimated_minutes)));
		// 박스: 공개 원본·공개 기준 커밋·미push 범위와 작업 지시의 비밀 검사를 먼저 한다(§5.9, AC-12·AC-14).
		let box: Awaited<ReturnType<typeof boxPreflight>> | null = null;
		if (this.isBox(target)) {
			if ((input.needs ?? []).length > 0) throw new ToolFailure("target_rejected", { target, reasons: ["box_needs_privilege"] });
			try {
				box = await boxPreflight({
					repo: facts.root,
					originUrl: facts.originUrl,
					base: facts.baseSha,
					taskText: renderTask(input),
					fingerprints: loadFingerprints(join(this.home, "box", "fingerprints.json")),
					fetchImpl: this.boxFetch,
				});
			} catch (e) {
				if (e instanceof BoxCheckError) throw new ToolFailure("target_rejected", { target, reasons: [e.code], ...e.detail });
				throw e;
			}
		}
		plap("pre_boxcheck");
		// start 시점에 규칙을 다시 평가한다. 대상이 부적격이면 거절하고 다른 대상으로 바꾸지 않는다.
		const probe = await this.probe(target, model, facts.repoId, estMin);
		plap("pre_probe");
		const rule = evaluate({
			config: { ...this.config, targets: { [target]: tcfg } },
			local: localSnapshot(),
			model,
			repo: { dirty: facts.dirty, submodules: facts.submodules },
			probes: { [target]: probe },
			localLive: { [target]: this.isBox(target) ? this.store.boxUsed(target) : this.store.liveCount(target) },
			repoRejections: { ssh: facts.shallow ? ["shallow_repo"] : [] },
		});
		if (rule.noTarget) throw new ToolFailure("target_rejected", { target, reasons: rule.rejections[target] ?? [] });

		const jobId = newJobId();
		const now = new Date().toISOString();
		const row: JobRow = {
			job_id: jobId,
			gen: 1,
			target,
			owner_session: ctx.session,
			repo_path: facts.root,
			repo_id: facts.repoId,
			base_sha: facts.baseSha,
			branch: `rt/${jobId}`,
			model,
			est_min: estMin,
			state: "reserving",
			failure: null,
			cap: null,
			last_seq: 0,
			head: null,
			local_ref: null,
			evidence_sha256: null,
			checks_json: JSON.stringify(input.checks ?? []),
			created_at: now,
			updated_at: now,
		};
		if (!this.store.reserveLocal(row, tcfg.maxSlots)) throw new ToolFailure("target_rejected", { target, reasons: ["slots_full"] });
		let reserve: { cap: string; gjc_installed: boolean };
		try {
			reserve = await this.transport(target).call("reserve", [jobId, 1, row.est_min, ctx.session, this.config.gjcVersion, model], {
				auth: this.regAuth(target),
				timeoutMs: 60_000,
			});
		} catch (e) {
			const code = e instanceof RemoteError || e instanceof ToolFailure ? e.code : "reserve_failed";
			// 대상이 응답하지 않아 예약 여부를 모르면 uncertain으로 두고 같은 대상에서 맞춘다(자동 재시작 없음).
			if (code === "unreachable") {
				this.setState(row, "failed", { failure: "reserve_uncertain" });
			} else {
				this.setState(row, "failed", { failure: code });
			}
			throw new ToolFailure(code === "unreachable" ? "unreachable" : code, { target, job_id: jobId });
		}
		plap("pre_reserve");
		this.setState(row, "reserved", { cap: reserve.cap });
		mkdirSync(this.jobDir(jobId), { recursive: true, mode: 0o700 });
		const taskMd = renderTask(input);
		writeFileSync(join(this.jobDir(jobId), "task.md"), taskMd, { mode: 0o600 });
		if (box) writeFileSync(join(this.jobDir(jobId), "box.json"), JSON.stringify(box), { mode: 0o600 });
		const bg = this.stageAndLaunch(jobId, taskMd, input, reserve.gjc_installed, pre).catch(() => {});
		this.background.set(jobId, bg);
		bg.finally(() => this.background.delete(jobId));
		return {
			job_id: jobId,
			target,
			phase: phaseOf("reserved"),
			state: "reserved",
			branch: row.branch,
			base: facts.baseSha,
			cursor: makeCursor(this.store, jobId, 0),
			local_ref_on_collect: `refs/heads/remote/${target}/${jobId}`,
		};
	}

	/** reserve 뒤 단계: 기준 bundle 업로드 → prepare → (필요시 gjc 설치) → launch. */
	/** pre: start 앞 단계(저장소 사실·박스 사전검사·probe·reserve) 소요 ms. timing-start.json에 함께 남긴다. */
	private async stageAndLaunch(jobId: string, taskMd: string, input: StartInput, gjcInstalled: boolean, pre: Record<string, number>): Promise<void> {
		const job = this.store.job(jobId)!;
		const tr = this.transport(job.target);
		const auth = this.capAuth(job);
		// 단계별 소요(ms)를 잡 폴더 timing-start.json에 남긴다(시작 지연 분석용, 비밀 없음).
		const timing: Record<string, number> = { ...pre };
		let t0 = performance.now();
		const lap = (k: string) => {
			const now = performance.now();
			timing[k] = Math.round(now - t0);
			t0 = now;
		};
		const saveTiming = () => {
			try {
				writeFileSync(join(this.jobDir(jobId), "timing-start.json"), JSON.stringify(timing), { mode: 0o600 });
			} catch {}
		};
		try {
			if (!gjcInstalled) {
				const sha = sha256File(this.config.gjcBinary);
				await tr.call("install-gjc", [this.config.gjcVersion, sha], {
					auth: this.regAuth(job.target),
					bodyFile: this.config.gjcBinary,
					timeoutMs: 15 * 60_000,
				});
			}
			const box = this.isBox(job.target) ? (JSON.parse(readFileSync(join(this.jobDir(jobId), "box.json"), "utf8")) as { publicUrl: string; publicSha: string }) : null;
			// 박스는 공개 원본을 익명으로 받으므로 공개 기준 커밋까지는 이미 가진 것으로 본다.
			lap("install");
			const held = box ? [box.publicSha] : (((await tr.call<{ held?: string[] }>("probe", ["--repo", job.repo_id], { timeoutMs: 30_000 })) ?? {}).held ?? []);
			lap("held");
			if (!held.includes(job.base_sha)) {
				const bundlePath = join(this.jobDir(jobId), "base.bundle");
				const res = await makeBaseBundle(job.repo_path, job.base_sha, held, bundlePath, `refs/rt-base/${jobId}`);
				if (!res.empty) {
					await tr.call("upload-base", [jobId], { auth, bodyFile: bundlePath, timeoutMs: 60 * 60_000 });
				}
				rmSync(bundlePath, { force: true });
			}
			lap("base");
			const manifest = {
				repo_id: job.repo_id,
				base_sha: job.base_sha,
				task_md: taskMd,
				checks: input.checks ?? [],
				verify: input.verify ?? "runner",
				// 박스에는 rt-helper가 없으므로 잡 정보와 공개 원본을 manifest에 함께 싣는다.
				...(box
					? { job: jobId, gen: job.gen, model: job.model, est_min: job.est_min, gjc_version: this.config.gjcVersion, public_url: box.publicUrl, public_sha: box.publicSha }
					: {}),
			};
			await tr.call("prepare", [jobId, job.gen], { auth, body: JSON.stringify(manifest), timeoutMs: 30 * 60_000 });
			lap("prepare");
			this.setState(job, "staged");
		} catch (e) {
			const code = e instanceof RemoteError || e instanceof GitError || e instanceof ToolFailure ? e.code : "stage_failed";
			// 시작 전 실패는 원격 슬롯도 바로 반납한다(cancel이 봉인 + 반납).
			await tr.call("cancel", [jobId, job.gen], { auth, timeoutMs: 60_000 }).catch(() => {});
			// 실행 전이라 회수할 커밋이 없다. 올린 기준 bundle·작업 디렉터리를 바로 지운다.
			await tr.call("cleanup", [jobId], { auth, timeoutMs: 10 * 60_000 }).catch(() => {});
			this.setState(job, "failed", { failure: code });
			return;
		}
		this.setState(job, "launching");
		try {
			const r = await tr.call<{ invocation?: string }>("launch", [jobId, job.gen], { auth, timeoutMs: 120_000 });
			lap("launch");
			saveTiming();
			this.setState(job, "running");
			void r;
		} catch (e) {
			const code = e instanceof RemoteError ? e.code : "launch_failed";
			// launch 이후는 결과가 불확실할 수 있다. 연결 실패면 uncertain으로 두고 status로 맞춘다.
			if (code === "unreachable" || code === "remote_failed") this.setState(job, "uncertain", { failure: code });
			else this.setState(job, "failed", { failure: code });
		}
	}

	/** 시험·종료용: 백그라운드 시작 단계가 끝날 때까지 기다린다. */
	async settle(jobId?: string): Promise<void> {
		if (jobId) await this.background.get(jobId);
		else await Promise.all([...this.background.values()]);
	}

	// ------------------------------------------------------------------ 이벤트 동기화

	/** 원격 events를 받아 미러에 넣는다. 원격 상태(ended 등)를 로컬 상태에 반영한다. */
	async sync(job: JobRow, waitS = 0, opts: { throwCleaned?: boolean } = {}): Promise<EventRow[]> {
		const cur = this.store.job(job.job_id)!;
		if (!["running", "launching", "uncertain", "ended", "failed", "verified"].includes(cur.state) || !cur.cap) return [];
		const tr = this.transport(cur.target);
		let res: { events: { seq: number; ts: string; kind: string; data: unknown }[]; last_seq: number };
		try {
			res = await tr.call("events", [cur.job_id, cur.last_seq, "--wait", Math.min(50, waitS), "--max", 200], {
				auth: this.capAuth(cur),
				timeoutMs: (waitS + 30) * 1000,
			});
		} catch (e) {
			if (e instanceof RemoteError && e.code === "job_cleaned" && !opts.throwCleaned) return [];
			throw e;
		}
		const added = this.store.addEvents(cur.job_id, res.events);
		const after = this.store.job(cur.job_id)!;
		if (added.some(e => e.kind === "started") && (after.state === "launching" || after.state === "uncertain")) {
			this.setState(after, "running");
		}
		const ended = added.find(e => e.kind === "ended");
		if (ended) {
			const st = this.store.job(cur.job_id)!.state;
			if (["running", "launching", "uncertain"].includes(st)) {
				const d = JSON.parse(ended.data) as { head?: string };
				this.setState(this.store.job(cur.job_id)!, "ended", { head: d.head ?? null });
			}
		}
		return added;
	}

	// ------------------------------------------------------------------ inbox / await / send

	async inbox(jobId: string, cursor: string | undefined, session: string) {
		const job = this.ownJob(jobId, session);
		await this.sync(job, 0).catch(() => {});
		const lastSeq = this.store.maxSeq(jobId);
		const c = parseCursor(this.store, jobId, cursor, lastSeq);
		if (!c.ok) throw new ToolFailure(c.error, { job_id: jobId });
		const events = this.store.eventsAfter(jobId, c.seq, 100).filter(e => INBOX_KINDS.has(e.kind));
		const next = events.length > 0 ? events[events.length - 1]!.seq : c.seq;
		const tail = this.store.eventsAfter(jobId, c.seq, 100);
		const nextSeq = Math.max(next, tail.length > 0 ? tail[tail.length - 1]!.seq : c.seq);
		this.store.advanceNotified(jobId, nextSeq);
		const cur = this.store.job(jobId)!;
		return {
			job_id: jobId,
			phase: phaseOf(cur.state),
			state: cur.state,
			items: events.length,
			more: this.store.eventsAfter(jobId, nextSeq, 1).length > 0,
			content: events.length > 0 ? wrapRemote(jobId, events) : "",
			next_cursor: makeCursor(this.store, jobId, nextSeq),
		};
	}

	async await(jobId: string, cursor: string | undefined, until: "question" | "ended" | "any" | "ended_or_question", timeoutS: number, session: string, signal?: AbortSignal) {
		const job = this.ownJob(jobId, session);
		const lastSeq = this.store.maxSeq(jobId);
		// 종료 이벤트는 잡마다 하나뿐이라 위치가 필요 없다: until=ended에서 cursor를 생략하면 처음부터 찾는다.
		// 커서를 주면 늘 검사한다(잘못된 커서는 실패, AC-6).
		const c = !cursor && until.startsWith("ended") ? ({ ok: true, seq: 0 } as const) : parseCursor(this.store, jobId, cursor, lastSeq);
		if (!c.ok) throw new ToolFailure(c.error, { job_id: jobId });
		const deadline = Date.now() + Math.min(1800, Math.max(1, timeoutS)) * 1000;
		const match = (e: EventRow) =>
			until === "any"
				? e.kind !== "consumed" && e.kind !== "progress"
				: until === "question"
					? e.kind === "question"
					: until === "ended_or_question"
						? e.kind === "ended" || (e.kind === "question" && e.seq > lastSeq) // 이 호출 뒤에 온 새 질문만(이미 본 질문은 다시 돌려주지 않는다)
						: e.kind === "ended";
		this.awaiting.set(jobId, (this.awaiting.get(jobId) ?? 0) + 1);
		try {
			return await this.awaitLoop(job, c.seq, deadline, match, signal);
		} finally {
			const n = (this.awaiting.get(jobId) ?? 1) - 1;
			if (n > 0) this.awaiting.set(jobId, n);
			else this.awaiting.delete(jobId);
		}
	}

	/** await 뒤 종료가 맞으면 같은 호출에서 collect(final)까지 한다. 종료가 아니면(시간 초과·질문 등) await 결과만 돌려준다. */
	async awaitThenCollect(jobId: string, cursor: string | undefined, until: "question" | "ended" | "any", timeoutS: number, collect: "final" | undefined, session: string, signal?: AbortSignal) {
		// 회수까지 기다리는 동안 원격 질문이 오면 메인이 답해야 하므로 질문에서도 돌아온다(답이 없으면 원격이 멈춘다).
		const a: Record<string, unknown> = await this.await(jobId, cursor, collect ? "ended_or_question" : until, timeoutS, session, signal);
		if (!collect || a.matched !== "ended") return a;
		const c = await this.collect(jobId, "final", session, { synced: true });
		return { ...c, awaited: { matched: a.matched, seq: a.seq }, note: "종료를 확인하고 collect(final)까지 했다. 원격 이벤트는 inbox로 cursor 이후를 읽는다." };
	}

	private async awaitLoop(job: JobRow, after: number, deadline: number, match: (e: EventRow) => boolean, signal?: AbortSignal) {
		const jobId = job.job_id;
		while (!signal?.aborted) {
			const hit = this.store.eventsAfter(jobId, after, 1000).find(match);
			if (hit) {
				// await가 돌려준 일은 메인이 이미 안다. 그 위치까지는 깨우지 않는다.
				this.store.advanceNotified(jobId, hit.seq);
				const cur = this.store.job(jobId)!;
				return { job_id: jobId, matched: hit.kind, seq: hit.seq, phase: phaseOf(cur.state), state: cur.state, note: "inbox로 cursor 이후 내용을 읽는다. 커서는 옮기지 않았다." };
			}
			const cur = this.store.job(jobId)!;
			if (["collected"].includes(cur.state) || (["failed"].includes(cur.state) && !cur.cap)) {
				return { job_id: jobId, matched: null, state: cur.state, phase: phaseOf(cur.state), failure: cur.failure };
			}
			const left = Math.floor((deadline - Date.now()) / 1000);
			if (left <= 0) break;
			if (["reserved", "staged", "reserving"].includes(cur.state)) {
				await Bun.sleep(Math.min(2000, left * 1000));
				continue;
			}
			try {
				await this.sync(job, Math.min(25, left), { throwCleaned: true });
			} catch (e) {
				if (e instanceof RemoteError && e.code === "job_cleaned") {
					// 원격이 이미 정리됐다(예: 시작 단계 실패 뒤 정리, 보관 기간 만료). 더 올 이벤트가 없으니 기다리지 않는다.
					// 이게 없으면 cap이 남은 failed 잡에서 deadline까지 sync를 쉬지 않고 되풀이한다.
					const fin = this.store.job(jobId)!;
					if (fin.state === "failed") {
						// 실패를 await 결과로 메인에 돌려준다. 자동 깨움(watcher)이 같은 실패로 한 번 더 깨우지 않게 알린 것으로 적는다.
						this.store.addNotify(`${jobId}:failed`, jobId, this.store.maxSeq(jobId));
						this.store.markNotify(`${jobId}:failed`, "recorded");
					}
					return { job_id: jobId, matched: null, state: fin.state, phase: phaseOf(fin.state), failure: fin.failure, remote_cleaned: true };
				}
				if (e instanceof RemoteError && e.code === "unreachable") {
					await Bun.sleep(Math.min(5000, left * 1000));
					continue;
				}
				throw e;
			}
		}
		const cur = this.store.job(jobId)!;
		return { job_id: jobId, matched: null, timed_out: true, phase: phaseOf(cur.state), state: cur.state };
	}

	async send(jobId: string, text: string, replyTo: string | undefined, session: string) {
		const job = this.ownJob(jobId, session);
		if (!["running", "uncertain", "launching"].includes(job.state)) throw new ToolFailure("job_not_running", { job_id: jobId, state: job.state });
		if (replyTo !== undefined && !/^q-[0-9a-z-]{3,40}$/.test(replyTo)) throw new ToolFailure("bad_reply_to");
		const body = Buffer.from(text, "utf8");
		if (body.length > 64 * 1024) throw new ToolFailure("payload_too_large");
		const msgId = newMsgId();
		this.store.addMessage(msgId, jobId, replyTo ?? null, text);
		try {
			const r = await this.transport(job.target).call<{ duplicate: boolean }>("send", [jobId, msgId, replyTo ?? "-"], {
				auth: this.capAuth(job),
				body,
				timeoutMs: 60_000,
			});
			this.store.setMessageState(msgId, "delivered");
			return { job_id: jobId, msg_id: msgId, delivered: true, duplicate: r.duplicate };
		} catch (e) {
			this.store.setMessageState(msgId, "failed");
			throw new ToolFailure(e instanceof RemoteError ? e.code : "send_failed", { job_id: jobId, msg_id: msgId });
		}
	}

	// ------------------------------------------------------------------ status / cancel

	async status(jobId: string | undefined, session: string) {
		if (!jobId) {
			return {
				jobs: this.store.jobs(session).map(j => ({
					job_id: j.job_id,
					target: j.target,
					phase: phaseOf(j.state),
					state: j.state,
					failure: j.failure,
					last_seq: j.last_seq,
					local_ref: j.local_ref,
				})),
			};
		}
		const job = this.ownJob(jobId, session);
		let remote: Record<string, unknown> | { error: string } | null = null;
		if (job.cap && job.state !== "collected") {
			try {
				remote = await this.transport(job.target).call("status", [jobId], { auth: this.capAuth(job), timeoutMs: 60_000 });
				await this.reconcile(job, remote as Record<string, unknown>);
			} catch (e) {
				remote = { error: e instanceof RemoteError ? e.code : "status_failed" };
			}
		}
		const cur = this.store.job(jobId)!;
		return {
			job_id: jobId,
			target: cur.target,
			phase: phaseOf(cur.state),
			state: cur.state,
			failure: cur.failure,
			branch: cur.branch,
			base: cur.base_sha,
			head: cur.head,
			last_seq: cur.last_seq,
			local_ref: cur.local_ref,
			evidence_sha256: cur.evidence_sha256,
			// 자동 깨움 기록(recorded·turn_started·unknown). unknown이면 monitor로 cli.ts watch를 붙일 수 있다.
			notifies: this.store.notifies(jobId),
			remote,
		};
	}

	/** 원격 status로 로컬 상태를 맞춘다(불확실한 launch 등). 자동 재시작은 하지 않는다(P-5). */
	private async reconcile(job: JobRow, remote: Record<string, unknown>): Promise<void> {
		const st = this.store.job(job.job_id)!.state;
		const unit = (remote.unit ?? {}) as { ActiveState?: string };
		const rstate = remote.state as string | undefined;
		if ((st === "uncertain" || st === "launching") && (unit.ActiveState === "active" || rstate === "launched")) {
			this.setState(job, "running");
		} else if (["uncertain", "launching", "running"].includes(st) && (remote.ended || rstate === "ended")) {
			await this.sync(job, 0).catch(() => {});
			const now = this.store.job(job.job_id)!;
			if (now.state !== "ended") this.setState(now, "ended");
		} else if (["uncertain", "launching", "running"].includes(st) && rstate === "failed") {
			this.setState(job, "failed", { failure: (remote.failure as string) ?? "remote_failed" });
		}
	}

	async cancel(jobId: string, session: string) {
		const job = this.ownJob(jobId, session);
		if (job.state === "collected") throw new ToolFailure("job_collected");
		if (job.state === "reserving") throw new ToolFailure("job_not_started");
		await this.background.get(jobId);
		const cur = this.store.job(jobId)!;
		const r = await this.transport(cur.target).call<{ unit?: string; ended?: unknown }>("cancel", [jobId, cur.gen], {
			auth: this.capAuth(cur),
			timeoutMs: 6 * 60_000,
		});
		await this.sync(cur, 0).catch(() => {});
		const after = this.store.job(jobId)!;
		if (["running", "launching", "uncertain"].includes(after.state)) this.setState(after, r.ended ? "ended" : "uncertain", { failure: "cancelled" });
		else if (["reserved", "staged"].includes(after.state)) this.setState(after, "failed", { failure: "cancelled_before_launch" });
		const fin = this.store.job(jobId)!;
		return { job_id: jobId, sealed: true, phase: phaseOf(fin.state), state: fin.state, remote_unit: r.unit ?? null, note: "partial collect로 남은 커밋을 가져올 수 있다." };
	}

	// ------------------------------------------------------------------ collect

	async collect(jobId: string, mode: "final" | "partial", session: string, opts: { synced?: boolean } = {}) {
		const job = this.ownJob(jobId, session);
		if (job.state === "collected") throw new ToolFailure("job_collected", { local_ref: job.local_ref });
		if (!job.cap) throw new ToolFailure("job_not_started");
		// 단계별 소요(ms): 회수 지연을 결과에서 바로 볼 수 있게 남긴다.
		const timing: Record<string, number> = {};
		let t0 = performance.now();
		const lap = (k: string) => {
			const now = performance.now();
			timing[k] = Math.round(now - t0);
			t0 = now;
		};
		// await가 방금 종료까지 맞춰 왔으면 다시 맞추지 않는다(ssh 왕복 하나).
		if (!opts.synced) await this.sync(job, 0).catch(() => {});
		lap("sync");
		const tr = this.transport(job.target);
		const auth = this.capAuth(job);
		const st = await tr.call<{ work?: { done?: unknown }; unit?: { ActiveState?: string }; cleaned?: boolean }>("status", [jobId], { auth, timeoutMs: 60_000 });
		lap("status");
		if (st.cleaned) {
			// 원격 보관 기간(7일)이 지나 gc가 지웠다. 더 가져올 것이 없다. 이미 가져온 로컬 ref는 그대로 둔다.
			const cur = this.store.job(jobId)!;
			this.store.update(jobId, { state: "collected", failure: cur.failure ?? "remote_expired" });
			if (cur.state === "failed" && cur.failure && !this.store.eventsAfter(jobId, 0, 1000).some(e => e.kind === "started")) {
				// 시작 단계 실패: 실행 전이라 원격을 바로 정리했다(stageAndLaunch). 보관 기간 만료가 아니다.
				throw new ToolFailure("job_failed", { job_id: jobId, failure: cur.failure, hint: "시작 단계에서 실패해 원격은 이미 정리됐다. 가져올 결과가 없다." });
			}
			throw new ToolFailure("remote_expired", { job_id: jobId, local_ref: cur.local_ref, hint: "원격 결과가 보관 기간(7일) 뒤 정리됐다." });
		}
		const done = Boolean(st.work?.done);
		if (mode === "final" && !done && (st as { ended?: unknown }).ended) {
			// 원격이 결과 없이 끝났다(예: 박스 대기줄 작업이 준비 전에 실패). 가져올 것이 없으니 원격을 정리하고 닫는다.
			// 이게 없으면 bundle이 영영 준비되지 않아 잡이 정리되지 않은 채 남는다.
			const cur = this.store.job(jobId)!;
			if (["running", "launching", "uncertain"].includes(cur.state)) this.setState(cur, "ended");
			this.store.update(jobId, { failure: this.store.job(jobId)!.failure ?? "ended_without_result" });
			await this.finishCleanup(this.store.job(jobId)!);
			lap("cleanup");
			const fin = this.store.job(jobId)!;
			return { job_id: jobId, phase: phaseOf(fin.state), state: fin.state, failure: fin.failure, commits: [], cleaned: true, note: "원격이 결과 없이 끝났다(실행 전 실패 등). 원격은 정리했다.", timing_ms: timing };
		}
		if (mode === "final" && !done) throw new ToolFailure("job_not_ended", { state: this.store.job(jobId)!.state, hint: "await until=ended 또는 cancel 뒤 collect" });
		const dir = join(this.jobDir(jobId), "collect");
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(join(dir, "out"), { recursive: true, mode: 0o700 });
		const bundlePath = join(dir, "out.bundle");
		const localRef = `refs/heads/remote/${job.target}/${jobId}`;
		// 끝난 잡이면 로그 묶음도 bundle과 함께 받는다(서로 독립, 회수 지연을 줄인다). 결과는 bundle이 성공한 뒤에만 쓴다.
		const tarPath = join(dir, "logs.tar");
		const logsP = done ? tr.call("logs", [jobId], { auth, outFile: tarPath, timeoutMs: 10 * 60_000 }).then(() => null, (e: unknown) => e) : null;
		try {
			await tr.call("bundle", [jobId], { auth, outFile: bundlePath, timeoutMs: 60 * 60_000 });
			lap("bundle");
		} catch (e) {
			await logsP;
			rmSync(tarPath, { force: true });
			const code = e instanceof RemoteError ? e.code : "bundle_failed";
			if (code === "no_commits") {
				if (mode === "final") await this.finishCleanup(job);
				return { job_id: jobId, commits: [], note: "원격 커밋이 없다.", cleaned: mode === "final" };
			}
			if ((code === "blocked_secret" || code === "forbidden_path") && mode === "final" && done) {
				// 비밀·금지 경로가 든 결과는 가져오지 않고 원격에서 지운다(P-4). partial이면 남겨 둔다.
				await this.finishCleanup(job);
				throw new ToolFailure(code, { job_id: jobId, cleaned: true });
			}
			throw new ToolFailure(code, { job_id: jobId });
		}
		let evidence = null;
		let evidenceSha256: string | null = null;
		let head: string;
		if (done) {
			const logsErr = await logsP;
			if (logsErr) throw logsErr;
			await safeUntar(tarPath, join(dir, "out"));
			lap("logs");
			const v = await verifyAndImport({ repoRoot: job.repo_path, bundlePath, outDir: join(dir, "out"), job: jobId, base: job.base_sha, localRef }).catch(e => {
				throw new ToolFailure(e instanceof GitError ? e.code : "verify_failed", { detail: String(e.message ?? e).slice(0, 300) });
			});
			lap("verify");
			evidence = v.evidence;
			evidenceSha256 = v.evidenceSha256;
			head = v.head;
		} else {
			// 실행 중 부분 회수: 증거가 아직 없다. bundle 검증과 fast-forward만 한다.
			head = await importPartial(job, bundlePath, localRef);
		}
		const commits = (await git(job.repo_path, ["log", "--format=%H %s", `${job.base_sha}..${head}`])).stdout.trim().split("\n").filter(Boolean);
		lap("log");
		const cur = this.store.job(jobId)!;
		if (done) {
			if (cur.state !== "ended" && cur.state !== "verified" && cur.state !== "failed") {
				// 원격이 끝났는데 로컬이 아직 모르면 맞춘다.
				if (["running", "launching", "uncertain"].includes(cur.state)) this.setState(cur, "ended");
			}
			this.setState(this.store.job(jobId)!, "verified", { head, local_ref: localRef, evidence_sha256: evidenceSha256 });
		} else {
			this.store.update(jobId, { head, local_ref: localRef });
		}
		let cleaned = false;
		if (mode === "final") {
			await this.finishCleanup(this.store.job(jobId)!);
			cleaned = true;
			lap("cleanup");
		}
		const fin = this.store.job(jobId)!;
		return {
			job_id: jobId,
			phase: phaseOf(fin.state),
			state: fin.state,
			local_ref: localRef,
			base: job.base_sha,
			head,
			commits,
			evidence_sha256: evidenceSha256,
			evidence_path: done ? join(dir, "out", "evidence.json") : null,
			checks: evidence?.checks.map(c => ({ id: c.id, exit: c.exit })) ?? [],
			wip: evidence?.wip ?? null,
			report: evidence?.report ?? null,
			reason: evidence?.reason ?? null,
			cleaned,
			suggest: [`git merge --no-ff ${localRef}`, `git cherry-pick ${job.base_sha}..${localRef}`],
			note: "merge·cherry-pick은 실행하지 않았다. 메인이 직접 고른다.",
			timing_ms: timing,
		};
	}

	private async finishCleanup(job: JobRow): Promise<void> {
		await this.transport(job.target).call("cleanup", [job.job_id], { auth: this.capAuth(job), timeoutMs: 30 * 60_000 });
		const cur = this.store.job(job.job_id)!;
		if (cur.state !== "collected") {
			if (cur.state === "ended" || cur.state === "failed" || cur.state === "verified") this.setState(cur, "collected");
			else this.store.update(job.job_id, { state: "collected" });
		}
	}
}

function renderTask(input: StartInput): string {
	const parts = [`# 작업\n\n${input.task.trim()}`];
	if (input.context?.trim()) parts.push(`# 배경\n\n${input.context.trim()}`);
	if (input.constraints?.trim()) parts.push(`# 제약\n\n${input.constraints.trim()}`);
	if (input.acceptance?.trim()) parts.push(`# 수용 기준\n\n${input.acceptance.trim()}`);
	if (input.checks?.length) parts.push(`# 러너가 마지막에 직접 돌릴 검사\n\n${input.checks.map(c => `- ${c.id}: \`${c.cmd}\``).join("\n")}`);
	return `${parts.join("\n\n")}\n`;
}

async function safeUntar(tarPath: string, dest: string): Promise<void> {
	const list = Bun.spawn(["tar", "-tvf", tarPath], { stdout: "pipe", stderr: "pipe" });
	const listing = await new Response(list.stdout).text();
	if ((await list.exited) !== 0) throw new ToolFailure("logs_invalid");
	for (const line of listing.split("\n").filter(Boolean)) {
		if (!line.startsWith("-")) throw new ToolFailure("logs_invalid", { detail: "non-regular member" });
		const name = line.split(/\s+/).slice(5).join(" ");
		if (name.startsWith("/") || name.split("/").includes("..")) throw new ToolFailure("logs_invalid", { detail: "path" });
	}
	const x = Bun.spawn(["tar", "-xf", tarPath, "-C", dest, "--no-same-owner", "--no-same-permissions"], { stdout: "ignore", stderr: "pipe" });
	if ((await x.exited) !== 0) throw new ToolFailure("logs_invalid", { detail: "extract" });
}

async function importPartial(job: JobRow, bundlePath: string, localRef: string): Promise<string> {
	const branchRef = `refs/heads/rt/${job.job_id}`;
	const v = await git(job.repo_path, ["bundle", "verify", bundlePath], { check: false });
	if (v.code !== 0) throw new ToolFailure("bundle_invalid");
	const heads = (await git(job.repo_path, ["bundle", "list-heads", bundlePath])).stdout.trim().split("\n");
	if (heads.length !== 1 || !heads[0]!.endsWith(` ${branchRef}`)) throw new ToolFailure("bundle_invalid", { detail: "refs" });
	const head = heads[0]!.split(" ")[0]!;
	await git(job.repo_path, ["fetch", "-q", "--no-tags", bundlePath, `${branchRef}:${localRef}`], { allowFile: true }).catch(e => {
		throw new ToolFailure("local_ref_diverged", { detail: String(e).slice(0, 200) });
	});
	const anc = await git(job.repo_path, ["merge-base", "--is-ancestor", job.base_sha, head], { check: false });
	if (anc.code !== 0) throw new ToolFailure("bundle_invalid", { detail: "base not ancestor" });
	return head;
}
