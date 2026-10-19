import assert from "node:assert";
import {
  normalizeApiUrl,
  normalizeWebUrl,
  isValidApiUrl,
  DEFAULT_PRODUCTION_API_URL,
  DEFAULT_PRODUCTION_WEB_URL,
} from "../src/config";

export function runConfigTests(): void {
  console.log("[Test Suite] Config & URL Normalization");

  // 1. Defaults fallback to production
  assert.strictEqual(DEFAULT_PRODUCTION_API_URL, "https://nexamind-backend-a19d.onrender.com/api/v1");
  assert.strictEqual(DEFAULT_PRODUCTION_WEB_URL, "https://nexamind-frontend.vercel.app");
  assert.strictEqual(normalizeApiUrl(""), DEFAULT_PRODUCTION_API_URL);
  assert.strictEqual(normalizeApiUrl(undefined), DEFAULT_PRODUCTION_API_URL);
  assert.strictEqual(normalizeApiUrl("   "), DEFAULT_PRODUCTION_API_URL);
  assert.strictEqual(normalizeWebUrl(""), DEFAULT_PRODUCTION_WEB_URL);
  assert.strictEqual(normalizeWebUrl(undefined), DEFAULT_PRODUCTION_WEB_URL);
  assert.strictEqual(normalizeWebUrl("   "), DEFAULT_PRODUCTION_WEB_URL);

  // 2. Production Render Backend URL variations & /api/v1 normalization
  assert.strictEqual(
    normalizeApiUrl("https://nexamind-backend-a19d.onrender.com"),
    "https://nexamind-backend-a19d.onrender.com/api/v1",
  );
  assert.strictEqual(
    normalizeApiUrl("https://nexamind-backend-a19d.onrender.com/"),
    "https://nexamind-backend-a19d.onrender.com/api/v1",
  );
  assert.strictEqual(
    normalizeApiUrl("https://nexamind-backend-a19d.onrender.com/api"),
    "https://nexamind-backend-a19d.onrender.com/api/v1",
  );
  assert.strictEqual(
    normalizeApiUrl("https://nexamind-backend-a19d.onrender.com/api/"),
    "https://nexamind-backend-a19d.onrender.com/api/v1",
  );
  assert.strictEqual(
    normalizeApiUrl("https://nexamind-backend-a19d.onrender.com/api/v1"),
    "https://nexamind-backend-a19d.onrender.com/api/v1",
  );
  assert.strictEqual(
    normalizeApiUrl("https://nexamind-backend-a19d.onrender.com/api/v1/"),
    "https://nexamind-backend-a19d.onrender.com/api/v1",
  );

  // 3. Prevent duplicate /api/v1 segments
  const normalizedRender = normalizeApiUrl("https://nexamind-backend-a19d.onrender.com/api/v1");
  assert.strictEqual(normalizedRender.includes("/api/v1/api/v1"), false);
  assert.strictEqual(normalizeApiUrl(normalizedRender), "https://nexamind-backend-a19d.onrender.com/api/v1");

  // 4. Production Vercel Frontend URL variations
  assert.strictEqual(
    normalizeWebUrl("https://nexamind-frontend.vercel.app"),
    "https://nexamind-frontend.vercel.app",
  );
  assert.strictEqual(
    normalizeWebUrl("https://nexamind-frontend.vercel.app/"),
    "https://nexamind-frontend.vercel.app",
  );
  assert.strictEqual(
    normalizeWebUrl("https://nexamind-frontend.vercel.app///"),
    "https://nexamind-frontend.vercel.app",
  );

  // 5. Browser PKCE URL construction verification
  const webBase = normalizeWebUrl(DEFAULT_PRODUCTION_WEB_URL);
  const redirectUri = "vscode://nexamind.nexamind-vscode/auth";
  const params = new URLSearchParams({
    code_challenge: "test_challenge",
    code_challenge_method: "S256",
    state: "test_state",
    redirect_uri: redirectUri,
  });
  const constructedAuthUrl = `${webBase}/auth/vscode?${params.toString()}`;
  assert.strictEqual(
    constructedAuthUrl,
    "https://nexamind-frontend.vercel.app/auth/vscode?code_challenge=test_challenge&code_challenge_method=S256&state=test_state&redirect_uri=vscode%3A%2F%2Fnexamind.nexamind-vscode%2Fauth",
  );

  // 6. API Endpoint URL construction verification
  const apiBase = normalizeApiUrl(DEFAULT_PRODUCTION_API_URL);
  assert.strictEqual(`${apiBase}/auth/vscode/exchange`, "https://nexamind-backend-a19d.onrender.com/api/v1/auth/vscode/exchange");
  assert.strictEqual(`${apiBase}/agent/stream`, "https://nexamind-backend-a19d.onrender.com/api/v1/agent/stream");
  assert.strictEqual(`${apiBase}/auth/refresh`, "https://nexamind-backend-a19d.onrender.com/api/v1/auth/refresh");
  assert.strictEqual(`${apiBase}/auth/me`, "https://nexamind-backend-a19d.onrender.com/api/v1/auth/me");

  // 7. Validation
  assert.strictEqual(isValidApiUrl(DEFAULT_PRODUCTION_API_URL), true);
  assert.strictEqual(isValidApiUrl(DEFAULT_PRODUCTION_WEB_URL), true);
  assert.strictEqual(isValidApiUrl("http://localhost:5001/api/v1"), true);
  assert.strictEqual(isValidApiUrl("not-a-url"), false);
  assert.strictEqual(isValidApiUrl("ftp://example.com"), false);

  console.log("  ✓ Config and URL normalization tests passed.");
}
