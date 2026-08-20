export {
  cleanStaleObsidianLocks,
  discoveryLockDirectory,
  listLiveIdeLocks,
  removeLockFile,
  writeLockFile,
  type DiscoveredIdeLock,
  type LockFileData,
} from "./ide/discovery-lock";

export { claudeIdeDirectory as claudeCompatibilityLockDirectory } from "./agent-integrations/claude-code/paths";
