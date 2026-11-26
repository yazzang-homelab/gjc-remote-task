// 신뢰 호스트 전송: ssh forced command(gjcrt-ctl → rt-dispatch → sudo rt-helper).
// 인증 줄(reg/cap 토큰)은 stdin 첫 줄로만 보낸다. argv·로그에 비밀을 남기지 않는다.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SshTarget } from "../core/config";

export class RemoteError extends Error {
	constructor(
		readonly code: string,
		readonly detail = "",
		readonly exitCode = 0,
	) {
		super(detail ? `${code}: ${detail}` : code);
	}
}

export interface CallOptions {
	/** stdin 첫 줄 인증: "reg <token>" | "cap <session> <token>" */
	auth?: string;
	/** 인증 줄 뒤에 이어 보낼 바이트 또는 파일 */
	body?: Uint8Array | string;
	bodyFile?: string;
	/** stdout을 파일로 받는다(바이너리 응답) */
	outFile?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

const ARG_RX = /^[A-Za-z0-9._:/@+-]{1,120}$/;

export class SshTransport {
	constructor(
		readonly name: string,
		readonly target: SshTarget,
		readonly home: string,
		readonly connectTimeoutS = 10,
	) {}

	private baseArgs(): string[] {
		const key = join(this.home, "id_ed25519");
		const known = join(this.home, "known_hosts");
		if (!existsSync(key)) throw new RemoteError("unreachable", "local ssh key missing");
		return [
			"ssh",
			"-F",
			"/dev/null",
			"-T",
			"-i",
			key,
			"-o",
			"IdentitiesOnly=yes",
			"-o",
			"BatchMode=yes",
			"-o",
			`UserKnownHostsFile=${known}`,
			"-o",
			"StrictHostKeyChecking=yes",
			"-o",
			"GlobalKnownHostsFile=/dev/null",
			"-o",
			`ConnectTimeout=${this.connectTimeoutS}`,
			"-o",
			"ServerAliveInterval=15",
			"-o",
			"ServerAliveCountMax=4",
			"-o",
			"ControlMaster=auto",
			"-o",
			`ControlPath=${join(this.home, "cm-%C")}`,
			"-o",
			"ControlPersist=120",
			"-o",
			"ForwardAgent=no",
			"-o",
			"ClearAllForwardings=yes",
			"-p",
			String(this.target.port),
			"-l",
			this.target.user,
			this.target.host,
		];
	}

	/** 동사 하나를 실행한다. JSON 응답이면 파싱해서 돌려주고, outFile이면 바이트를 파일에 쓴다. */
	async call<T = Record<string, unknown>>(verb: string, args: (string | number)[], opts: CallOptions = {}): Promise<T> {
		const sargs = args.map(String);
		for (const a of [verb, ...sargs]) {
			if (!ARG_RX.test(a)) throw new RemoteError("bad_argument", a);
		}
		// 장애 주입(시험 전용, AC-8): 차단 파일이 있으면 연결 실패처럼 군다.
		const block = process.env.RT_TEST_BLOCK_FILE;
		if (block && existsSync(block)) throw new RemoteError("unreachable", "test_block");
		const res = await this.callInner<T>(verb, sargs, opts);
		// 응답 유실 주입: 원격에서는 실행됐지만 응답이 오지 않은 것처럼 군다(한 번만).
		if (process.env.RT_TEST_DROP_VERB === verb && !this.dropped.has(verb)) {
			this.dropped.add(verb);
			throw new RemoteError("unreachable", "test_drop_response");
		}
		return res;
	}

	private readonly dropped = new Set<string>();

	private async callInner<T>(verb: string, sargs: string[], opts: CallOptions): Promise<T> {
		const cmd = [...this.baseArgs(), [verb, ...sargs].join(" ")];
		const stdinParts: (Uint8Array | string)[] = [];
		if (opts.auth) stdinParts.push(`${opts.auth}\n`);
		if (opts.body !== undefined) stdinParts.push(opts.body);
		const proc = Bun.spawn(cmd, {
			stdin: opts.bodyFile ? "pipe" : stdinParts.length > 0 ? new Blob(stdinParts as BlobPart[]) : "ignore",
			stdout: opts.outFile ? Bun.file(opts.outFile) : "pipe",
			stderr: "pipe",
			env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: this.home },
		});
		if (opts.bodyFile) {
			const sink = proc.stdin as import("bun").FileSink;
			if (opts.auth) sink.write(`${opts.auth}\n`);
			const stream = Bun.file(opts.bodyFile).stream();
			for await (const chunk of stream) {
				sink.write(chunk);
				await sink.flush();
			}
			await sink.end();
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const onAbort = () => proc.kill("SIGTERM");
		opts.signal?.addEventListener("abort", onAbort, { once: true });
		if (opts.timeoutMs) timer = setTimeout(() => proc.kill("SIGTERM"), opts.timeoutMs);
		try {
			const [stdout, stderr, code] = await Promise.all([
				opts.outFile ? Promise.resolve("") : new Response(proc.stdout as ReadableStream).text(),
				new Response(proc.stderr as ReadableStream).text(),
				proc.exited,
			]);
			if (code !== 0) {
				const last = stderr.trim().split("\n").pop() ?? "";
				try {
					const err = JSON.parse(last) as { error?: string; detail?: string };
					throw new RemoteError(err.error ?? "remote_failed", err.detail ?? "", code);
				} catch (e) {
					if (e instanceof RemoteError) throw e;
					// ssh 자체 실패(255)나 시간 초과는 연결 문제로 본다.
					throw new RemoteError(code === 255 || code === 143 ? "unreachable" : "remote_failed", last.slice(0, 300), code);
				}
			}
			if (opts.outFile) return {} as T;
			const line = stdout.trim().split("\n").pop() ?? "{}";
			return JSON.parse(line) as T;
		} finally {
			if (timer) clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
		}
	}
}

export function readSecretFile(path: string): string {
	return readFileSync(path, "utf8").trim();
}
