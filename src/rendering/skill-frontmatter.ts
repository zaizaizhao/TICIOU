const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n?/;

export function normalizeSkillFrontmatterName(content: string, name: string): string {
  return upsertMarkdownFrontmatter(content, { name });
}

export function normalizeCommandFrontmatter(
  content: string,
  fields: { name: string; description: string },
): string {
  return upsertMarkdownFrontmatter(content, {
    name: fields.name,
    description: fields.description,
    "disable-model-invocation": "true",
  });
}

function upsertMarkdownFrontmatter(content: string, fields: Record<string, string>): string {
  const normalized = content.replace(/\r\n/g, "\n");
  const match = normalized.match(FRONTMATTER_PATTERN);

  if (match === null) {
    return `---\n${serializeFields(fields)}\n---\n\n${normalized}`;
  }

  const body = normalized.slice(match[0].length);
  const frontmatter = upsertFields(match[1] ?? "", fields);
  return `---\n${frontmatter}\n---\n${body}`;
}

function upsertFields(frontmatter: string, fields: Record<string, string>): string {
  const lines = frontmatter.split("\n");
  const remainingFields = new Map(Object.entries(fields));

  const nextLines = lines.map((line) => {
    for (const [key, value] of remainingFields) {
      if (new RegExp(`^${escapeRegExp(key)}:\\s*`).test(line)) {
        remainingFields.delete(key);
        return `${key}: ${value}`;
      }
    }
    return line;
  });

  if (remainingFields.size > 0) {
    return [...serializeFields(Object.fromEntries(remainingFields)).split("\n"), ...nextLines].join("\n");
  }

  return nextLines.join("\n");
}

function serializeFields(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
