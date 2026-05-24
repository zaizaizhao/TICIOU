let override: string | undefined;

export function setPythonCommandOverride(value: string | undefined): void {
  override = value;
}

export function getPythonCommand(platform: NodeJS.Platform = process.platform): string {
  if (override !== undefined) {
    return override;
  }
  return platform === "win32" ? "python" : "python3";
}

export function getPowershellPythonCommand(): string {
  return "py -3";
}

const PYTHON_CMD_TOKEN = /\{\{PYTHON_CMD\}\}/g;
const PYTHON_WIN_CMD_TOKEN = /\{\{PYTHON_WIN_CMD\}\}/g;

export function replacePythonCommandLiterals(content: string): string {
  const target = getPythonCommand();
  if (target === "python3") {
    return content;
  }
  return content
    .split("\n")
    .map((line) => (line.startsWith("#!") ? line : line.replaceAll("python3", target)))
    .join("\n");
}

export function resolvePythonPlaceholders(content: string): string {
  const replaced = content
    .replace(PYTHON_CMD_TOKEN, getPythonCommand())
    .replace(PYTHON_WIN_CMD_TOKEN, getPowershellPythonCommand());
  return replacePythonCommandLiterals(replaced);
}
