// 로컬 git 작업: 기준 bundle 만들기, 결과 bundle 검증·가져오기. 훅과 외부 프로그램을 끈다.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SAFE = [
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"protocol.ext.allow=never",
	"-c",
	"transfer.fsckObjects=true",
	// fetch·update-ref 뒤 git이 사용자 저장소에서 자동 유지보수(gc·repack)를 띄우지 않게 한다.
	// 느슨 객체가 많은 저장소에서 collect 한 번에 수십 초 CPU를 쓰고, 유지보수는 사용자 몫이다.
	"-c",
	"gc.auto=0",
	"-c",
	"maintenance.auto=false",
];

export class GitError extends Error {
	constructor(
		readonly code: string,
		detail = "",
	) {
		super(detail ? `${code}: ${detail}` : code);
	}
}

export async function git(cwd: string, args: string[], opts: { allowFile?: boolean; check?: boolean } = {}) {
	const proc = Bun.spawn(
		["git", ...SAFE, "-c", `protocol.file.allow=${opts.allowFile ? "always" : "never"}`, ...args],
		{ cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } },
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if ((opts.check ?? true) && code !== 0) throw new GitError("git_failed", `git ${args[0]}: ${stderr.slice(-300)}`);
	return { stdout, stderr, code };
}

/** 저장소 안에 생기는 에이전트 상태 폴더. 원격 워크트리의 .git/info/exclude와 맞춘다. */
export const AGENT_DIRS = [".gjc", ".claude"] as const;

export interface RepoFacts {
	root: string;
	repoId: string;
	baseSha: string;
	dirty: boolean;
	submodules: boolean;
	/** 얕은 클론. 기준 커밋까지의 이력을 bundle로 보낼 수 없어 신뢰 호스트(ssh) 대상은 받지 않는다. 박스는 공개 원본에서 받으므로 된다. */
	shallow: boolean;
	originUrl: string | null;
}

export async function repoFacts(cwd: string, baseRef = "HEAD"): Promise<RepoFacts> {
	const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
	const baseSha = (await git(root, ["rev-parse", "--verify", `${baseRef}^{commit}`])).stdout.trim();
	const roots = (await git(root, ["rev-list", "--max-parents=0", baseSha])).stdout.trim().split("\n").sort();
	const repoId = createHash("sha256").update(roots.join("\n")).digest("hex").slice(0, 32);
	// 에이전트 상태 폴더(.gjc/·.claude/)는 메인 세션 cwd(하위 폴더일 수 있음)에 생기고 원격으로 보내지 않으므로 미커밋 판정에서 뺀다.
	const status = (
		await git(root, ["status", "--porcelain", "--untracked-files=normal", "--", ".", ...AGENT_DIRS.map(d => `:(exclude,top,glob)**/${d}/**`)])
	).stdout;
	const tree = (await git(root, ["ls-tree", "-r", "--full-tree", baseSha])).stdout;
	const submodules = tree.split("\n").some(l => l.startsWith("160000 ") || l.endsWith("\t.gitmodules"));
	const origin = await git(root, ["remote", "get-url", "origin"], { check: false });
	const shallow = (await git(root, ["rev-parse", "--is-shallow-repository"])).stdout.trim() === "true";
	return {
		root,
		repoId,
		baseSha,
		dirty: status.trim().length > 0,
		submodules,
		shallow,
		originUrl: origin.code === 0 ? origin.stdout.trim() : null,
	};
}

/**
 * 기준 커밋까지의 bundle을 만든다. 원격이 이미 가진 커밋(held)은 제외해 증분으로 보낸다.
 * held 가운데 로컬에 없는 것은 무시한다.
 */
export async function makeBaseBundle(root: string, baseSha: string, held: string[], dest: string, refName: string) {
	const excludes: string[] = [];
	for (const h of held) {
		if (!/^[0-9a-f]{40}$/.test(h)) continue;
		if ((await git(root, ["cat-file", "-e", `${h}^{commit}`], { check: false })).code === 0) excludes.push(`^${h}`);
	}
	await git(root, ["update-ref", refName, baseSha]);
	try {
		const r = await git(root, ["bundle", "create", dest, refName, ...excludes], { check: false });
		if (r.code !== 0) {
			// 제외가 base 자체를 덮으면 bundle이 비어 실패한다. 이때는 업로드가 필요 없다.
			if (/empty bundle|Refusing to create empty bundle/i.test(r.stderr)) return { empty: true };
			throw new GitError("bundle_create_failed", r.stderr.slice(-300));
		}
		return { empty: false };
	} finally {
		await git(root, ["update-ref", "-d", refName], { check: false });
	}
}

