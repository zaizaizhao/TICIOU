import { describe, expect, test } from "vitest";

import { formatCommandResult, formatError, formatStatus } from "../src/cli/output.js";

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
});
