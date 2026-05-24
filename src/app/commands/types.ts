import type { Platform, TargetMode } from "../../domain/types.js";
import type { CommandRunner } from "../../infra/command-runner.js";

export interface CommandOptions {
  cwd: string;
  target?: TargetMode;
  runner?: CommandRunner;
}

export interface InstallPlatformOptions extends CommandOptions {
  platform: Platform;
}

export interface UseProfileOptions extends CommandOptions {
  user: string;
}

export type ClearScope = "user" | "all";

export interface ClearResourcesOptions extends CommandOptions {
  scope: ClearScope;
}

export interface CommandResult {
  targetRoot: string;
  messages: string[];
}

export interface StatusResult {
  targetRoot: string;
  currentProfile?: string;
  enabledPlatforms: Platform[];
  generatedFileCount: number;
}

export interface DoctorResult {
  targetRoot: string;
  ok: boolean;
  messages: string[];
}
