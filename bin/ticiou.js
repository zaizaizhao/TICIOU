#!/usr/bin/env node
import { main } from "../dist/cli/index.js";
import { formatError } from "../dist/cli/output.js";

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(formatError(message));
  process.exitCode = 1;
});
