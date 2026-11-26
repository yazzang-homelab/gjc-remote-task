// 잡 상태 전이표와 사용자에게 보이는 5단계(접수/실행/종료/검증/회수).

export type JobState =
	| "reserving"
	| "reserved"
	| "staged"
	| "launching"
	| "running"
	| "uncertain"
	| "ended"
	| "verified"
	| "collected"
	| "failed";

const ALLOWED: Record<JobState, JobState[]> = {
	reserving: ["reserved", "failed"],
	reserved: ["staged", "failed"],
	staged: ["launching", "failed"],
	launching: ["running", "uncertain", "failed", "ended"],
	running: ["ended", "uncertain", "failed"],
	uncertain: ["running", "ended", "failed"],
	ended: ["verified", "failed", "collected"],
	verified: ["collected", "verified"],
	collected: [],
	// 시작 전 실패라도 원격에 부분 결과가 남을 수 있으면 회수할 수 있다.
	failed: ["verified", "collected"],
};

export class TransitionError extends Error {
	constructor(
		readonly from: string,
		readonly to: string,
	) {
		super(`illegal_transition:${from}->${to}`);
	}
}

export function assertTransition(from: string, to: JobState): void {
	if (from === to) return;
	const allowed = ALLOWED[from as JobState];
	if (!allowed || !allowed.includes(to)) throw new TransitionError(from, to);
}

export function phaseOf(state: string): "접수" | "실행" | "종료" | "검증" | "회수" {
	switch (state) {
		case "reserving":
		case "reserved":
		case "staged":
			return "접수";
		case "launching":
		case "running":
		case "uncertain":
			return "실행";
		case "ended":
		case "failed":
			return "종료";
		case "verified":
			return "검증";
		default:
			return "회수";
	}
}

/** 잡 id: rt- + 26자 소문자 ULID(시간순 정렬). 원격 rt-helper 정규식 ^rt-[0-9a-z]{26}$와 맞춘다. */
export function newJobId(now = Date.now()): string {
	const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
	let t = now;
	let time = "";
	for (let i = 0; i < 10; i++) {
		time = alphabet[t % 32] + time;
		t = Math.floor(t / 32);
	}
	const rand = crypto.getRandomValues(new Uint8Array(16));
	let tail = "";
	for (let i = 0; i < 16; i++) tail += alphabet[rand[i]! % 32];
	return `rt-${time}${tail}`;
}

export function newMsgId(): string {
	return `msg-${newJobId().slice(3).toLowerCase()}`;
}
