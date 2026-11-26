// 박스 전송: 박스 드라이버(worker/box/drivers/rt-box-<driver>)로 파일 올리기·작업 투입·관리 명령, pump 유닛으로
// 모델·이벤트·inbox 중계. 드라이버가 VM 종류(일반 SSH VM, instabox 등)의 차이를 맡고 여기서는 같은 동사만 쓴다.
// SshTransport와 같은 동사(call)를 제공해 jobs.ts의 흐름을 그대로 쓴다. 박스로 가는 것은 공개 원본 기준의
// 미push bundle·작업 지시·검증된 코드뿐이고, 키는 원점의 pump만 가진다.
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { BoxTarget, RtConfig } from "../core/config";
import { normalizeModel } from "../core/config";
import type { Store } from "../core/store";
import { type CallOptions, RemoteError } from "./ssh";

const LIVE_BOX_STATES = new Set(["running", "suspended", "paused", "resuming", "starting"]);
const DRIVER_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** 드라이버가 돌려주는 대기줄 작업 id(경로·셸에 쓰이지 않지만 모양은 좁힌다). */
const QID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

interface BoxInfo {
	state: string;
	cooldownSeconds: number;
	runLeftMinutes: number | null;
}

export interface BoxStaging {
	bundle_ver: string;
	bundle_tar: string;
	tar_sha: string;
	boxctl_sha: string;
	gjc_ver: string;
	gjc_sha: string;
}

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** 드라이버 한 번 실행(인자는 드라이버 동사부터). 시험에서는 가짜로 바꾼다. */
export type BoxDriverRunner = (args: string[], timeoutMs: number) => Promise<RunResult>;

function driverRunner(driver: string, target: BoxTarget): BoxDriverRunner {
	return async (args, timeoutMs) => {
		if (!existsSync(driver)) return { code: 127, stdout: "", stderr: `box driver missing: ${driver}` };
		const env = { ...process.env, RT_BOX_TARGET: JSON.stringify(target) };
		const proc = Bun.spawn([driver, ...args], { stdout: "pipe", stderr: "pipe", env });
		const timer = setTimeout(() => proc.kill("SIGTERM"), timeoutMs);
		try {
			const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
			return { code, stdout, stderr };
		} finally {
			clearTimeout(timer);
		}
	};
}

function lastJson(text: string): Record<string, unknown> | null {
	for (const line of text.trim().split("\n").reverse()) {
		try {
			const v = JSON.parse(line) as unknown;
			if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
		} catch {}
	}
	return null;
}

async function freePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			srv.close(() => resolve(port));
		});
	});
}

export class BoxTransport {
	constructor(
		readonly name: string,
		readonly target: BoxTarget,
		readonly home: string,
		readonly config: RtConfig,
		readonly store: Store,
		private run?: BoxDriverRunner,
	) {}

	/** 원점에 설치된 드라이버 실행 파일(stage-box가 box/drivers/에 둔다). */
	driverPath(): string {
		const d = String(this.target.driver ?? "");
		if (!DRIVER_RE.test(d)) throw new RemoteError("bad_target", `box driver: ${d}`);
		return join(this.home, "box", "drivers", `rt-box-${d}`);
	}

	private q(args: string[], timeoutMs = 120_000): Promise<RunResult> {
		this.run ??= driverRunner(this.driverPath(), this.target);
		return this.run(args, timeoutMs);
	}

	private spool(job: string): string {
		return join(this.home, "jobs", job, "box");
	}

