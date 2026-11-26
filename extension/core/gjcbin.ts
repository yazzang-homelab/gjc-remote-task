// 원격에 올릴 gjc 실행 파일을 대상 플랫폼(linux-x64·linux-arm64 …)에 맞게 고른다.
// 원점과 대상의 CPU 아키텍처가 달라도(맥북 → x86 서버, x86 → arm 서버) 같은 판의 공식 릴리스 바이너리를 쓴다.
// 신뢰 근거는 HTTPS로 받은 릴리스 해시 목록(gajae-release-binaries.sha256)이다. 원점 바이너리가 그 목록의
// 자기 플랫폼 해시와 같을 때만 다른 플랫폼 바이너리를 받는다(판 이름만 같은 직접 빌드가 섞이지 않게).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RtConfig } from "./config";
import { sha256File } from "./gitops";

export const GJC_RELEASE_REPO = "Yeachan-Heo/gajae-code";
const PLATFORM_RE = /^(linux|darwin)-(x64|arm64)$/;

export class GjcResolveError extends Error {
	constructor(
		readonly code: string,
		detail = "",
	) {
		super(detail ? `${code}: ${detail}` : code);
	}
}

/** uname -s/-m(또는 process.platform/arch) → 릴리스 자산 이름의 플랫폼. 모르는 조합은 null. */
export function platformOf(sys: string, machine: string): string | null {
	const os = { linux: "linux", darwin: "darwin" }[sys.toLowerCase()];
	const arch = { x86_64: "x64", amd64: "x64", x64: "x64", aarch64: "arm64", arm64: "arm64" }[machine.toLowerCase()];
	return os && arch ? `${os}-${arch}` : null;
}

export function localPlatform(): string | null {
	return platformOf(process.platform, process.arch);
}

/** "<sha256>  gjc-<platform>" 줄 목록 → {platform: sha}. 윈도 자산 등 플랫폼 규칙 밖은 버린다. */
export function parseShaList(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const m = /^([0-9a-f]{64})\s+\*?gjc-([a-z0-9-]+)$/.exec(line.trim());
		if (m && PLATFORM_RE.test(m[2]!)) out[m[2]!] = m[1]!;
	}
	return out;
}

export type Fetcher = (url: string) => Promise<Response>;

function releaseUrl(ver: string, asset: string): string {
	return `https://github.com/${GJC_RELEASE_REPO}/releases/download/v${ver}/${asset}`;
}

/** 그 판의 플랫폼별 공식 해시. <home>/gjc/<판>/release.sha256에 한 번 받아 둔다. */
export async function releaseShas(ver: string, home: string, fetcher: Fetcher = fetch): Promise<Record<string, string>> {
	if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(ver)) throw new GjcResolveError("gjc_version_unknown", ver);
	const dir = join(home, "gjc", ver);
	const cache = join(dir, "release.sha256");
	if (existsSync(cache)) {
		const shas = parseShaList(readFileSync(cache, "utf8"));
		if (Object.keys(shas).length) return shas;
	}
	let text: string;
	try {
		const r = await fetcher(releaseUrl(ver, "gajae-release-binaries.sha256"));
		if (!r.ok) throw new GjcResolveError("gjc_release_unavailable", `HTTP ${r.status}`);
		text = await r.text();
	} catch (e) {
		if (e instanceof GjcResolveError) throw e;
		throw new GjcResolveError("gjc_release_unavailable", String(e));
	}
	const shas = parseShaList(text);
	if (!Object.keys(shas).length) throw new GjcResolveError("gjc_release_unavailable", "empty sha list");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(cache, text, { mode: 0o600 });
	return shas;
}

/** 원점 바이너리가 그 판의 공식 빌드인지 본다. 아니면 다른 플랫폼 바이너리를 대신 받지 않는다. */
export function assertOfficialOrigin(config: RtConfig, shas: Record<string, string>): void {
	const lp = localPlatform();
	if (!lp || !shas[lp]) throw new GjcResolveError("gjc_platform_unsupported", `origin ${process.platform}-${process.arch}`);
	if (!existsSync(config.gjcBinary) || sha256File(config.gjcBinary) !== shas[lp]) {
		throw new GjcResolveError("gjc_custom_build", `${config.gjcBinary}가 공식 ${config.gjcVersion} ${lp} 빌드가 아니다. config.yml gjcBinaries에 대상 플랫폼용 파일을 적는다.`);
	}
}

/**
 * 대상 플랫폼용 gjc 파일과 해시.
 * 1. config.gjcBinaries[플랫폼]이 있으면 그 파일(직접 빌드·오프라인용).
 * 2. 원점과 같은 플랫폼이면 config.gjcBinary.
 * 3. 아니면 공식 릴리스에서 받아 <home>/gjc/<판>/gjc-<플랫폼>에 둔다(해시 확인 뒤 원자적 교체).
 */
export async function resolveGjc(config: RtConfig, platform: string, home: string, fetcher: Fetcher = fetch): Promise<{ path: string; sha: string }> {
	if (!PLATFORM_RE.test(platform)) throw new GjcResolveError("gjc_platform_unsupported", platform);
	const own = config.gjcBinaries[platform];
	if (own) {
		if (!existsSync(own)) throw new GjcResolveError("gjc_binary_missing", own);
		return { path: own, sha: sha256File(own) };
	}
	if (platform === localPlatform()) {
		if (!existsSync(config.gjcBinary)) throw new GjcResolveError("gjc_binary_missing", config.gjcBinary);
		return { path: config.gjcBinary, sha: sha256File(config.gjcBinary) };
	}
	const shas = await releaseShas(config.gjcVersion, home, fetcher);
	assertOfficialOrigin(config, shas);
	const want = shas[platform];
	if (!want) throw new GjcResolveError("gjc_platform_unsupported", platform);
	const dir = join(home, "gjc", config.gjcVersion);
	const path = join(dir, `gjc-${platform}`);
	if (existsSync(path) && sha256File(path) === want) return { path, sha: want };
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const tmp = `${path}.tmp${process.pid}`;
	try {
		const r = await fetcher(releaseUrl(config.gjcVersion, `gjc-${platform}`));
		if (!r.ok) throw new GjcResolveError("gjc_release_unavailable", `HTTP ${r.status}`);
		await Bun.write(tmp, r);
		const got = sha256File(tmp);
		if (got !== want) throw new GjcResolveError("gjc_hash_mismatch", platform);
		chmodSync(tmp, 0o700);
		renameSync(tmp, path);
	} catch (e) {
		rmSync(tmp, { force: true });
		if (e instanceof GjcResolveError) throw e;
		throw new GjcResolveError("gjc_release_unavailable", String(e));
	}
	return { path, sha: want };
}
