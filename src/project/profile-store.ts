import { join } from "node:path";

import { pathExists, writeTextFile } from "../infra/fs.js";
import { resolveRuntimeProfilesDirectory } from "../infra/profile-paths.js";
import { CURRENT_PROFILE_PATH } from "./paths.js";

export async function ensurePackagedProfile(user: string): Promise<void> {
  const profileRoot = join(resolveRuntimeProfilesDirectory(), "users", user);
  if (!(await pathExists(profileRoot))) {
    throw new Error(`Profile ${user} was not found in packaged Ticiou profiles.`);
  }
}

export async function writeCurrentProfile(targetRoot: string, user: string): Promise<void> {
  await writeTextFile(join(targetRoot, CURRENT_PROFILE_PATH), `${user}\n`);
}
