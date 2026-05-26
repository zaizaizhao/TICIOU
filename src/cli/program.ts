import { Command } from "commander";

import {
  clearResources,
  doctorProject,
  getStatus,
  initProject,
  installPlatform,
  setupProject,
  useProfile,
} from "../app/commands/index.js";
import { isPlatform, isTargetMode } from "../domain/types.js";
import type { Platform, TargetMode } from "../domain/types.js";
import type { ClearScope } from "../app/commands/index.js";
import { formatCommandResult, formatRootHelp, formatStatus } from "./output.js";

export function createProgram(): Command {
  const program = new Command();

  program.name("ticiou").description("Compile shared and user AI profiles into Claude and Copilot project config").version("0.1.0");
  program.configureHelp({
    formatHelp: () => formatRootHelp(),
  });

  program
    .command("init")
    .description("Initialize Ticiou source directories in the target project")
    .option("--target <mode>", "Target resolution mode: cwd or git-root", parseTargetMode)
    .action(async (options: { target?: TargetMode }) => {
      const result = await initProject({ cwd: process.cwd(), target: options.target });
      printOutput(
        formatCommandResult({
          title: "Ticiou init",
          messages: result.messages,
          nextAction: "ticiou install claude",
        }),
      );
    });

  program
    .command("install")
    .description("Install a platform adapter")
    .argument("<platform>", "Platform adapter: claude or copilot", parsePlatform)
    .option("--target <mode>", "Target resolution mode: cwd or git-root", parseTargetMode)
    .action(async (platform: Platform, options: { target?: TargetMode }) => {
      const result = await installPlatform({ cwd: process.cwd(), platform, target: options.target });
      printOutput(
        formatCommandResult({
          title: "Ticiou install",
          messages: result.messages,
          nextAction: "ticiou use -u <user>",
        }),
      );
    });

  program
    .command("setup")
    .description("Initialize a project, install platform adapters, and activate a user profile")
    .requiredOption("-u, --user <user>", "User profile id")
    .option("-p, --platform <platform>", "Platform adapter: claude or copilot", collectPlatform, [] as Platform[])
    .option("--target <mode>", "Target resolution mode: cwd or git-root", parseTargetMode)
    .action(async (options: { user: string; platform: Platform[]; target?: TargetMode }) => {
      const platforms = options.platform.length === 0 ? ["claude" as Platform] : options.platform;
      const result = await setupProject({
        cwd: process.cwd(),
        user: options.user,
        platforms,
        target: options.target,
      });
      printOutput(
        formatCommandResult({
          title: "Ticiou setup",
          messages: result.messages,
          nextAction: "ticiou doctor",
        }),
      );
    });

  program
    .command("use")
    .description("Activate a user profile and render enabled platform resources")
    .requiredOption("-u, --user <user>", "User profile id")
    .option("--target <mode>", "Target resolution mode: cwd or git-root", parseTargetMode)
    .action(async (options: { user: string; target?: TargetMode }) => {
      const result = await useProfile({ cwd: process.cwd(), user: options.user, target: options.target });
      printOutput(
        formatCommandResult({
          title: "Ticiou use",
          messages: result.messages,
          nextAction: "ticiou doctor",
        }),
      );
    });

  program
    .command("clear")
    .description("Clear rendered Ticiou resources")
    .argument("<scope>", "Clear scope: user or all", parseClearScope)
    .option("--target <mode>", "Target resolution mode: cwd or git-root", parseTargetMode)
    .action(async (scope: ClearScope, options: { target?: TargetMode }) => {
      const result = await clearResources({ cwd: process.cwd(), scope, target: options.target });
      printOutput(
        formatCommandResult({
          title: "Ticiou clear",
          messages: result.messages,
          nextAction: scope === "user" ? "ticiou use -u <user>" : "ticiou install claude",
        }),
      );
    });

  program
    .command("status")
    .description("Show active profile, enabled platforms, and generated file count")
    .option("--target <mode>", "Target resolution mode: cwd or git-root", parseTargetMode)
    .action(async (options: { target?: TargetMode }) => {
      const status = await getStatus({ cwd: process.cwd(), target: options.target });
      printOutput(formatStatus(status));
    });

  program
    .command("doctor")
    .description("Validate the current Ticiou target")
    .option("--target <mode>", "Target resolution mode: cwd or git-root", parseTargetMode)
    .action(async (options: { target?: TargetMode }) => {
      const result = await doctorProject({ cwd: process.cwd(), target: options.target });
      printOutput(
        formatCommandResult({
          title: "Ticiou doctor",
          messages: result.messages,
          ok: result.ok,
        }),
      );
      if (!result.ok) {
        process.exitCode = 1;
      }
    });

  return program;
}

function parsePlatform(value: string): Platform {
  if (!isPlatform(value)) {
    throw new Error(`Unsupported platform: ${value}. Expected claude or copilot.`);
  }
  return value;
}

function collectPlatform(value: string, previous: Platform[]): Platform[] {
  const platform = parsePlatform(value);
  return previous.includes(platform) ? previous : [...previous, platform];
}

function parseTargetMode(value: string): TargetMode {
  if (!isTargetMode(value)) {
    throw new Error(`Unsupported target mode: ${value}. Expected cwd or git-root.`);
  }
  return value;
}

function parseClearScope(value: string): ClearScope {
  if (value !== "user" && value !== "all") {
    throw new Error(`Unsupported clear scope: ${value}. Expected user or all.`);
  }
  return value;
}

function printOutput(output: string): void {
  console.log(output);
}
