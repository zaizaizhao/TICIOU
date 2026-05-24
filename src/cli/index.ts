import { createProgram } from "./program.js";
import { formatError } from "./output.js";

export async function main(argv = process.argv): Promise<void> {
  await createProgram().parseAsync(argv);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(formatError(message));
  process.exitCode = 1;
});
