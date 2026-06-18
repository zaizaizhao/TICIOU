import { describe, expect, test } from "vitest";

import { main } from "../src/cli/index.js";
import { formatBrandBanner, formatCommandResult, formatError, formatStatus } from "../src/cli/output.js";
import { createProgram } from "../src/cli/program.js";

describe("CLI output formatting", () => {
  test("formats successful command results with a title, divider, status dots, and next action", () => {
    const output = formatCommandResult({
      title: "Ticiou use",
      messages: ["Initialized Ticiou project at /tmp/service-a", "Activated Ticiou profile yanan.zhao"],
      nextAction: "ticiou doctor",
      color: false,
    });

    expect(output).toBe(
      [
        "Ticiou use",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "● Initialized Ticiou project at /tmp/service-a",
        "● Activated Ticiou profile yanan.zhao",
        "",
        "Done",
        "Next: ticiou doctor",
      ].join("\n"),
    );
  });

  test("formats status as a readable B-style summary", () => {
    const output = formatStatus(
      {
        targetRoot: "/tmp/service-a",
        currentProfile: "yanan.zhao",
        enabledPlatforms: ["claude", "copilot"],
        generatedFileCount: 18,
      },
      { color: false },
    );

    expect(output).toBe(
      [
        "Ticiou status",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "● target /tmp/service-a",
        "● profile yanan.zhao",
        "● platforms claude, copilot",
        "● generated files 18",
        "",
        "Done",
        "Next: ticiou doctor",
      ].join("\n"),
    );
  });

  test("uses warning and failure states when command messages describe problems", () => {
    const output = formatCommandResult({
      title: "Ticiou doctor",
      messages: [
        "Claude adapter installed",
        "Missing generated file: .claude/skills/ticiou-missing/SKILL.md",
        "No active profile. Run ticiou use -u <user>.",
      ],
      ok: false,
      color: false,
    });

    expect(output).toBe(
      [
        "Ticiou doctor",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "● Claude adapter installed",
        "× Missing generated file: .claude/skills/ticiou-missing/SKILL.md",
        "! No active profile. Run ticiou use -u <user>.",
        "",
        "Needs attention",
      ].join("\n"),
    );
  });

  test("uses structured message tones instead of guessing from text", () => {
    const output = formatCommandResult({
      title: "Ticiou use",
      messages: [
        { text: "SkillHub token user token.user differs from Ticiou profile yanan.zhao", tone: "warning" },
        { text: "SkillHub skill global/private-skill is forbidden for the current token", tone: "warning" },
        { text: "Activated Ticiou profile yanan.zhao", tone: "success" },
      ],
      color: false,
    });

    expect(output).toContain("! SkillHub token user token.user differs from Ticiou profile yanan.zhao");
    expect(output).toContain("! SkillHub skill global/private-skill is forbidden for the current token");
    expect(output).toContain("● Activated Ticiou profile yanan.zhao");
  });

  test("applies ANSI colors when enabled and omits them when disabled", () => {
    const colored = formatCommandResult({
      title: "Ticiou init",
      messages: ["Initialized Ticiou project at /tmp/service-a"],
      color: true,
    });
    const plain = formatCommandResult({
      title: "Ticiou init",
      messages: ["Initialized Ticiou project at /tmp/service-a"],
      color: false,
    });

    expect(colored).toContain("\u001B[");
    expect(plain).not.toContain("\u001B[");
  });

  test("formats errors with a clear colored label", () => {
    const output = formatError("Unsupported platform: vim", { color: false });

    expect(output).toBe("Error: Unsupported platform: vim");
  });

  test("formats root help with the TICIOU display banner and command hints", () => {
    const output = createProgram().helpInformation();

    expect(output).toContain(formatBrandBanner({ color: false }));
    expect(output).toContain("┌───────────────────────────────────────────────┐");
    expect(output).toContain("└───────────────────────────────────────────────┘");
    expect(output).toContain("████████╗");
    expect(output).toContain("██╗   ██╗");
    expect(output).toContain("TICIOU");
    expect(output).toContain("提效");
    expect(output).not.toContain("TICIOI");
    expect(output).not.toContain("Compile shared and user AI profiles.");
    expect(output).toContain("Commands");
    expect(output).toContain("init              Initialize Ticiou project state");
    expect(output).toContain("install claude    Install Claude adapter");
    expect(output).toContain("setup            Initialize, install, and activate SkillHub skills");
    expect(output).toContain("use -u <user>     Activate a user profile");
    expect(output).toContain("doctor            Validate generated resources");
  });

  test("keeps root help banner inside box-drawing borders", () => {
    const output = createProgram().helpInformation();
    const bannerLines = output.split("\n").filter((line) => line.startsWith("┌") || line.startsWith("│") || line.startsWith("└"));

    expect(bannerLines).toHaveLength(12);
    expect(new Set(bannerLines.map(terminalDisplayWidth))).toEqual(new Set([49]));
    expect(bannerLines[0]).toBe("┌───────────────────────────────────────────────┐");
    expect(bannerLines.at(-1)).toBe("└───────────────────────────────────────────────┘");
    expect(bannerLines.slice(1, -1).every((line) => line.startsWith("│") && line.endsWith("│"))).toBe(true);
  });

  test("shows root help when invoked without a command", async () => {
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => {
      output.push(String(value ?? ""));
    };

    try {
      await main(["node", "ticiou"]);
    } finally {
      console.log = originalLog;
    }

    expect(output.join("")).toContain("TICIOU  提效");
    expect(output.join("")).toContain("setup            Initialize, install, and activate SkillHub skills");
    expect(output.join("")).toContain("use -u <user>     Activate a user profile");
  });
});

function terminalDisplayWidth(value: string): number {
  return Array.from(value).reduce((width, character) => {
    if (/[\u4E00-\u9FFF]/u.test(character)) {
      return width + 2;
    }
    return width + 1;
  }, 0);
}
