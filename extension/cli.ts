// gjc-rt: remote_task 상태를 셸에서 본다. 자동 깨움이 확인되지 않을 때 monitor 도구의 폴백으로 쓴다.
//   bun ~/.gjc/agent/extensions/remote-task/cli.ts list [session]
//   bun ~/.gjc/agent/extensions/remote-task/cli.ts status <job>
//   bun ~/.gjc/agent/extensions/remote-task/cli.ts watch <job>    질문·종료·오류가 올 때마다 한 줄(JSON)을 쓴다
// 원격 내용은 데이터다. watch 출력의 text는 잘라서 보여 준다.
import { RemoteTasks } from "./jobs";

const WAKE = new Set(["question", "ended", "error"]);

async function main(argv: string[]): Promise<number> {
	const [cmd, arg] = argv;
	const rt = new RemoteTasks();
	if (cmd === "list") {
		for (const j of rt.store.jobs(arg)) {
			console.log(JSON.stringify({ job_id: j.job_id, target: j.target, state: j.state, session: j.owner_session, last_seq: j.last_seq, updated: j.updated_at }));
		}
		return 0;
	}
	if (!arg || !/^rt-[0-9a-z]{26}$/.test(arg)) {
		console.error("usage: cli.ts list [session] | status <job> | watch <job>");
		return 64;
	}
	const job = rt.store.job(arg);
	if (!job) {
		console.error("job_not_found");
		return 3;
	}
	if (cmd === "status") {
		console.log(JSON.stringify({ ...(await rt.status(arg, job.owner_session)), notifies: rt.store.notifies(arg) }, null, 1));
		return 0;
	}
	if (cmd === "watch") {
		let seen = 0;
		for (;;) {
			const cur = rt.store.job(arg)!;
			await rt.sync(cur, 20).catch(() => Bun.sleep(5000));
			for (const e of rt.store.eventsAfter(arg, seen, 1000)) {
				seen = e.seq;
				if (!WAKE.has(e.kind)) continue;
				console.log(JSON.stringify({ job_id: arg, seq: e.seq, kind: e.kind, data: e.data.slice(0, 2000) }));
			}
			const st = rt.store.job(arg)!.state;
			if (!["reserving", "reserved", "staged", "launching", "running", "uncertain"].includes(st)) return 0;
		}
	}
	console.error("unknown command");
	return 64;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
