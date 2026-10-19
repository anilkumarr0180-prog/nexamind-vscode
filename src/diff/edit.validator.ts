import * as path from "path";
import * as fs from "fs";
import { isPathExcluded } from "../context/secret.filter";
import type { EditChunk } from "./edit.types";

export interface PathValidationResult {
  valid: boolean;
  error?: string;
  normalizedPath?: string;
  canonicalPath?: string;
}

export interface ReplacementResult {
  success: boolean;
  proposedContent?: string;
  error?: string;
}

export interface CanonicalValidatorOptions {
  realpathSync?: (p: string) => string;
  existsSync?: (p: string) => boolean;
}

/**
 * Validates that the target path, when resolved through all filesystem symbolic links,
 * strictly remains inside the canonical workspace root.
 * Fails closed if canonical path resolution fails or cannot be confirmed.
 */
export function validateCanonicalPathBoundary(
  targetPath: string,
  workspaceRoot: string,
  options?: CanonicalValidatorOptions,
): PathValidationResult {
  if (!workspaceRoot || !workspaceRoot.trim()) {
    return {
      valid: false,
      error: "Workspace root directory must be specified for boundary validation.",
    };
  }

  const realpathFn = options?.realpathSync ?? fs.realpathSync;
  const existsFn = options?.existsSync ?? fs.existsSync;

  let canonicalWorkspaceRoot: string;
  try {
    canonicalWorkspaceRoot = realpathFn(workspaceRoot);
  } catch (err: unknown) {
    return {
      valid: false,
      error: `Failed to resolve canonical workspace root "${workspaceRoot}": ${
        err instanceof Error ? err.message : String(err)
      }. Failing closed.`,
    };
  }

  const fullTarget = path.resolve(workspaceRoot, targetPath);

  // Probe target or nearest existing ancestor directory
  let existingProbe = fullTarget;
  const unverifiedSegments: string[] = [];

  try {
    while (!existsFn(existingProbe)) {
      const parent = path.dirname(existingProbe);
      if (parent === existingProbe) {
        return {
          valid: false,
          error: `No existing ancestor directory found for "${targetPath}". Failing closed.`,
        };
      }
      unverifiedSegments.unshift(path.basename(existingProbe));
      existingProbe = parent;
    }
  } catch (err: unknown) {
    return {
      valid: false,
      error: `Filesystem probe failed for "${targetPath}": ${
        err instanceof Error ? err.message : String(err)
      }. Failing closed.`,
    };
  }

  let canonicalProbe: string;
  try {
    canonicalProbe = realpathFn(existingProbe);
  } catch (err: unknown) {
    return {
      valid: false,
      error: `Failed to resolve canonical path for "${existingProbe}": ${
        err instanceof Error ? err.message : String(err)
      }. Failing closed.`,
    };
  }

  // Re-append any not-yet-created segments
  const canonicalFullTarget =
    unverifiedSegments.length > 0
      ? path.resolve(canonicalProbe, ...unverifiedSegments)
      : canonicalProbe;

  // Check if canonical target is inside canonical workspace
  const rel = path.relative(canonicalWorkspaceRoot, canonicalFullTarget);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return {
      valid: false,
      error: `Security boundary violation: target path "${targetPath}" escapes the workspace boundary via symbolic link (${canonicalFullTarget}).`,
    };
  }

  // Check the resolved canonical path against sensitive file rules as well
  const canonicalRelFromWorkspace = path
    .relative(canonicalWorkspaceRoot, canonicalFullTarget)
    .replace(/\\/g, "/");

  if (
    isPathExcluded(canonicalRelFromWorkspace) ||
    isPathExcluded(canonicalFullTarget)
  ) {
    return {
      valid: false,
      error: `Modification of protected or sensitive file "${targetPath}" (canonical: "${canonicalRelFromWorkspace}") is prohibited.`,
    };
  }

  return {
    valid: true,
    normalizedPath: targetPath,
    canonicalPath: canonicalFullTarget,
  };
}

/**
 * Validates that a target file path is safely confined to the workspace,
 * does not target protected files, and does not escape through path traversal or symlinks.
 */
