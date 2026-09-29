import { Actor } from "apify";
import { run } from "./main.js";
import { safeError } from "./validation.js";

await Actor.init();
console.info("Global Company Intelligence entrypoint started");
try {
  const env = Actor.getEnv();
  const origin = env.metaOrigin?.toUpperCase();
  const billingMode = !Actor.isAtHome() || origin === "DEVELOPMENT" || origin === "TEST" ? "development" : "production";
  console.info("Actor billing mode selected", { billingMode, origin: origin ?? null, isAtHome: Actor.isAtHome() });
  const input = await Actor.getInput();
  console.info("Actor input loaded", { hasInput: Boolean(input), keys: input && typeof input === "object" ? Object.keys(input) : [] });
  await run(input ?? {}, {
    charge: options => Actor.charge(options),
    pushData: data => Actor.pushData(data as Record<string, unknown>),
    setValue: (key, value) => Actor.setValue(key, value),
    billingMode
  });
  console.info("Global Company Intelligence entrypoint completed");
} catch (error) {
  const mapped = safeError(error);
  console.error("Global Company Intelligence entrypoint failed", mapped);
  await Actor.setValue("OUTPUT", { status: "failed", error: mapped });
  process.exitCode = 1;
} finally {
  await Actor.exit();
}
