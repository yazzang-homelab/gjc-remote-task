// 박스 투입 전 검사(계획 §5.9 1~3, AC-12·AC-14). 박스에는 공개 원본과 검사를 통과한 미push 커밋만 간다.
// 값은 출력하지 않는다. 지문은 메인 호스트의 box/fingerprints.json(이름·길이·sha256)만 쓴다.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./gitops";

export class BoxCheckError extends Error {
	constructor(
		readonly code: string,
		readonly detail: Record<string, unknown> = {},
	) {
		super(code);
	}
}

/** 토큰 모양 규칙. 원격 rtlib.TOKEN_RULES와 같은 계열. */
export const TOKEN_RULES: [string, RegExp][] = [
	["openai_like", /\bsk-[A-Za-z0-9_-]{20,}/],
	["ocx_key", /\bocx_[A-Za-z0-9_-]{16,}/],
	["github_token", /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
	["anthropic_key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
	["google_key", /\bAIza[0-9A-Za-z_-]{35}/],
	["aws_key", /\bAKIA[0-9A-Z]{16}\b/],
	["slack_token", /\bxox[abpr]-[A-Za-z0-9-]{10,}/],
	["telegram_bot", /\b[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}/],
	["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
	["instabox_key", /\bibk_[A-Za-z0-9_-]{20,}/],
];

export interface Fingerprint {
	name: string;
	len: number;
	sha256: string;
}

export function loadFingerprints(path: string): Fingerprint[] {
	if (!existsSync(path)) return [];
	const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
	if (!Array.isArray(raw)) return [];
	return raw.filter(
		(f): f is Fingerprint => typeof f?.len === "number" && f.len > 0 && typeof f?.sha256 === "string",
	).map((f) => ({ name: String(f.name ?? "fp"), len: f.len, sha256: f.sha256.toLowerCase() }));
}

/** 규칙 이름 목록만 돌려준다(일치한 값은 돌려주지 않는다). */
export function scanText(text: string, fps: Fingerprint[]): string[] {
	const hits = new Set<string>();
	for (const [name, rx] of TOKEN_RULES) if (rx.test(text)) hits.add(name);
	// 원문 조각(앞 글자) 없이 길이·sha256만 쓴다(계획 §16.6). 비밀은 공백·따옴표·괄호류·구분 기호를 담지 않는다고 보고
	// 그런 문자 없이 이어진 구간 안에서만 창을 민다(worker/bundle/rtlib.py fingerprint_hits _RUN과 같은 규칙).
	const byLen = new Map<number, Map<string, string>>();
	for (const fp of fps) {
		const t = byLen.get(fp.len) ?? new Map<string, string>();
		t.set(fp.sha256, fp.name);
		byLen.set(fp.len, t);
	}
	for (const m of text.matchAll(/[^\s"'\\`{}[\](),;<>]+/gu)) {
		const run = Buffer.from(m[0], "utf8");
		for (const [len, table] of byLen) {
			for (let i = 0; i + len <= run.length; i++) {
				const name = table.get(createHash("sha256").update(run.subarray(i, i + len)).digest("hex"));
				if (name) hits.add(`fingerprint:${name}`);
			}
		}
	}
	return [...hits].sort();
}

/** github.com 원본 주소를 OWNER/REPO로. 다른 호스트면 null. */
export function githubSlug(url: string | null): string | null {
	if (!url) return null;
	const m =
		/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url) ??
		/^(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url);
	return m ? `${m[1]}/${m[2]}` : null;
}

/** 익명 API로 공개 여부를 본다(박스 투입 전 검사). 연결 실패는 공개로 보지 않는다. */
export async function isPublicRepo(slug: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
	try {
		const r = await fetchImpl(`https://api.github.com/repos/${slug}`, {
			headers: { Accept: "application/vnd.github+json", "User-Agent": "gjc-rt" },
			signal: AbortSignal.timeout(15_000),
		});
		if (r.status !== 200) return false;
		const body = (await r.json()) as { private?: boolean };
		return body.private === false;
	} catch {
		return false;
	}
}

/** 익명 ls-remote 끝 SHA 가운데 base의 조상이면서 가장 가까운 것(공개 기준 커밋). */
export async function publicBase(repo: string, url: string, base: string): Promise<{ sha: string; ahead: number } | null> {
	const proc = Bun.spawn(["git", "-c", "credential.helper=", "-c", "protocol.file.allow=never", "ls-remote", "--heads", "--tags", url], {
		cwd: repo,
		stdout: "pipe",
		stderr: "pipe",
		env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false" },
	});
	const out = await new Response(proc.stdout).text();
	if ((await proc.exited) !== 0) return null;
	return nearestPublic(repo, new Set(out.split("\n").map(l => l.split("\t")[0]!).filter(s => /^[0-9a-f]{40}$/.test(s))), base);
}

/** 공개 SHA 집합 가운데 base의 조상이면서 base에서 가장 가까운 것(미push 커밋 수가 가장 적은 것). */
export async function nearestPublic(repo: string, shas: Set<string>, base: string): Promise<{ sha: string; ahead: number } | null> {
	if (shas.has(base)) return { sha: base, ahead: 0 };
	// 공개 ref는 수백 개일 수 있다. ref마다 git을 띄우지 않고, base의 조상 목록을 한 번 받아 가까운 공개 커밋 몇 개만 센다.
	const anc = await git(repo, ["rev-list", "--topo-order", base], { check: false });
	if (anc.code !== 0) return null;
	const hits: string[] = [];
	for (const sha of anc.stdout.split("\n")) {
		if (shas.has(sha)) hits.push(sha);
		if (hits.length >= 5) break;
	}
	let best: { sha: string; ahead: number } | null = null;
	for (const sha of hits) {
		const ahead = Number((await git(repo, ["rev-list", "--count", `${sha}..${base}`])).stdout.trim());
		if (!best || ahead < best.ahead) best = { sha, ahead };
	}
	return best;
}

/** 미push 범위(pub..base)의 비밀 검사: gitleaks + 토큰 모양 + 실제 키 지문 + 무시 대상 경로 추가. */
export async function scanUnpushed(repo: string, pub: string, base: string, fps: Fingerprint[], gitleaks = "/usr/local/bin/gitleaks"): Promise<string[]> {
	if (pub === base) return [];
	const hits = new Set<string>();
	const tmp = mkdtempSync(join(tmpdir(), "rt-leaks-"));
	try {
		const report = join(tmp, "r.json");
		const proc = Bun.spawn(
			[gitleaks, "git", "--no-banner", "--redact", "--exit-code", "2", "--log-opts", `${pub}..${base}`, "-f", "json", "-r", report, repo],
			{ stdout: "ignore", stderr: "pipe" },
		);
		const code = await proc.exited;
		if (code === 2) {
			const findings = JSON.parse(readFileSync(report, "utf8")) as { RuleID?: string }[];
			for (const f of findings) hits.add(`gitleaks:${f.RuleID ?? "unknown"}`);
		} else if (code !== 0) {
			throw new BoxCheckError("secret_scan_failed", { tool: "gitleaks", exit: code });
		}
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
	const diff = await git(repo, ["log", "-p", "--no-ext-diff", "--no-textconv", "--format=%H%n%an <%ae>%n%B", `${pub}..${base}`]);
	for (const h of scanText(diff.stdout, fps)) hits.add(h);
	const added = (await git(repo, ["diff", "--name-only", "--diff-filter=A", pub, base])).stdout.split("\n").filter(Boolean);
	if (added.length) {
		const ignored = new Set((await git(repo, ["ls-files", "-ci", "--exclude-standard"])).stdout.split("\n").filter(Boolean));
		if (added.some(p => ignored.has(p))) hits.add("ignored_path_added");
	}
	return [...hits].sort();
}

export interface BoxPreflight {
	slug: string;
	publicUrl: string;
	publicSha: string;
	unpushed: number;
}

/** 박스 대상 start 전 검사. 실패하면 BoxCheckError(사유 코드). */
export async function boxPreflight(input: {
	repo: string;
	originUrl: string | null;
	base: string;
	taskText: string;
	fingerprints: Fingerprint[];
	fetchImpl?: typeof fetch;
}): Promise<BoxPreflight> {
	const slug = githubSlug(input.originUrl);
	if (!slug || !(await isPublicRepo(slug, input.fetchImpl))) throw new BoxCheckError("origin_not_public", { origin: slug });
	const publicUrl = `https://github.com/${slug}.git`;
	const pub = await publicBase(input.repo, publicUrl, input.base);
	if (!pub) throw new BoxCheckError("public_base_missing");
	const textHits = scanText(input.taskText, input.fingerprints);
	if (textHits.length) throw new BoxCheckError("secret_found", { where: "task", rules: textHits });
	const hits = await scanUnpushed(input.repo, pub.sha, input.base, input.fingerprints);
	if (hits.length) throw new BoxCheckError("secret_found", { where: "unpushed", rules: hits });
	return { slug, publicUrl, publicSha: pub.sha, unpushed: pub.ahead };
}
