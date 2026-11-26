// 설정: ~/.gjc/agent/remote-task/config.yml (없으면 기본값: 대상 없음). 비밀은 여기 두지 않는다.
// 예시는 저장소의 config.example.yml.
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export interface SshTarget {
	kind: "ssh";
	host: string;
	user: string;
	port: number;
	maxSlots: number;
	/** 대상 쪽 부하 거절 기준(load1/코어). 실제 강제는 대상 rt-helper 설정이 한다. */
	loadMax: number;
}

/** 박스(instabox.sh microVM) 대상. 박스 풀 원장이 이 호스트 상태 DB에 있으므로 박스는 원점 한 곳에만 설정한다. */
export interface BoxTarget {
	kind: "box";
	/** instabox-q 별칭 */
	alias: string;
	/** instabox 머신 이름(cli·port-forward용) */
	machine: string;
	maxSlots: number;
}

export type Target = SshTarget | BoxTarget;

export interface RtConfig {
	origin: string;
	targets: Record<string, Target>;
	/** 박스 pump가 모델 요청을 보낼 허브와 키 파일(root 0600, 값은 argv·로그에 넣지 않는다). */
	box: { hubBase: string; keyFile: string };
	gjcVersion: string;
	gjcBinary: string;
	defaultModel: string;
	rtKey: { allowedModels: string[] };
	thresholds: { recommendLoad: number; recommendMemFree: number };
	retentionDays: number;
	sshConnectTimeoutS: number;
}

export function rtHome(): string {
	return process.env.GJC_RT_HOME ?? join(process.env.GJC_CODING_AGENT_DIR ?? join(homedir(), ".gjc", "agent"), "remote-task");
}

const DEFAULTS: RtConfig = {
	// 원점 이름은 작업 호스트의 authorized_keys(command= --origin)와 등록 토큰 파일 이름에 쓰인다.
	origin: hostname().split(".")[0]!.toLowerCase(),
	targets: {},
	box: { hubBase: "", keyFile: "" },
	gjcVersion: "",
	gjcBinary: join(homedir(), ".local", "bin", "gjc"),
	defaultModel: "",
	rtKey: { allowedModels: [] },
	thresholds: { recommendLoad: 0.8, recommendMemFree: 0.2 },
	retentionDays: 7,
	sshConnectTimeoutS: 10,
};

export function loadConfig(path = join(rtHome(), "config.yml")): RtConfig {
	if (!existsSync(path)) return structuredClone(DEFAULTS);
	const raw = (Bun.YAML.parse(readFileSync(path, "utf8")) ?? {}) as Partial<RtConfig>;
	const targets: Record<string, Target> = {};
	for (const [name, t] of Object.entries(raw.targets ?? DEFAULTS.targets)) {
		const base = DEFAULTS.targets[name];
		const kind = (t as { kind?: string }).kind ?? base?.kind ?? "ssh";
		const fallback = kind === "box" ? { kind: "box", maxSlots: 1 } : { kind: "ssh", user: "gjcrt-ctl", port: 22, maxSlots: 1, loadMax: 0.7 };
		targets[name] = { ...(base ?? fallback), ...(t as object) } as Target;
	}
	const out: RtConfig = {
		...DEFAULTS,
		...raw,
		targets,
		rtKey: { ...DEFAULTS.rtKey, ...(raw.rtKey ?? {}) },
		thresholds: { ...DEFAULTS.thresholds, ...(raw.thresholds ?? {}) },
		box: { ...DEFAULTS.box, ...(raw.box ?? {}) },
	};
	if (out.gjcBinary.startsWith("~/")) out.gjcBinary = join(homedir(), out.gjcBinary.slice(2));
	if (!out.gjcVersion) out.gjcVersion = gjcVersionOf(out.gjcBinary);
	return out;
}

/** `gjc --version`("gjc/0.22.0")에서 판을 읽는다. 실패하면 빈 문자열(작업 호스트가 거절한다). */
function gjcVersionOf(binary: string): string {
	if (!existsSync(binary)) return "";
	try {
		const r = Bun.spawnSync([binary, "--version"], { stdout: "pipe", stderr: "ignore", timeout: 10_000 });
		return r.stdout.toString().trim().replace(/^gjc\//, "");
	} catch {
		return "";
	}
}

/** 모델 선택자를 비교용으로 정규화한다(사고 단계 접미사 제거, 소문자). */
export function normalizeModel(sel: string): string {
	return sel.split(":", 1)[0]!.toLowerCase();
}
