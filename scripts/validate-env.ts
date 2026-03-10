import { inspectApiEnv } from "../packages/config/src/api.ts";
import { ConfigValidationError } from "../packages/config/src/errors.ts";
import { inspectWebEnv } from "../packages/config/src/web.ts";

const runtime = process.argv[2];

if (runtime !== "api" && runtime !== "web") {
  process.stderr.write("Usage: validate-env.ts <api|web>\n");
  process.exit(64);
}

try {
  const inspectedEnv =
    runtime === "api" ? inspectApiEnv() : inspectWebEnv();

  process.stdout.write(`${JSON.stringify(inspectedEnv.healthEvent, null, 2)}\n`);
} catch (error) {
  if (error instanceof ConfigValidationError) {
    process.stderr.write(`${JSON.stringify(error.toJSON(), null, 2)}\n`);
    process.exit(1);
  }

  throw error;
}
