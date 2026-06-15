import { join } from "node:path";

import { readTextFileIfExists } from "../../../infra/fs.js";
import { ensureConfig, readConfig } from "../../../project/config.js";
import type { TiciouConfig } from "../../../project/config.js";
import { CURRENT_PROFILE_PATH } from "../../../project/paths.js";

export async function resolveProfileUser(options: {
  targetRoot: string;
  user?: string;
  requireUser?: boolean;
}): Promise<string> {
  if (options.user !== undefined && options.user.length > 0) {
    return options.user;
  }

  const currentProfile = (await readTextFileIfExists(join(options.targetRoot, CURRENT_PROFILE_PATH)))?.trim();
  if (currentProfile !== undefined && currentProfile.length > 0) {
    return currentProfile;
  }

  const config = await readConfig(options.targetRoot);
  if (config?.profiles.defaultUser !== undefined && config.profiles.defaultUser.length > 0) {
    return config.profiles.defaultUser;
  }

  if (options.requireUser === true) {
    throw new Error("No active Ticiou profile. Pass -u <user> first.");
  }

  return "";
}

export async function ensureProjectConfig(targetRoot: string): Promise<TiciouConfig> {
  return ensureConfig(targetRoot);
}
