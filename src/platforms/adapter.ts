import type { Platform } from "../domain/types.js";

export interface PlatformAdapter {
  platform: Platform;
  displayName: string;
  outputRoots: {
    skills: string;
    hooks: string;
    agents: string;
    commands: string;
    prompts: string;
  };
  templateDirectory: string;
  ensureInstalled(targetRoot: string): Promise<void>;
}
