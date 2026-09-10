import { createInterface } from "node:readline";
import { SelfPlayEnv, META } from "./environment";
import { ACTIONS } from "./actions";
let env = new SelfPlayEnv();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  try {
    const message = JSON.parse(line);
    let result: unknown;
    switch (message.command) {
      case "meta": result = { ...META, actions: ACTIONS }; break;
      case "reset": env = new SelfPlayEnv(message.options); result = env.reset(message.seed); break;
      case "step": result = env.step(message.action); break;
      case "snapshot": result = env.snapshot(); break;
      case "restore": result = env.restore(message.snapshot); break;
      case "replay": result = { schema: META.schema, sourceHash: META.sourceHash, seed: env.seed, options: env.options, actions: env.tape, replays: env.replays }; break;
      case "close": process.exit(0);
      default: throw Error("Unknown training command");
    }
    process.stdout.write(JSON.stringify({ ok: true, result }) + "\n");
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + "\n");
  }
});
