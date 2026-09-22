import { spawnSync } from "node:child_process";
if (!process.env.TEST_DATABASE_URL) {
  process.stderr.write("Set TEST_DATABASE_URL to a dedicated PostgreSQL test database. Never use production.\n");
  process.exit(1);
}
const result = spawnSync(process.execPath,["--import","tsx","--test","tests/customers.test.ts"], { stdio:"inherit", env:process.env, windowsHide:true });
process.exit(result.status ?? 1);