export interface Evidence {
	schema: string;
	job: string;
	generation: number;
	base: string;
	head: string;
	branch: string;
	commits: { sha: string; subject: string; files: number; wip: boolean }[];
	gjc: { version?: string; model?: string; exit: number | null };
	checks: { id: string; cmd: string; exit: number; log: string; log_bytes: number; log_sha256: string; tail: string }[];
	report: { summary?: string; open_questions?: string[] };
	wip: string;
	bundle: { status: string; head?: string; sha256?: string };
	reason: string;
}

export function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * 결과 검증(§5.5): 증거 스키마, 로그 해시, bundle 끝 = head, 커밋 목록 = rev-list base..head.
 * 검증이 끝나면 refs/heads/remote/<target>/<job>로만 가져온다(fast-forward만).
 */
export async function verifyAndImport(opts: {
	repoRoot: string;
	bundlePath: string;
	outDir: string;
	job: string;
	base: string;
	localRef: string;
}): Promise<{ evidence: Evidence; evidenceSha256: string; head: string }> {
	const evPath = join(opts.outDir, "evidence.json");
	const evidence = JSON.parse(readFileSync(evPath, "utf8")) as Evidence;
	if (evidence.schema !== "gjc-rt-evidence/1") throw new GitError("evidence_invalid", "schema");
	if (evidence.job !== opts.job || evidence.base !== opts.base) throw new GitError("evidence_invalid", "job/base");
	for (const c of evidence.checks ?? []) {
		if (!/^logs\/[a-z0-9_-]{1,32}\.log$/.test(c.log)) throw new GitError("evidence_invalid", "log path");
		if (sha256File(join(opts.outDir, c.log)) !== c.log_sha256) throw new GitError("evidence_invalid", `log hash ${c.id}`);
	}
	if (evidence.bundle?.sha256 && sha256File(opts.bundlePath) !== evidence.bundle.sha256) {
		throw new GitError("evidence_invalid", "bundle hash");
	}
	const branchRef = `refs/heads/rt/${opts.job}`;
	const verify = await git(opts.repoRoot, ["bundle", "verify", opts.bundlePath], { check: false });
	if (verify.code !== 0) throw new GitError("bundle_invalid", verify.stderr.slice(-300));
	const heads = (await git(opts.repoRoot, ["bundle", "list-heads", opts.bundlePath])).stdout.trim().split("\n");
	if (heads.length !== 1 || !heads[0]!.endsWith(` ${branchRef}`)) throw new GitError("bundle_invalid", "refs");
	const head = heads[0]!.split(" ")[0]!;
	if (head !== evidence.head) throw new GitError("evidence_invalid", "head");
	// 임시 bare 저장소에서 먼저 받아 rev-list를 대조한다(작업 저장소를 건드리기 전).
	const tmp = mkdtempSync(join(tmpdir(), "rt-verify-"));
	try {
		await git(tmp, ["init", "-q", "--bare", "."]);
		// 작업 저장소 객체는 alternates로 읽기만 한다. 이력 전체를 복사(pack)하면 큰 저장소에서 collect마다 수십 초 CPU가 든다.
		// bundle에서 받은 새 객체는 임시 저장소에만 쌓인다. 얕은 클론이면 얕은 경계(shallow)도 같이 둔다.
		const common = (await git(opts.repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
		writeFileSync(join(tmp, "objects", "info", "alternates"), `${join(common, "objects")}\n`);
		if (existsSync(join(common, "shallow"))) copyFileSync(join(common, "shallow"), join(tmp, "shallow"));
		await git(tmp, ["update-ref", "refs/rt/base", opts.base]);
		await git(tmp, ["fetch", "-q", "--no-tags", opts.bundlePath, `+${branchRef}:refs/rt/head`], { allowFile: true });
		const revs = (await git(tmp, ["rev-list", `${opts.base}..${head}`])).stdout.trim().split("\n").filter(Boolean);
		const listed = (evidence.commits ?? []).map(c => c.sha);
		if (revs.length !== listed.length || revs.some((r, i) => r !== listed[i])) throw new GitError("evidence_invalid", "commits");
		const isAnc = await git(tmp, ["merge-base", "--is-ancestor", opts.base, head], { check: false });
		if (isAnc.code !== 0) throw new GitError("evidence_invalid", "base not ancestor");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
	const cur = await git(opts.repoRoot, ["rev-parse", "--verify", "-q", opts.localRef], { check: false });
	const curSha = cur.stdout.trim();
	if (curSha && curSha !== head) {
		const ff = await git(opts.repoRoot, ["merge-base", "--is-ancestor", curSha, head], { check: false });
		if (ff.code !== 0) throw new GitError("local_ref_diverged", opts.localRef);
	}
	await git(opts.repoRoot, ["fetch", "-q", "--no-tags", opts.bundlePath, `${branchRef}:${opts.localRef}`], { allowFile: true });
	return { evidence, evidenceSha256: sha256File(evPath), head };
}
