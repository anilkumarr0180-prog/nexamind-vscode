import * as vscode from "vscode";

export const CONFIG_SECTION = "nexamind";

export const DEFAULT_PRODUCTION_API_URL = "https://nexamind-backend-a19d.onrender.com/api/v1";
export const DEFAULT_PRODUCTION_WEB_URL = "https://nexamind-frontend.vercel.app";

export interface ExtensionConfig {
  apiUrl: string;
  webUrl: string;
  maxContextChars: number;
  includeDiagnostics: boolean;
}

/**
 * Normalizes an API base URL so that trailing slashes are removed and /api/v1 is properly anchored.
 */
export function normalizeApiUrl(rawUrl?: string): string {
  if (!rawUrl || !rawUrl.trim()) {
    return DEFAULT_PRODUCTION_API_URL;
  }
  let clean = rawUrl.trim().replace(/\/+$/, "");
  if (!clean.endsWith("/api/v1")) {
    if (clean.endsWith("/api")) {
      clean = `${clean}/v1`;
    } else {
      clean = `${clean}/api/v1`;
    }
  }
  return clean;
}

/**
 * Normalizes a frontend web app URL by trimming trailing slashes.
 */
export function normalizeWebUrl(rawUrl?: string): string {
  if (!rawUrl || !rawUrl.trim()) {
    return DEFAULT_PRODUCTION_WEB_URL;
  }
  return rawUrl.trim().replace(/\/+$/, "");
}

/**
 * Validates whether a given URL is a syntactically valid HTTP/HTTPS URL.
 */
export function isValidApiUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Reads the latest configuration values from VS Code settings.
 */
export function getConfig(): ExtensionConfig {
  const wsConfig = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const rawUrl = wsConfig.get<string>("apiUrl", DEFAULT_PRODUCTION_API_URL);
  const rawWebUrl = wsConfig.get<string>("webUrl", DEFAULT_PRODUCTION_WEB_URL);
  const maxChars = wsConfig.get<number>("maxContextChars", 24000);
  const includeDiag = wsConfig.get<boolean>("includeDiagnostics", true);

  return {
    apiUrl: normalizeApiUrl(rawUrl),
    webUrl: normalizeWebUrl(rawWebUrl),
    maxContextChars: Math.max(1000, Math.min(maxChars, 30000)),
    includeDiagnostics: Boolean(includeDiag),
  };
}
