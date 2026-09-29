import { Actor } from "apify";
import { run } from "./main.js";
await Actor.init();
try { await run((await Actor.getInput()) ?? {}, { pushData: value => Actor.pushData(value as Record<string, unknown>), setValue: (key, value) => Actor.setValue(key, value) }); }
finally { await Actor.exit(); }
