// 규칙 엔진(순수 함수). 후보·권장·탈락 사유를 계산한다. 최종 선택은 메인 LLM이 한다(§5.6).
import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import { normalizeModel, type RtConfig } from "./config";

export interface LocalSnapshot {
	load1: number;
	ncpu: number;
	memAvailRatio: number;
}

export function localSnapshot(): LocalSnapshot {
	const load1 = Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]);
	const mem: Record<string, number> = {};
	for (const line of readFileSync("/proc/meminfo", "utf8").split("\n")) {
		const m = /^(\w+):\s+(\d+)/.exec(line);
		if (m) mem[m[1]!] = Number(m[2]);
	}
	return {
		load1,
		ncpu: cpus().length || 1,
		memAvailRatio: Math.round(((mem.MemAvailable ?? 0) / Math.max(1, mem.MemTotal ?? 1)) * 1000) / 1000,
	};
}

/** 대상 probe 결과(원격 rt-helper probe 응답 일부). 연결 실패면 error만 있다. */
export interface TargetProbe {
	error?: string;
	snapshot?: { load_ratio: number; mem_avail_ratio: number; disk_free_gb: number; psi_mem?: number | null; contention_psi?: number | null };
	slots_used?: number;
	slots_max?: number;
	load_max?: number;
	credential?: boolean;
	trusted_gjc?: string[];
	model_rejection?: string | null;
	/** 대상이 지금 reserve를 받으면 낼 거절 사유(부하·PSI·디스크·경합 slice). */
	admission?: string[];
}

export interface RuleInput {
	config: RtConfig;
	local: LocalSnapshot;
	model: string;
	repo: { dirty: boolean; submodules: boolean };
	probes: Record<string, TargetProbe>;
	/** 로컬 원장에서 센 대상별 살아 있는 잡 수 */
	localLive: Record<string, number>;
	/** 저장소 쪽 사유를 대상 종류별로(예: 박스만 origin_not_public). */
	repoRejections?: Partial<Record<"ssh" | "box", string[]>>;
}

export interface RuleOutput {
	local: LocalSnapshot & { loadRatio: number };
	recommendRemote: boolean;
	recommendReasons: string[];
	candidates: { target: string; freeSlots: number; loadRatio: number }[];
	rejections: Record<string, string[]>;
	noTarget: boolean;
	recommended: string | null;
}

export function evaluate(input: RuleInput): RuleOutput {
	const { config, local } = input;
	const loadRatio = Math.round((local.load1 / local.ncpu) * 1000) / 1000;
	const recommendReasons: string[] = [];
	if (loadRatio >= config.thresholds.recommendLoad) recommendReasons.push(`local_load ${loadRatio} >= ${config.thresholds.recommendLoad}`);
	if (local.memAvailRatio < config.thresholds.recommendMemFree)
		recommendReasons.push(`local_mem_free ${local.memAvailRatio} < ${config.thresholds.recommendMemFree}`);

	const allowed = config.rtKey.allowedModels.map(normalizeModel);
	const modelAllowed = allowed.includes(normalizeModel(input.model));
	const rejections: Record<string, string[]> = {};
	const candidates: RuleOutput["candidates"] = [];
	for (const [name, t] of Object.entries(config.targets)) {
		const reasons: string[] = [];
		if (!modelAllowed) reasons.push("model_not_allowed");
		if (input.repo.dirty) reasons.push("dirty_worktree");
		if (input.repo.submodules) reasons.push("submodules_present");
		const p = input.probes[name];
		if (!p || p.error) {
			reasons.push(p?.error ?? "unreachable");
		} else {
			const maxSlots = Math.min(t.maxSlots, p.slots_max ?? t.maxSlots);
			const used = Math.max(p.slots_used ?? 0, input.localLive[name] ?? 0);
			if (used >= maxSlots) reasons.push("slots_full");
			// 박스는 부하·디스크를 깨우지 않고 알 수 없다(P-2). 박스 쪽 판정은 admission(잔여 시간·쿨다운)과 job.sh setup이 한다.
			const s = p.snapshot;
			if (s && t.kind === "ssh" && s.load_ratio >= Math.min(t.loadMax, p.load_max ?? t.loadMax)) reasons.push("remote_overloaded");
			if (p.credential === false) reasons.push("credential_missing");
			if (p.trusted_gjc && !p.trusted_gjc.includes(config.gjcVersion)) reasons.push("gjc_version_untrusted");
			if (p.model_rejection) reasons.push(p.model_rejection);
			for (const r of p.admission ?? []) reasons.push(r);
			if (s && s.disk_free_gb < 5) reasons.push("disk_low");
			for (const r of input.repoRejections?.[t.kind] ?? []) reasons.push(r);
			if (reasons.length === 0) candidates.push({ target: name, freeSlots: maxSlots - used, loadRatio: s?.load_ratio ?? 0 });
		}
		if (reasons.length > 0) rejections[name] = [...new Set(reasons)];
	}
	// 권장 대상: 여유 슬롯이 많고 부하가 낮은 순(정보일 뿐).
	candidates.sort((a, b) => b.freeSlots - a.freeSlots || a.loadRatio - b.loadRatio);
	return {
		local: { ...local, loadRatio },
		recommendRemote: recommendReasons.length > 0,
		recommendReasons,
		candidates,
		rejections,
		noTarget: candidates.length === 0,
		recommended: candidates[0]?.target ?? null,
	};
}
