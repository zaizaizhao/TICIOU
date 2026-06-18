import type { Platform, TargetMode } from "../../domain/types.js";
import type { CommandRunner } from "../../infra/command-runner.js";
import type { DiscoverItem } from "../../skillhub/types.js";

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
  registry?: string;
  token?: string;
  askToken?: boolean;
  anonymous?: boolean;
  frozen?: boolean;
}

export interface SetupProjectOptions extends CommandOptions {
  user?: string;
  platforms: Platform[];
  registry?: string;
  token?: string;
  askToken?: boolean;
  yes?: boolean;
  skillSelector?: SkillSelector;
  fetchImpl?: typeof fetch;
}

export interface SkillSelectorContext {
  user: string;
  registry: string;
  items: DiscoverItem[];
}

export type SkillSelector = (context: SkillSelectorContext) => Promise<DiscoverItem[]>;

export type ClearScope = "user" | "all";

export interface ClearResourcesOptions extends CommandOptions {
  scope: ClearScope;
}

export type CommandMessageTone = "success" | "warning" | "error";

export type CommandMessage = string | {
  text: string;
  tone?: CommandMessageTone;
};

export interface CommandResult {
  targetRoot: string;
  messages: CommandMessage[];
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
  messages: CommandMessage[];
}
