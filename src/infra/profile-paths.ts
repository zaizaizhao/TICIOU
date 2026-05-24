import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

export function resolveRuntimeProfilesDirectory(): string {
  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  const distProfiles = join(currentDirectory, "..", "profiles");
  if (existsSync(distProfiles)) {
    return distProfiles;
  }

  return join(currentDirectory, "..", "..", "profiles");
}
