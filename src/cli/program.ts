import { Command } from "commander";
import readline from "node:readline/promises";

import {
  clearResources,
  doctorProject,
  getStatus,
  initProject,
  installPlatform,
  addSkill,
  listSkills,
  loginSkillHub,
  logoutSkillHub,
  removeSkill,
  setupProject,
  syncSkills,
  useProfile,
  whoamiSkillHub,
} from "../app/commands/index.js";
import { isPlatform, isTargetMode } from "../domain/types.js";
import type { Platform, TargetMode } from "../domain/types.js";
import type { ClearScope, SkillSelectorContext } from "../app/commands/index.js";
import type { DiscoverItem } from "../skillhub/types.js";
import { formatBrandBanner, formatCommandResult, formatRootHelp, formatStatus } from "./output.js";

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
    .description("Initialize a project, install platform adapters, and activate SkillHub skills")
    .option("-u, --user <user>", "User profile id for legacy packaged profile activation")
    .option("-p, --platform <platform>", "Platform adapter: claude or copilot", collectPlatform, [] as Platform[])
    .option("--target <mode>", "Target resolution mode: cwd or git-root", parseTargetMode)
    .option("--registry <url>", "SkillHub registry URL")
    .option("--token <token>", "SkillHub token for this command only")
    .option("--ask-token", "Prompt for a SkillHub token when needed")
    .option("--yes", "Enable all discovered SkillHub skills without prompting")
    .action(async (options: { user?: string; platform: Platform[]; target?: TargetMode; registry?: string; token?: string; askToken?: boolean; yes?: boolean }) => {
      const platforms = options.platform.length === 0 ? ["claude" as Platform] : options.platform;
      const result = await setupProject({
        cwd: process.cwd(),
        user: options.user,
        platforms,
        target: options.target,
        registry: options.registry,
        token: options.token,
        askToken: options.askToken,
        yes: options.yes,
        skillSelector: process.stdin.isTTY && options.yes !== true ? selectSkillsInteractively : undefined,
      });
      printOutput(
        [
          formatBrandBanner(),
          "",
          formatCommandResult({
            title: "Ticiou setup",
            messages: result.messages,
            nextAction: "ticiou doctor",
          }),
        ].join("\n"),
      );
    });

  program
    .command("use")
    .description("Activate a user profile and render enabled platform resources")
    .requiredOption("-u, --user <user>", "User profile id")
    .option("--target <mode>", "Target resolution mode: cwd or git-root", parseTargetMode)
    .option("--registry <url>", "SkillHub registry URL")
    .option("--token <token>", "SkillHub token for this command only")
    .option("--ask-token", "Prompt for a SkillHub token when needed")
    .option("--anonymous", "Disable saved/env token lookup and use public SkillHub access")
    .option("--frozen", "Do not write SkillHub lock changes")
    .action(async (options: { user: string; target?: TargetMode; registry?: string; token?: string; askToken?: boolean; anonymous?: boolean; frozen?: boolean }) => {
      const result = await useProfile({
        cwd: process.cwd(),
        user: options.user,
        target: options.target,
        registry: options.registry,
        token: options.token,
        askToken: options.askToken,
        anonymous: options.anonymous,
        frozen: options.frozen,
      });
      printOutput(
        formatCommandResult({
          title: "Ticiou use",
          messages: result.messages,
          nextAction: "ticiou doctor",
        }),
      );
    });

  const skillhub = program.command("skillhub").description("Manage SkillHub credentials");
  skillhub
    .command("login")
    .description("Save a SkillHub token for this user account")
    .option("--registry <url>", "SkillHub registry URL")
    .option("--token <token>", "SkillHub token")
    .option("--no-save", "Verify the token without saving it locally")
    .action(async (options: { registry?: string; token?: string; save?: boolean }) => {
      const result = await loginSkillHub({ cwd: process.cwd(), registry: options.registry, token: options.token, save: options.save });
      printOutput(formatCommandResult({ title: "Ticiou skillhub login", messages: result.messages }));
    });
  skillhub
    .command("whoami")
    .description("Show the current SkillHub user")
    .option("--registry <url>", "SkillHub registry URL")
    .option("--token <token>", "SkillHub token for this command only")
    .option("--ask-token", "Prompt for a SkillHub token when needed")
    .option("--anonymous", "Disable saved/env token lookup")
    .action(async (options: { registry?: string; token?: string; askToken?: boolean; anonymous?: boolean }) => {
      const result = await whoamiSkillHub({ cwd: process.cwd(), ...options });
      printOutput(formatCommandResult({ title: "Ticiou skillhub whoami", messages: result.messages }));
    });
  skillhub
    .command("logout")
    .description("Remove the saved SkillHub token for a registry")
    .option("--registry <url>", "SkillHub registry URL")
    .action(async (options: { registry?: string }) => {
      const result = await logoutSkillHub({ cwd: process.cwd(), registry: options.registry });
      printOutput(formatCommandResult({ title: "Ticiou skillhub logout", messages: result.messages }));
    });

  const skill = program.command("skill").description("Manage SkillHub skills for the active profile");
  skill
    .command("list")
    .description("List remote SkillHub skills")
    .option("-u, --user <user>", "Ticiou profile id")
    .option("--remote", "List remote SkillHub skills", true)
    .option("--registry <url>", "SkillHub registry URL")
    .option("--token <token>", "SkillHub token for this command only")
    .option("--ask-token", "Prompt for a SkillHub token when needed")
    .option("--anonymous", "Disable saved/env token lookup")
    .option("--namespace <namespace>", "Filter by namespace")
    .option("--owner <owner>", "Filter by owner, e.g. self")
    .option("--label <label>", "Filter by label")
    .option("-q, --query <query>", "Search query")
    .action(async (options: { user?: string; remote?: boolean; registry?: string; token?: string; askToken?: boolean; anonymous?: boolean; namespace?: string; owner?: string; label?: string; query?: string }) => {
      const result = await listSkills({ cwd: process.cwd(), q: options.query, ...options });
      printOutput(formatCommandResult({ title: "Ticiou skill list", messages: result.messages }));
    });
  skill
    .command("add")
    .description("Add a SkillHub skill or selector to the active profile")
    .argument("[skill]", "Skill reference: <namespace>/<slug>")
    .option("-u, --user <user>", "Ticiou profile id")
    .option("--registry <url>", "SkillHub registry URL")
    .option("--token <token>", "SkillHub token for this command only")
    .option("--ask-token", "Prompt for a SkillHub token when needed")
    .option("--anonymous", "Disable saved/env token lookup")
    .option("--namespace <namespace>", "Selector namespace")
    .option("--owner <owner>", "Selector owner, e.g. self")
    .option("--owner-id <ownerId>", "Selector owner id")
    .option("--label <label>", "Selector label")
    .option("--version <version>", "Pin a skill version")
    .action(async (skillRef: string | undefined, options: { user?: string; registry?: string; token?: string; askToken?: boolean; anonymous?: boolean; namespace?: string; owner?: string; ownerId?: string; label?: string; version?: string }) => {
      const result = await addSkill({ cwd: process.cwd(), skillRef, ...options });
      printOutput(formatCommandResult({ title: "Ticiou skill add", messages: result.messages, nextAction: "ticiou skill sync" }));
    });
  skill
    .command("remove")
    .description("Remove a SkillHub skill selection from the active profile")
    .argument("<skill>", "Skill reference: <namespace>/<slug>")
    .option("-u, --user <user>", "Ticiou profile id")
    .option("--registry <url>", "SkillHub registry URL")
    .action(async (skillRef: string, options: { user?: string; registry?: string }) => {
      const result = await removeSkill({ cwd: process.cwd(), skillRef, ...options });
      printOutput(formatCommandResult({ title: "Ticiou skill remove", messages: result.messages }));
    });
  skill
    .command("sync")
    .description("Synchronize enabled SkillHub skills")
    .option("-u, --user <user>", "Ticiou profile id")
    .option("--registry <url>", "SkillHub registry URL")
    .option("--token <token>", "SkillHub token for this command only")
    .option("--ask-token", "Prompt for a SkillHub token when needed")
    .option("--anonymous", "Disable saved/env token lookup")
    .option("--frozen", "Check without writing lock or rendered files")
    .action(async (options: { user?: string; registry?: string; token?: string; askToken?: boolean; anonymous?: boolean; frozen?: boolean }) => {
      const result = await syncSkills({ cwd: process.cwd(), ...options });
      printOutput(formatCommandResult({ title: "Ticiou skill sync", messages: result.messages }));
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

async function selectSkillsInteractively(context: SkillSelectorContext): Promise<DiscoverItem[]> {
  if (context.items.length === 0) {
    console.log(`No SkillHub skills found for ${context.user}.`);
    return [];
  }

  console.log(`Signed in as ${context.user}`);
  console.log("");
  console.log("Select SkillHub skills to enable for this project:");
  context.items.forEach((item, index) => {
    const version = item.publishedVersion === undefined ? "" : `@${item.publishedVersion}`;
    const summary = item.summary === undefined || item.summary.length === 0 ? "" : ` - ${item.summary}`;
    console.log(`  ${index + 1}. ${item.namespace}/${item.slug}${version}${summary}`);
  });
  console.log("");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("Enable which skills? [all] ")).trim().toLowerCase();
    if (answer.length === 0 || answer === "all") {
      return context.items;
    }
    if (answer === "none") {
      return [];
    }

    const indexes = answer
      .split(",")
      .map((part) => Number.parseInt(part.trim(), 10))
      .filter((value) => Number.isInteger(value) && value >= 1 && value <= context.items.length);
    const uniqueIndexes = [...new Set(indexes)];
    return uniqueIndexes.map((index) => context.items[index - 1]).filter((item): item is DiscoverItem => item !== undefined);
  } finally {
    rl.close();
  }
}

function printOutput(output: string): void {
  console.log(output);
}
