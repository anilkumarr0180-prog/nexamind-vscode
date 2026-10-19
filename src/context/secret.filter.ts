/**
 * Secret & Sensitive File Filter
 * Prevents accidental inclusion of sensitive files, credentials, private keys,
 * or build artifacts in the workspace context sent to NexaMind Agent.
 */

const BLOCKED_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".cache",
  ".gemini",
  ".vscode",
  ".idea",
  "coverage",
]);

const SENSITIVE_FILENAME_PATTERNS = [
  /^\.env(\..+)?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\..+)?$/i,
  /\.(pem|key|pkcs12|pfx|p12|cer|crt)$/i,
  /secret/i,
  /credential/i,
  /service-account/i,
  /token/i,
  /\.keystore$/i,
];

const PRIVATE_KEY_HEADER = /-----BEGIN [A-Z0-9_-]+ PRIVATE KEY-----/i;

/**
 * Checks whether a given relative or absolute file path must be excluded from agent context.
 */
export function isPathExcluded(filePath: string): boolean {
  if (!filePath) {
    return true;
  }

  // Normalize path separators
  const normalized = filePath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);

  // 1. Check directory segments
  for (const seg of segments) {
    if (BLOCKED_DIRECTORY_NAMES.has(seg.toLowerCase())) {
      return true;
    }
  }

  // 2. Check filename against sensitive patterns
  const fileName = segments[segments.length - 1] || "";
  for (const pattern of SENSITIVE_FILENAME_PATTERNS) {
    if (pattern.test(fileName)) {
      return true;
    }
  }

  return false;
}

/**
 * Checks whether the file content contains obvious sensitive markers (such as private keys).
 */
export function containsSensitiveData(content: string): boolean {
  if (!content) {
    return false;
  }
  return PRIVATE_KEY_HEADER.test(content);
}

/**
 * Maximum single file size allowed for inclusion in context (100 KB).
 */
export const MAX_FILE_SIZE_BYTES = 100 * 1024;
