import path from "node:path";

export const MV_AIDE_VAULT_STORAGE_FOLDER = "mv-aide";

export const VIM_VAULT_CONFIG_PATH = `${MV_AIDE_VAULT_STORAGE_FOLDER}/vim/.vimrc`;

export const EXTERNAL_FILE_MIRROR_FOLDER = `${MV_AIDE_VAULT_STORAGE_FOLDER}/external-files/mirror`;

export const EXTERNAL_PDF_EPHEMERAL_FOLDER = `${MV_AIDE_VAULT_STORAGE_FOLDER}/external-files/pdf-ephemeral`;

export const EXTERNAL_FILE_HOST_IDS_FOLDER = `${MV_AIDE_VAULT_STORAGE_FOLDER}/external-files/hosts`;

export const LLM_HISTORY_FOLDER = `${MV_AIDE_VAULT_STORAGE_FOLDER}/llm-history`;

export const LLM_HISTORY_LATEST_PATH = `${LLM_HISTORY_FOLDER}/latest.md`;

export function mvAideVaultRoot(vaultRoot: string): string {
  return path.join(vaultRoot, MV_AIDE_VAULT_STORAGE_FOLDER);
}

export function vimVaultConfigPath(vaultRoot: string): string {
  return path.join(vaultRoot, ...VIM_VAULT_CONFIG_PATH.split("/"));
}

export function externalFileMirrorDirectory(vaultRoot: string): string {
  return path.join(vaultRoot, ...EXTERNAL_FILE_MIRROR_FOLDER.split("/"));
}

export function externalFileHostIdsDirectory(vaultRoot: string): string {
  return path.join(vaultRoot, ...EXTERNAL_FILE_HOST_IDS_FOLDER.split("/"));
}

export function llmHistoryDirectory(vaultRoot: string): string {
  return path.join(vaultRoot, ...LLM_HISTORY_FOLDER.split("/"));
}
