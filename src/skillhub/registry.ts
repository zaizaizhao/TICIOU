export const DEFAULT_SKILLHUB_REGISTRY = "http://localhost:3000";

export function normalizeRegistry(rawRegistry: string | undefined): string {
  const value = rawRegistry?.trim() ?? DEFAULT_SKILLHUB_REGISTRY;
  if (value.length === 0) {
    return DEFAULT_SKILLHUB_REGISTRY;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid SkillHub registry URL: ${value}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Invalid SkillHub registry protocol: ${url.protocol}`);
  }

  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}
