// inbox 커서: rtc1.<job>.<seq>.<hmac>. 로컬 비밀키로 서명해 다른 잡·위조 커서를 거절한다(AC-6).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store } from "./store";

export type CursorError = "cursor_required" | "cursor_invalid" | "cursor_ahead";

function secret(store: Store): Buffer {
	let hex = store.meta("cursor_secret");
	if (!hex) {
		// 여러 세션이 동시에 만들어도 먼저 들어간 하나만 쓴다.
		store.db.run("INSERT OR IGNORE INTO meta(k, v) VALUES ('cursor_secret', ?)", [randomBytes(32).toString("hex")]);
		hex = store.meta("cursor_secret")!;
	}
	return Buffer.from(hex, "hex");
}

function sign(store: Store, job: string, seq: number): string {
	return createHmac("sha256", secret(store)).update(`${job}.${seq}`).digest("hex").slice(0, 32);
}

export function makeCursor(store: Store, job: string, seq: number): string {
	return `rtc1.${job}.${seq}.${sign(store, job, seq)}`;
}

export function parseCursor(
	store: Store,
	job: string,
	cursor: string | undefined,
	lastSeq: number,
): { ok: true; seq: number } | { ok: false; error: CursorError } {
	if (!cursor) return { ok: false, error: "cursor_required" };
	const m = /^rtc1\.(rt-[0-9a-z]{26})\.(\d{1,12})\.([0-9a-f]{32})$/.exec(cursor);
	if (!m || m[1] !== job) return { ok: false, error: "cursor_invalid" };
	const seq = Number(m[2]);
	const want = Buffer.from(sign(store, job, seq));
	if (!timingSafeEqual(want, Buffer.from(m[3]!))) return { ok: false, error: "cursor_invalid" };
	if (seq > lastSeq) return { ok: false, error: "cursor_ahead" };
	return { ok: true, seq };
}
