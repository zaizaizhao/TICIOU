import { join } from "node:path";

import { PLATFORMS } from "../domain/types.js";
import { copyDirectoryContentsIfMissing } from "../infra/fs.js";
import { resolveRuntimeTemplateDirectory } from "../infra/template-paths.js";

export async function ensureProjectTemplates(targetRoot: string): Promise<void> {
  await Promise.all(
    PLATFORMS.map((platform) =>
      copyDirectoryContentsIfMissing(resolveRuntimeTemplateDirectory(platform), join(targetRoot, ".ticiou/templates", platform)),
    ),
  );
}
