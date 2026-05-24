import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const copyJobs = [
  {
    source: join(packageRoot, "src", "templates"),
    destination: join(packageRoot, "dist", "templates"),
  },
  {
    source: join(packageRoot, "profiles"),
    destination: join(packageRoot, "dist", "profiles"),
  },
];

for (const job of copyJobs) {
  if (existsSync(job.destination)) {
    rmSync(job.destination, { recursive: true, force: true });
  }
  mkdirSync(dirname(job.destination), { recursive: true });
  copyTemplates(job.source, job.destination);
}

function copyTemplates(currentSource, currentDestination) {
  mkdirSync(currentDestination, { recursive: true });

  for (const entry of readdirSync(currentSource, { withFileTypes: true })) {
    const sourcePath = join(currentSource, entry.name);
    const destinationPath = join(currentDestination, entry.name);

    if (entry.isDirectory()) {
      copyTemplates(sourcePath, destinationPath);
    } else if (entry.isFile() && !entry.name.endsWith(".ts")) {
      cpSync(sourcePath, destinationPath);
    }
  }
}
