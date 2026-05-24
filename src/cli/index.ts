import { pathToFileURL } from "node:url";

import { createProgram } from "./program.js";
import { formatError } from "./output.js";

export async function main(argv = process.argv): Promise<void> {
  const program = createProgram();
  if (argv.length <= 2) {
    console.log(program.helpInformation());
    return;
  }

  await program.parseAsync(argv);
}

if (isCliEntrypoint()) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(formatError(message));
    process.exitCode = 1;
  });
}

function isCliEntrypoint(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
}