	private staging(): BoxStaging | null {
		const p = join(this.home, "box", "box.json");
		return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as BoxStaging) : null;
	}

	keyFile(): string {
		return this.config.box.keyFile || join(this.home, "keys", "gjc-rt.key");
	}

	private readJson<T>(p: string): T | null {
		try {
			return JSON.parse(readFileSync(p, "utf8")) as T;
		} catch {
			return null;
		}
	}

	private pumpState(job: string): Record<string, any> | null {
		return this.readJson(join(this.spool(job), "pump-state.json"));
	}

	/** pump가 남긴 반납 증명이 있으면 슬롯을 한 번만 반납한다. */
	private settleRelease(job: string): void {
		const st = this.pumpState(job);
		const rel = st?.release as { release?: boolean; proof?: string } | undefined;
		if (rel?.release) this.store.boxRelease(job, rel.proof ?? "ended");
	}

	/** 주인 세션이 더는 묻지 않는 잡(세션 종료·인쇄 모드)도 pump가 남긴 반납 증명으로 슬롯을 돌려준다. */
	private settleOpen(): void {
		for (const job of this.store.boxOpen(this.name)) this.settleRelease(job);
	}

	/** 이 박스의 상태(드라이버 info: 박스를 깨우지 않는다). 못 읽으면 null(unreachable). */
	async boxes(): Promise<BoxInfo | null> {
		const r = await this.q(["info"], 60_000);
		if (r.code !== 0) return null;
		const m = lastJson(r.stdout);
		if (!m || typeof m.state !== "string") return null;
		const left = m.run_left_min;
		return {
			state: m.state,
			cooldownSeconds: typeof m.cooldown_s === "number" ? m.cooldown_s : 0,
			runLeftMinutes: typeof left === "number" ? left : null,
		};
	}

	async call<T = any>(verb: string, args: (string | number)[], opts: CallOptions = {}): Promise<T> {
		const a = args.map(String);
		switch (verb) {
			case "probe":
				return (await this.probe(a)) as T;
			case "reserve":
				return this.reserve(a) as T;
			case "upload-base": {
				const d = this.spool(a[0]!);
				mkdirSync(d, { recursive: true, mode: 0o700 });
				if (!opts.bodyFile) throw new RemoteError("bad_argument", "bodyFile");
				copyFileSync(opts.bodyFile, join(d, "base.bundle"));
				return { ok: true } as T;
			}
			case "prepare":
				return (await this.prepare(a[0]!, Number(a[1]), String(opts.body ?? ""))) as T;
			case "launch":
				return (await this.launch(a[0]!, Number(a[1]))) as T;
			case "events":
				return (await this.events(a)) as T;
			case "send":
				return (await this.send(a[0]!, a[1]!, a[2]!, opts.body)) as T;
			case "status":
				return this.status(a[0]!) as T;
			case "cancel":
				return (await this.cancel(a[0]!, Number(a[1]))) as T;
			case "bundle":
				return this.bundle(a[0]!, opts.outFile) as T;
			case "logs":
				return this.logs(a[0]!, opts.outFile) as T;
			case "cleanup":
				return (await this.cleanup(a[0]!)) as T;
			default:
				throw new RemoteError("bad_verb", verb);
		}
	}

	// ---------------------------------------------------------------- 판정(P-2: 박스를 깨우지 않는다)

	private async probe(a: string[]) {
		const est = a.includes("--est") ? Number(a[a.indexOf("--est") + 1]) : 30;
		const model = a.includes("--model") ? a[a.indexOf("--model") + 1]! : this.config.defaultModel;
		if (!this.run && !existsSync(this.driverPath())) return { error: "box_driver_missing" };
		const info = await this.boxes();
		if (!info) return { error: "unreachable" };
		const admission: string[] = [];
		if (!LIVE_BOX_STATES.has(info.state)) admission.push("box_unavailable");
		if (info.cooldownSeconds > 0) admission.push("box_cooldown");
		if (info.runLeftMinutes !== null && info.runLeftMinutes < est + 10) admission.push("box_runtime_short");
		if (!this.staging()) admission.push("box_bundle_missing");
		const allowed = this.config.rtKey.allowedModels.map(normalizeModel);
		this.settleOpen();
		return {
			slots_used: this.store.boxUsed(this.name),
			slots_max: this.target.maxSlots,
			credential: existsSync(this.keyFile()),
			trusted_gjc: [this.config.gjcVersion],
			model_rejection: allowed.includes(normalizeModel(model)) ? null : "model_not_allowed",
			admission,
			box: { state: info.state, run_left_min: info.runLeftMinutes, cooldown_s: info.cooldownSeconds },
		};
	}

	private reserve(a: string[]) {
		const [job, gen] = [a[0]!, Number(a[1])];
		this.settleOpen();
		if (!this.store.boxReserve(this.name, job, gen, this.target.maxSlots)) throw new RemoteError("slots_full");
		mkdirSync(this.spool(job), { recursive: true, mode: 0o700 });
		return { cap: randomBytes(16).toString("hex"), gen, gjc_installed: true };
	}

	// ---------------------------------------------------------------- 투입

	private async prepare(job: string, gen: number, manifestJson: string) {
		const st = this.staging();
		if (!st) throw new RemoteError("box_bundle_missing");
		const d = this.spool(job);
		const up = join(d, "up");
		rmSync(up, { recursive: true, force: true });
		mkdirSync(up, { recursive: true, mode: 0o700 });
		const manifest = JSON.parse(manifestJson) as Record<string, unknown>;
		if (manifest.job !== job || manifest.gen !== gen) throw new RemoteError("manifest_mismatch");
		writeFileSync(join(up, "manifest.json"), JSON.stringify(manifest));
		copyFileSync(join(this.home, "box", "rt-boxctl"), join(up, "rt-boxctl"));
		copyFileSync(join(this.home, "box", st.bundle_tar), join(up, "bundle.tar"));
		if (existsSync(join(d, "base.bundle"))) copyFileSync(join(d, "base.bundle"), join(up, "base.bundle"));
		const tmpl = readFileSync(join(this.home, "box", "job.sh.tmpl"), "utf8");
		const script = tmpl
			.replaceAll("@JOB@", job)
			.replaceAll("@GEN@", String(gen))
			.replaceAll("@BOXCTL_SHA@", st.boxctl_sha)
			.replaceAll("@BUNDLE_VER@", st.bundle_ver)
			.replaceAll("@TAR_SHA@", st.tar_sha)
			.replaceAll("@GJC_VER@", st.gjc_ver)
			.replaceAll("@GJC_SHA@", st.gjc_sha);
		if (/@[A-Z_]+@/.test(script)) throw new RemoteError("template_incomplete");
		writeFileSync(join(d, "job.sh"), script, { mode: 0o600 });
		const r = await this.q(["put", up, `/data/workspace/rt-in/${job}`], 30 * 60_000);
		if (r.code !== 0) throw new RemoteError("box_upload_failed", r.stderr.slice(-300));
		rmSync(up, { recursive: true, force: true });
		return { ok: true };
	}

	private async launch(job: string, gen: number) {
		const d = this.spool(job);
		const row = this.store.job(job);
		if (!row) throw new RemoteError("job_unknown");
		const info = await this.boxes();
		const runLeft = info ? (info.runLeftMinutes ?? 24 * 60) : 0;
		const minutes = Math.max(10, Math.min(row.est_min * 2, runLeft - 10));
		const timeoutS = minutes * 60 + 900; // 설치·clone·정리 여유
		const r = await this.q(["submit", `rt-${job.slice(3, 19)}`, String(timeoutS), join(d, "job.sh")], 5 * 60_000);
		const qid = r.stdout.trim().split("\n").pop()?.trim() ?? "";
		if (r.code !== 0 || !QID_RE.test(qid)) {
			throw new RemoteError(r.code === 3 ? "box_submit_refused" : "box_submit_failed", r.stderr.slice(-300));
		}
		const hub = this.config.box.hubBase;
		const models = [normalizeModel(row.model).replace(/^[^/]+\//, "")];
		const pump = {
			job,
			gen,
			driver: this.driverPath(),
			target: this.target,
			qid,
			models,
			hub_base: hub,
			key_file: this.keyFile(),
			deadline: Date.now() / 1000 + timeoutS + 600,
			max_requests: 600,
			lport: await freePort(),
		};
		writeFileSync(join(d, "pump.json"), JSON.stringify(pump), { mode: 0o600 });
		const unit = `gjc-rt-pump-${job}`;
		const rwOut = await this.q(["pump-rw"], 30_000);
		const rw = rwOut.code === 0 ? rwOut.stdout.split("\n").map(l => l.trim()).filter(l => l.startsWith("/") && !/\s/.test(l)) : [];
		const p = Bun.spawn(
			[
				"systemd-run",
				`--unit=${unit}`,
				"--collect",
				"--quiet",
				"-p",
				"NoNewPrivileges=yes",
				"-p",
				"ProtectHome=read-only",
				"-p",
				// 드라이버가 쓰기를 요구하는 경로(예: instabox port-forward의 연결 설정)는 없어도 되는 경로(-)로 연다.
				`ReadWritePaths=${[d, ...rw.map(p => `-${p}`)].join(" ")}`,
				`--setenv=HOME=${homedir()}`,
				"-p",
				"PrivateTmp=yes",
				"-p",
				`RuntimeMaxSec=${Math.ceil(timeoutS + 7200)}`,
				"/usr/bin/python3",
				join(this.home, "box", "rt-boxpump.py"),
				d,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
		if (code !== 0) throw new RemoteError("pump_start_failed", err.slice(-300));
		return { ok: true, qid, unit };
	}

	// ---------------------------------------------------------------- 실행 중

	private readEvents(job: string, after: number, max: number) {
		const p = join(this.spool(job), "events.jsonl");
		const out: { seq: number; ts: string; kind: string; data: unknown }[] = [];
		let last = 0;
		// 박스에서는 러너의 ended 뒤에도 결과 가져오기·반납 판정이 남는다. pump가 그것을 마칠 때까지
		// ended와 그 뒤 이벤트를 내보내지 않는다. 그래서 await until=ended가 끝나면 collect final이 바로 된다.
		const settled = this.pumpState(job)?.phase === "done";
		if (existsSync(p)) {
			for (const line of readFileSync(p, "utf8").split("\n")) {
				if (!line) continue;
				try {
					const e = JSON.parse(line) as { seq: number; ts: string; kind: string; data: unknown };
					if (typeof e.seq !== "number") continue;
					if (!settled && e.kind === "ended") break;
					last = Math.max(last, e.seq);
					if (e.seq > after && out.length < max) out.push(e);
				} catch {}
			}
		}
		return { events: out, last_seq: last };
	}

	/** events.jsonl·pump-state.json의 크기·수정 시각. 둘 다 그대로면 events 결과도 그대로다. */
	private spoolKey(job: string): string {
		const d = this.spool(job);
		return ["events.jsonl", "pump-state.json"]
			.map(n => {
				try {
					const st = statSync(join(d, n));
					return `${st.size}:${st.mtimeMs}:${st.ino}`;
				} catch {
					return "-";
				}
			})
			.join("|");
	}

	private async events(a: string[]) {
		const job = a[0]!;
		const after = Number(a[1]);
		const wait = a.includes("--wait") ? Number(a[a.indexOf("--wait") + 1]) : 0;
		const max = a.includes("--max") ? Number(a[a.indexOf("--max") + 1]) : 200;
		if (!existsSync(this.spool(job))) throw new RemoteError("job_cleaned");
		const deadline = Date.now() + wait * 1000;
		// 0.5초마다 다시 보되, pump가 쓰는 두 파일이 그대로면 읽고 해석하지 않는다(AC-11 부하 기준: 기다리는 동안의 CPU).
		let seen = "";
		let res: ReturnType<BoxTransport["readEvents"]> | null = null;
		for (;;) {
			const key = this.spoolKey(job);
			if (key !== seen || !res) {
				seen = key;
				this.settleRelease(job);
				res = this.readEvents(job, after, max);
			}
			if (res.events.length || Date.now() >= deadline) return res;
			await Bun.sleep(500);
		}
	}

	private async send(job: string, msgId: string, replyTo: string, body: CallOptions["body"]) {
		const ob = join(this.spool(job), "outbox");
		mkdirSync(ob, { recursive: true, mode: 0o700 });
		const text = typeof body === "string" ? body : Buffer.from(body ?? new Uint8Array()).toString("utf8");
		writeFileSync(join(ob, `${msgId}.json.tmp`), JSON.stringify({ text, reply_to: replyTo === "-" ? null : replyTo }), { mode: 0o600 });
		const { renameSync } = await import("node:fs");
		renameSync(join(ob, `${msgId}.json.tmp`), join(ob, `${msgId}.json`));
		const deadline = Date.now() + 55_000;
		while (Date.now() < deadline) {
			const res = this.readJson<{ status: number; duplicate?: boolean; error?: string }>(join(ob, `${msgId}.res`));
			if (res) {
				if (res.status === 200) return { ok: true, duplicate: !!res.duplicate };
				throw new RemoteError(res.error ?? "send_failed");
			}
			await Bun.sleep(500);
		}
		throw new RemoteError("relay_unavailable");
	}

	private status(job: string) {
		this.settleRelease(job);
		const st = this.pumpState(job);
		const slot = this.store.boxSlot(job);
		let state = "launched";
		if (!st) state = "staged";
		else if (st.phase === "done" || st.phase === "fetching") state = "ended";
		// collect final은 박스 결과(out/collect.json)를 원점으로 가져온 뒤에만 된다. 실행 중 부분 회수는 지원하지 않는다
		// (박스에는 들어가 bundle을 만들 길이 대기줄 작업 끝뿐이다).
		const done = state === "ended" && st?.phase === "done" ? this.collectInfo(job) : null;
		return { state, ended: state === "ended", work: { done }, pump: st, slot };
	}

	private async cancel(job: string, gen: number) {
		const d = this.spool(job);
		const pump = this.readJson<{ qid: string }>(join(d, "pump.json"));
		if (!pump) {
			// 대기줄에 넣지 않았다: 박스에서 시작될 길이 없다(미시작 증명). 올린 파일은 cleanup이 지운다.
			this.store.boxRelease(job, "never_submitted");
			return { ok: true, release: { release: true, proof: "never_submitted" } };
		}
		// pump가 대기줄 작업 감시를 바로 시작하게 한다(평소에는 러너 종료 신호를 받고서야 시작한다).
		writeFileSync(join(d, "wait-now"), "");
		// 봉인 먼저(늦은 시작 차단), 그다음 대기줄 취소(job.sh trap이 유닛을 멈추고 결과를 모은다).
		const r = await this.q(["exec", "--", "sudo", "-n", "/data/rt-ctl/bin/rt-boxctl", "cancel", job, String(gen)], 6 * 60_000);
		const res = lastJson(r.stdout);
		const qc = lastJson((await this.q(["cancel", pump.qid], 120_000)).stdout);
		// 드라이버가 "시작 전에 대기줄에서 뺐다"고 답하면 job.sh가 한 번도 실행되지 않았다(미시작 증명).
		const pendingCancelled = qc?.pending_cancelled === true;
		let release = res && typeof res.release === "boolean" ? (res as { release: boolean; proof?: string }) : null;
		if (!release?.release && pendingCancelled) release = { release: true, proof: "queue_pending_cancelled" };
		if (release?.release) this.store.boxRelease(job, release.proof ?? "ended");
		// 대기줄 작업이 끝나면 pump가 결과를 가져오고 반납 판정을 남긴다. 그때까지 기다려야 collect final이 된다.
		const deadline = Date.now() + 5 * 60_000;
		while (Date.now() < deadline && this.pumpState(job)?.phase !== "done") await Bun.sleep(1000);
		this.settleRelease(job);
		const ended = !!release?.release || this.pumpState(job)?.phase === "done";
		return { ok: !!res && !res.error, sealed: res?.sealed ?? false, ended, release, queue: String(qc?.detail ?? "").slice(-200), error: res?.error };
	}

	// ---------------------------------------------------------------- 결과

	private collectInfo(job: string): Record<string, string> | null {
		return this.readJson(join(this.spool(job), "out", "collect.json"));
	}

	private bundle(job: string, outFile?: string) {
		const info = this.collectInfo(job);
		if (!info) throw new RemoteError("not_ready", "box result not fetched yet");
		if (info.bundle !== "ok") throw new RemoteError(info.bundle === "failed" ? "bundle_failed" : (info.bundle ?? "bundle_failed"));
		if (!outFile) throw new RemoteError("bad_argument", "outFile");
		copyFileSync(join(this.spool(job), "out", "out.bundle"), outFile);
		return { ok: true };
	}

	private logs(job: string, outFile?: string) {
		const info = this.collectInfo(job);
		if (!info || info.logs !== "ok") throw new RemoteError("not_ready", "logs");
		if (!outFile) throw new RemoteError("bad_argument", "outFile");
		copyFileSync(join(this.spool(job), "out", "logs.tar"), outFile);
		return { ok: true };
	}

	private async cleanup(job: string) {
		const slot = this.store.boxSlot(job);
		const gen = slot?.gen ?? 1;
		const d = this.spool(job);
		if (existsSync(join(d, "pump.json"))) {
			const r = await this.q(["exec", "--", "sudo", "-n", "/data/rt-ctl/bin/rt-boxctl", "cleanup", job, String(gen)], 10 * 60_000);
			const res = lastJson(r.stdout);
			if (!res?.ok) throw new RemoteError((res?.error as string) ?? "cleanup_failed", String(res?.detail ?? r.stderr.slice(-200)));
			this.settleRelease(job);
			// 정리까지 끝났으면 실행 그룹이 없다는 것이 확인된 상태다(cleanup은 반납 증명 없이는 거부한다).
			this.store.boxRelease(job, "cleaned");
		} else {
			// 투입 전이었다. 올린 파일만 지운다(박스에 있으면).
			await this.q(["exec", "--", "rm", "-rf", "--", `/data/workspace/rt-in/${job}`], 120_000);
			this.store.boxRelease(job, "never_submitted");
		}
		Bun.spawnSync(["systemctl", "stop", `gjc-rt-pump-${job}.service`], { stdout: "ignore", stderr: "ignore" });
		// pump 최종 상태(반납 증명·중계 통계·CPU)는 잡 기록으로 남긴다. 스풀의 나머지(올린 파일·결과 묶음)는 지운다.
		if (existsSync(join(d, "pump-state.json"))) copyFileSync(join(d, "pump-state.json"), join(this.home, "jobs", job, "pump-state.json"));
		for (const name of readdirSync(d)) rmSync(join(d, name), { recursive: true, force: true });
		rmSync(d, { recursive: true, force: true });
		return { ok: true };
	}
}
