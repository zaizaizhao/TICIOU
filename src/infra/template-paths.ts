import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function resolveRuntimeTemplateDirectory(templateDirectory: string): string {
  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  return join(currentDirectory, "..", "templates", templateDirectory);
}
