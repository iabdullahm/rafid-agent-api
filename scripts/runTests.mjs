import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const testsDirectory = fileURLToPath(new URL("../tests/", import.meta.url));
const tests = (await readdir(testsDirectory))
  .filter(file => file.endsWith(".test.ts"))
  .sort()
  .map(file => `tests/${file}`);

if (tests.length === 0) throw new Error("No test files found.");

for (const test of tests) {
  console.log(`\n# ${test}`);
  const child = spawn(process.execPath, ["--import", "tsx", "--test", test], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdio: "inherit",
    windowsHide: true
  });
  const exitCode = await new Promise(resolve => child.once("close", code => resolve(code ?? 1)));
  if (exitCode !== 0) {
    process.exitCode = exitCode;
    break;
  }
}
