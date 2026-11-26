// gjc-rt 원격 워커 확장. 원격 잡 세션 안에서만 동작한다(GJC_RT_JOB_DIR 없으면 아무것도 안 함).
// 메인과의 대화는 잡 디렉터리의 파일로만 한다: inbox.jsonl(메인→원격), worker-out.jsonl(원격→러너→메인).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROLE_MARKER = "GJC-RT-ROLE-v1";
const ASK_TIMEOUT_MS = 30 * 60 * 1000;

interface InboxMsg {
	id: string;
	ts: string;
	reply_to: string | null;
	text: string;
}

export default function activate(gjc: any) {
	const dir = process.env.GJC_RT_JOB_DIR;
	if (!dir) return;
	const z = gjc.zod;
	const outPath = join(dir, "worker-out.jsonl");
	const inboxPath = join(dir, "inbox.jsonl");
	const statePath = join(dir, "worker-state.json");

	const state: { delivered: string[]; answered: string[]; consumed: string[] } = existsSync(statePath)
		? JSON.parse(readFileSync(statePath, "utf8"))
		: { delivered: [], answered: [], consumed: [] };
	const save = () => writeFileSync(statePath, JSON.stringify(state));
	const emit = (kind: string, data: Record<string, unknown>) =>
		appendFileSync(outPath, `${JSON.stringify({ kind, data })}\n`);
	const readInbox = (): InboxMsg[] => {
		if (!existsSync(inboxPath)) return [];
		const out: InboxMsg[] = [];
		for (const line of readFileSync(inboxPath, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const m = JSON.parse(line);
				if (m && typeof m.id === "string" && typeof m.text === "string") out.push(m);
			} catch {}
		}
		return out;
	};
	const pendingQuestions = new Set<string>();
	let qCounter = 0;
	let roleChecked = false;

	const wrap = (m: InboxMsg) =>
		`<main-message id="${m.id}"${m.reply_to ? ` reply_to="${m.reply_to}"` : ""}>\n${m.text}\n</main-message>`;

	// 질문 답이 아닌 메인 메시지는 steer로 넣는다.
	const deliverLoose = () => {
		for (const m of readInbox()) {
			if (state.delivered.includes(m.id) || state.answered.includes(m.id)) continue;
			if (m.reply_to && pendingQuestions.has(m.reply_to)) continue;
			state.delivered.push(m.id);
			save();
			try {
				gjc.sendMessage(
					{ customType: "remote-task-main", content: wrap(m), display: true, details: { msgId: m.id } },
					{ deliverAs: "steer", triggerTurn: true },
				);
			} catch (err) {
				emit("error", { code: "steer_failed", msgId: m.id, detail: String(err).slice(0, 200) });
			}
		}
	};
	const timer = setInterval(deliverLoose, 2000);
	(timer as any).unref?.();

	gjc.on("message_start", (event: any) => {
		const msg = event?.message;
		const id = msg?.customType === "remote-task-main" ? msg?.details?.msgId : undefined;
		if (typeof id === "string" && !state.consumed.includes(id)) {
			state.consumed.push(id);
			save();
			emit("consumed", { id });
		}
	});

	gjc.on("before_agent_start", (event: any, ctx: any) => {
		if (roleChecked) return;
		roleChecked = true;
		const prompt = Array.isArray(event?.systemPrompt) ? event.systemPrompt.join("\n") : String(event?.systemPrompt ?? "");
		emit("role_check", {
			roleMarker: prompt.includes(ROLE_MARKER),
			model: ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
			tools: gjc.getActiveTools(),
		});
	});

	gjc.registerTool({
		name: "ask_main",
		label: "ask main",
		description:
			"원격 작업을 맡긴 메인 에이전트에게 질문하고 답을 기다린다(최대 30분). 진행이 불가능하거나 범위를 바꾸는 결정이 필요할 때만 쓴다.",
		parameters: z.object({ question: z.string().min(1).max(8000) }),
		async execute(_id: string, params: { question: string }, signal?: AbortSignal) {
			const qid = `q-${Date.now().toString(36)}-${++qCounter}`;
			pendingQuestions.add(qid);
			emit("question", { qid, text: params.question });
			const deadline = Date.now() + ASK_TIMEOUT_MS;
			try {
				while (Date.now() < deadline && !signal?.aborted) {
					const answer = readInbox().find(
						m =>
							!state.answered.includes(m.id) &&
							!state.delivered.includes(m.id) &&
							(m.reply_to === qid || (m.reply_to === null && pendingQuestions.size === 1)),
					);
					if (answer) {
						state.answered.push(answer.id);
						save();
						emit("answer_consumed", { qid, id: answer.id });
						return { content: [{ type: "text", text: wrap(answer) }] };
					}
					await new Promise(r => setTimeout(r, 1000));
				}
				emit("progress", { note: "ask_main 답 없음(시간 초과)", qid });
				return {
					content: [
						{ type: "text", text: "메인이 30분 안에 답하지 않았다. 가장 안전한 가정으로 계속하고, 그 사실을 final_report에 적어라." },
					],
				};
			} finally {
				pendingQuestions.delete(qid);
			}
		},
	});

	gjc.registerTool({
		name: "report_progress",
		label: "report progress",
		description: "메인에게 짧은 진행 상황을 알린다(답을 기다리지 않음).",
		parameters: z.object({ text: z.string().min(1).max(2000) }),
		async execute(_id: string, params: { text: string }) {
			emit("progress", { note: params.text });
			return { content: [{ type: "text", text: "전달됨" }] };
		},
	});

	gjc.registerTool({
		name: "final_report",
		label: "final report",
		description:
			"작업을 끝낼 때 반드시 한 번 부른다. 요약과 남은 질문을 메인에게 보낸다. 읽지 않은 메인 메시지가 있으면 보고 대신 그 메시지를 돌려준다.",
		parameters: z.object({
			summary: z.string().min(1).max(12000),
			open_questions: z.array(z.string().max(2000)).max(20).optional(),
		}),
		async execute(_id: string, params: { summary: string; open_questions?: string[] }) {
			deliverLoose();
			const unread = readInbox().filter(m => state.delivered.includes(m.id) && !state.consumed.includes(m.id));
			if (unread.length > 0) {
				for (const m of unread) {
					state.consumed.push(m.id);
					emit("consumed", { id: m.id });
				}
				save();
				return {
					content: [
						{ type: "text", text: `아직 반영하지 않은 메인 메시지가 있다. 먼저 처리하라:\n${unread.map(wrap).join("\n")}` },
					],
				};
			}
			emit("final", { summary: params.summary, open_questions: params.open_questions ?? [] });
			return { content: [{ type: "text", text: "보고 완료. 더 이상 도구를 부르지 말고 짧게 끝내라." }] };
		},
	});
}