export function validateTargetFilePath(
  targetPath: string,
  workspaceRoot?: string,
  options?: CanonicalValidatorOptions,
): PathValidationResult {
  if (!targetPath || !targetPath.trim()) {
    return { valid: false, error: "Target file path cannot be empty." };
  }

  // Reject null bytes
  if (targetPath.includes("\0")) {
    return { valid: false, error: "Null byte detected in file path." };
  }

  const clean = targetPath.trim().replace(/\\/g, "/");

  // Reject absolute paths
  if (path.isAbsolute(clean) || clean.startsWith("/") || /^[a-zA-Z]:/.test(clean)) {
    return {
      valid: false,
      error: `Target path "${clean}" must be a relative path within the workspace.`,
    };
  }

  // Normalize and check for path traversal (e.g. ../../etc/passwd)
  const normalized = path.normalize(clean).replace(/\\/g, "/");
  if (
    normalized.startsWith("..") ||
    normalized === ".." ||
    normalized.includes("/../")
  ) {
    return {
      valid: false,
      error: `Path traversal detected in "${clean}". Edits must remain inside the workspace.`,
    };
  }

  // Check against security filter (e.g. .env, private keys, node_modules)
  if (isPathExcluded(normalized)) {
    return {
      valid: false,
      error: `Modification of protected or sensitive file "${normalized}" is prohibited.`,
    };
  }

  if (workspaceRoot) {
    // 1. Lexical boundary check
    const fullTarget = path.resolve(workspaceRoot, normalized);
    const rel = path.relative(workspaceRoot, fullTarget);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return {
        valid: false,
        error: `Target path "${clean}" resolves outside the workspace directory.`,
      };
    }

    // 2. Canonical filesystem symlink check (fail-closed)
    const canonicalCheck = validateCanonicalPathBoundary(
      normalized,
      workspaceRoot,
      options,
    );

    if (!canonicalCheck.valid) {
      return canonicalCheck;
    }

    return {
      valid: true,
      normalizedPath: normalized,
      canonicalPath: canonicalCheck.canonicalPath,
    };
  }

  return { valid: true, normalizedPath: normalized };
}

/**
 * Applies search and replace chunks sequentially to original file content.
 * Strictly verifies uniqueness and reports ambiguous matches (count > 1) or stale missing lines (count === 0).
 */
export function applyReplacementChunks(
  originalContent: string,
  chunks: EditChunk[],
  filePath: string,
): ReplacementResult {
  if (!chunks || chunks.length === 0) {
    return { success: false, error: `No edit chunks provided for "${filePath}".` };
  }

  // Detect CRLF in original content to preserve it
  const hasCrlf = originalContent.includes("\r\n");

  // Normalize to LF for matching
  let workingContent = originalContent.replace(/\r\n/g, "\n");

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const search = chunk.search.replace(/\r\n/g, "\n");
    const replace = chunk.replace.replace(/\r\n/g, "\n");

    if (!search && !workingContent) {
      // Empty search on empty file = file initialization
      workingContent = replace;
      continue;
    }

    // Count exact occurrences of the search block
    let occurrences = 0;
    let pos = 0;
    while ((pos = workingContent.indexOf(search, pos)) !== -1) {
      occurrences++;
      pos += search.length || 1;
    }

    if (occurrences === 0) {
      return {
        success: false,
        error: `Search block ${i + 1} not found in "${filePath}". The file may have changed or the target lines differ.`,
      };
    }

    if (occurrences > 1) {
      return {
        success: false,
        error: `Ambiguous match in "${filePath}" (chunk ${i + 1}): search block matches ${occurrences} locations. Target lines must match uniquely.`,
      };
    }

    // Exactly 1 occurrence: execute replacement
    const matchIndex = workingContent.indexOf(search);
    workingContent =
      workingContent.substring(0, matchIndex) +
      replace +
      workingContent.substring(matchIndex + search.length);
  }

  // Re-apply original CRLF if applicable
  const finalContent = hasCrlf
    ? workingContent.replace(/\n/g, "\r\n")
    : workingContent;

  return { success: true, proposedContent: finalContent };
}
