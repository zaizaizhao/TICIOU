export { doctorProject } from "./diagnostics/doctor.js";
export { getStatus } from "./diagnostics/status.js";
export { installPlatform } from "./platform/install.js";
export { clearResources } from "./profile/clear.js";
export { useProfile } from "./profile/use.js";
export { initProject } from "./project/init.js";
export { setupProject } from "./project/setup.js";
export type {
  ClearResourcesOptions,
  ClearScope,
  CommandOptions,
  CommandResult,
  DoctorResult,
  InstallPlatformOptions,
  SetupProjectOptions,
  StatusResult,
  UseProfileOptions,
} from "./types.js";
