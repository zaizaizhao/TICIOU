import { Chalk } from "chalk";

import type { StatusResult } from "../app/commands/types.js";

type MessageTone = "success" | "warning" | "error";

export interface OutputOptions {
  color?: boolean;
}

export interface CommandOutputOptions extends OutputOptions {
  title: string;
  messages: string[];
  ok?: boolean;
  nextAction?: string;
}

const DIVIDER = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━";

export function formatCommandResult(options: CommandOutputOptions): string {
  const color = createColor(options.color);
  const lines = [color.heading(options.title), color.muted(DIVIDER)];

  for (const message of options.messages) {
    lines.push(formatMessage(message, color));
  }

  lines.push("");
  lines.push(options.ok === false ? color.warningText("Needs attention") : color.successText("Done"));

  if (options.nextAction !== undefined) {
    lines.push(`${color.muted("Next:")} ${color.command(options.nextAction)}`);
  }

  return lines.join("\n");
}

export function formatStatus(status: StatusResult, options: OutputOptions = {}): string {
  const color = createColor(options.color);
  const platforms = status.enabledPlatforms.length === 0 ? "(none)" : status.enabledPlatforms.join(", ");
  const profile = status.currentProfile ?? "(none)";
  const nextAction = status.enabledPlatforms.length === 0
    ? "ticiou install claude"
    : status.currentProfile === undefined
      ? "ticiou use -u <user>"
      : "ticiou doctor";

  return [
    color.heading("Ticiou status"),
    color.muted(DIVIDER),
    formatKeyValue("target", status.targetRoot, color),
    formatKeyValue("profile", profile, color),
    formatKeyValue("platforms", platforms, color),
    formatKeyValue("generated files", String(status.generatedFileCount), color),
    "",
    color.successText("Done"),
    `${color.muted("Next:")} ${color.command(nextAction)}`,
  ].join("\n");
}

export function formatError(message: string, options: OutputOptions = {}): string {
  const color = createColor(options.color);
  return `${color.errorText("Error:")} ${message}`;
}

export function formatBrandBanner(options: OutputOptions = {}): string {
  const color = createColor(options.color);

  return [
    color.brand("┌───────────────────────────────────────────────┐"),
    color.brand("│                                               │"),
    color.brand("│    ████████╗██╗ ██████╗██╗ ██████╗██╗   ██╗   │"),
    color.brand("│   ╚══██╔══╝██║██╔════╝██║██╔═══██╗██║   ██║   │"),
    color.brand("│      ██║   ██║██║     ██║██║   ██║██║   ██║   │"),
    color.brand("│      ██║   ██║██║     ██║██║   ██║██║   ██║   │"),
    color.brand("│      ██║   ██║╚██████╗██║╚██████╔╝╚██████╔╝   │"),
    color.brand("│       ╚═╝   ╚═╝ ╚═════╝╚═╝ ╚═════╝  ╚═════╝   │"),
    color.brand("│                                               │"),
    color.brand("│                   TICIOU  提效                │"),
    color.brand("│                                               │"),
    color.brand("└───────────────────────────────────────────────┘"),
  ].join("\n");
}

export function formatRootHelp(options: OutputOptions = {}): string {
  const color = createColor(options.color);

  return [
    formatBrandBanner(options),
    "",
    color.heading("Usage"),
    `  ${color.command("ticiou <command> [options]")}`,
    "",
    color.heading("Commands"),
    `  ${color.command("init")}              Initialize Ticiou project state`,
    `  ${color.command("install claude")}    Install Claude adapter`,
    `  ${color.command("install copilot")}   Install Copilot adapter`,
    `  ${color.command("setup -u <user>")}   Initialize, install, and activate`,
    `  ${color.command("use -u <user>")}     Activate a user profile`,
    `  ${color.command("status")}            Show active profile`,
    `  ${color.command("doctor")}            Validate generated resources`,
    `  ${color.command("clear user")}        Clear active user resources`,
    `  ${color.command("clear all")}         Clear all generated resources`,
    "",
    color.muted("Run ticiou <command> -h for command help."),
  ].join("\n");
}

function formatMessage(message: string, color: CliColor): string {
  const tone = classifyMessage(message);
  return `${color.symbol(symbolForTone(tone), tone)} ${color.message(message, tone)}`;
}

function formatKeyValue(key: string, value: string, color: CliColor): string {
  return `${color.symbol("●", "success")} ${color.key(key)} ${color.value(value)}`;
}

function classifyMessage(message: string): MessageTone {
  const lower = message.toLowerCase();
  if (
    lower.startsWith("missing ") ||
    lower.startsWith("duplicate ") ||
    lower.includes(" was not found ") ||
    lower.includes(" is not valid ") ||
    lower.includes(" does not ") ||
    lower.includes(" enabled but ")
  ) {
    return "error";
  }

  if (lower.startsWith("no active profile") || lower.startsWith("for copilot cloud agent")) {
    return "warning";
  }

  return "success";
}

function symbolForTone(tone: MessageTone): string {
  if (tone === "error") {
    return "×";
  }
  if (tone === "warning") {
    return "!";
  }
  return "●";
}

interface CliColor {
  brand(value: string): string;
  heading(value: string): string;
  muted(value: string): string;
  symbol(value: string, tone: MessageTone): string;
  message(value: string, tone: MessageTone): string;
  key(value: string): string;
  value(value: string): string;
  command(value: string): string;
  successText(value: string): string;
  warningText(value: string): string;
  errorText(value: string): string;
}

function createColor(enabled = shouldUseColor()): CliColor {
  const chalk = new Chalk({ level: enabled ? 1 : 0 });

  return {
    brand: chalk.greenBright,
    heading: chalk.blueBright.bold,
    muted: chalk.gray,
    symbol: (value, tone) => {
      if (tone === "error") {
        return chalk.red(value);
      }
      if (tone === "warning") {
        return chalk.yellow(value);
      }
      return chalk.green(value);
    },
    message: (value, tone) => {
      if (tone === "error") {
        return chalk.redBright(value);
      }
      if (tone === "warning") {
        return chalk.yellow(value);
      }
      return chalk.white(value);
    },
    key: chalk.gray,
    value: chalk.white,
    command: chalk.yellow,
    successText: chalk.green,
    warningText: chalk.yellow,
    errorText: chalk.red,
  };
}

function shouldUseColor(): boolean {
  return process.env.NO_COLOR === undefined && process.env.TERM !== "dumb" && process.stdout.isTTY === true;
}
