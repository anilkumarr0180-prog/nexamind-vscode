import assert from "node:assert";
import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { MockSecretStorage } from "./mocks/vscode";
import {
  AuthManager,
  NexaMindUriHandler,
  generatePkceVerifier,
  generatePkceChallenge,
  generateState,
  isJwtExpired,
  SECRET_KEY_TOKEN,
  SECRET_KEY_REFRESH_TOKEN,
} from "../src/auth/auth.manager";

/**
 * Creates a mock unsigned JWT with the given exp (timestamp in seconds).
 */
function createMockJwt(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ sub: "user-123", roles: ["USER"], exp: expSeconds }),
  ).toString("base64url");
  const signature = "mock-sig";
  return `${header}.${payload}.${signature}`;
}

export async function runAuthTests(): Promise<void> {
  console.log("[Test Suite] VS Code PKCE Authentication & Renewal");

  // Save original global fetch and env.openExternal
  const originalFetch = globalThis.fetch;
  const originalOpenExternal = vscode.env.openExternal;

  try {
    // -------------------------------------------------------------------------
    // Test 1: PKCE Cryptographic Parameters Generation
    // -------------------------------------------------------------------------
    console.log("  Testing PKCE generation (verifier, S256 challenge, state)...");
    const verifier = generatePkceVerifier();
    assert.strictEqual(verifier.length, 43, "Verifier must be 43 characters (32 bytes base64url)");
    assert.match(
      verifier,
      /^[A-Za-z0-9\-._~]+$/,
      "Verifier must strictly conform to RFC 7636 unreserved characters",
    );

    const challenge = generatePkceChallenge(verifier);
    const expectedChallenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    assert.strictEqual(challenge, expectedChallenge, "Challenge must be SHA-256 base64url of verifier");
    assert.match(challenge, /^[A-Za-z0-9\-_=]+$/, "Challenge must be valid base64url");

    const state = generateState();
    assert.strictEqual(state.length, 64, "State must be 64 hex characters (32 random bytes)");
    assert.match(state, /^[0-9a-fA-F]{64}$/, "State must be valid hex");

    // -------------------------------------------------------------------------
    // Test 2: JWT Expiration Detection
    // -------------------------------------------------------------------------
    console.log("  Testing JWT expiration & skew detection...");
    const nowSec = Math.floor(Date.now() / 1000);
    const unexpiredJwt = createMockJwt(nowSec + 3600); // 1 hour in future
    assert.strictEqual(isJwtExpired(unexpiredJwt), false, "1h future token must not be expired");

    const expiredJwt = createMockJwt(nowSec - 10); // 10s in past
    assert.strictEqual(isJwtExpired(expiredJwt), true, "Past token must be expired");

    const expiringJwt = createMockJwt(nowSec + 30); // 30s in future, threshold is 60s
    assert.strictEqual(isJwtExpired(expiringJwt, 60), true, "Token within 60s skew must be flagged expired");

    assert.strictEqual(isJwtExpired("malformed.token"), true, "Malformed token fails safe as expired");

    // -------------------------------------------------------------------------
    // Test 3: Session Type Differentiation
    // -------------------------------------------------------------------------
    console.log("  Testing session type differentiation (PKCE vs Legacy vs None)...");
    const mockSecrets = new MockSecretStorage();
    const authManager = new AuthManager(mockSecrets as unknown as vscode.SecretStorage);

    assert.strictEqual(await authManager.getSessionType(), "none");

    await mockSecrets.store(SECRET_KEY_TOKEN, unexpiredJwt);
    assert.strictEqual(await authManager.getSessionType(), "legacy", "Token without refresh must be legacy");

    await mockSecrets.store(SECRET_KEY_REFRESH_TOKEN, "refresh-12345");
    assert.strictEqual(await authManager.getSessionType(), "pkce", "Token with refresh must be pkce");

    await authManager.clearSecretsAndState();
    assert.strictEqual(await authManager.getSessionType(), "none");

    // -------------------------------------------------------------------------
    // Test 4: Browser-Based PKCE Login URL & External Opening
    // -------------------------------------------------------------------------
    console.log("  Testing browser login flow initiation...");
    let openedUrl: string | null = null;
    (vscode.env as any).openExternal = async (uri: any) => {
      openedUrl = uri.toString();
      return true;
    };

    const loginStarted = await authManager.loginWithBrowser();
    assert.strictEqual(loginStarted, true);
    assert.ok(openedUrl, "openExternal must be called with authorization URL");

    const parsedAuthUrl = new URL(openedUrl!);
    assert.strictEqual(parsedAuthUrl.pathname, "/auth/vscode");
    assert.ok(parsedAuthUrl.searchParams.get("code_challenge"), "Must contain code_challenge");
    assert.strictEqual(parsedAuthUrl.searchParams.get("code_challenge_method"), "S256");
    assert.ok(parsedAuthUrl.searchParams.get("state"), "Must contain state parameter");
    assert.strictEqual(
      parsedAuthUrl.searchParams.get("redirect_uri"),
      "vscode://nexamind.nexamind-vscode/auth",
      "Must contain derived callback URI",
    );

    const pendingState = parsedAuthUrl.searchParams.get("state")!;

    // -------------------------------------------------------------------------
    // Test 5: Callback URI Validation & Replay Prevention
    // -------------------------------------------------------------------------
    console.log("  Testing callback URI validation guardrails...");
    // 5a. Invalid scheme
    const invalidSchemeUri = vscode.Uri.parse("https://nexamind.nexamind-vscode/auth?code=c1&state=" + pendingState);
    assert.strictEqual(await authManager.handleUriCallback(invalidSchemeUri), false);

    // 5b. Invalid authority
    const invalidAuthorityUri = vscode.Uri.parse("vscode://evil.attacker/auth?code=c1&state=" + pendingState);
    assert.strictEqual(await authManager.handleUriCallback(invalidAuthorityUri), false);

    // 5c. Invalid path
    const invalidPathUri = vscode.Uri.parse("vscode://nexamind.nexamind-vscode/other?code=c1&state=" + pendingState);
    assert.strictEqual(await authManager.handleUriCallback(invalidPathUri), false);

    // 5d. Error parameter from provider
    const errorUri = vscode.Uri.parse("vscode://nexamind.nexamind-vscode/auth?error=access_denied");
    assert.strictEqual(await authManager.handleUriCallback(errorUri), false);

    // 5e. State mismatch (CSRF attempt)
    // Re-initiate flow
    await authManager.loginWithBrowser();
    const csrfTamperedUri = vscode.Uri.parse("vscode://nexamind.nexamind-vscode/auth?code=valid-code&state=wrong-state-12345");
    assert.strictEqual(await authManager.handleUriCallback(csrfTamperedUri), false);

    // -------------------------------------------------------------------------
    // Test 6: Code Exchange & SecretStorage Persistence
    // -------------------------------------------------------------------------
    console.log("  Testing code exchange and secret persistence...");
    await authManager.loginWithBrowser();
    const validState = new URL(openedUrl!).searchParams.get("state")!;

    let exchangePayload: any = null;
    (globalThis as any).fetch = async (url: string, init: any) => {
      if (url.endsWith("/auth/vscode/exchange")) {
        exchangePayload = JSON.parse(init.body);
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              user: {
                id: "user-789",
                email: "engineer@nexamind.ai",
                name: "Lead Engineer",
                roles: ["USER"],
              },
              accessToken: "new-access-jwt-token-999",
              refreshToken: "new-refresh-token-8888",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const validCallbackUri = vscode.Uri.parse(
      `vscode://nexamind.nexamind-vscode/auth?code=auth-code-123&state=${validState}`,
    );

    const handled = await authManager.handleUriCallback(validCallbackUri);
    assert.strictEqual(handled, true, "Valid callback must be accepted and exchanged");
    assert.strictEqual(exchangePayload.code, "auth-code-123");
    assert.ok(exchangePayload.codeVerifier, "codeVerifier must be sent in exchange body");

    // Check SecretStorage
    assert.strictEqual(await mockSecrets.get(SECRET_KEY_TOKEN), "new-access-jwt-token-999");
    assert.strictEqual(await mockSecrets.get(SECRET_KEY_REFRESH_TOKEN), "new-refresh-token-8888");
    assert.strictEqual(authManager.getCurrentUser()?.email, "engineer@nexamind.ai");

    // Replay attack prevention: calling again with same callback must fail
    const replayHandled = await authManager.handleUriCallback(validCallbackUri);
    assert.strictEqual(replayHandled, false, "Replayed callback must be rejected");

    // -------------------------------------------------------------------------
    // Test 7: In-Flight Promise Lock for Token Renewal
    // -------------------------------------------------------------------------
    console.log("  Testing in-flight Promise lock for token renewal...");
    let refreshCallCount = 0;
    (globalThis as any).fetch = async (url: string, init: any) => {
      if (url.endsWith("/auth/refresh")) {
        refreshCallCount++;
        // Simulate network delay
        await new Promise((r) => setTimeout(r, 50));
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              accessToken: "rotated-access-token-" + refreshCallCount,
              refreshToken: "rotated-refresh-token-" + refreshCallCount,
              user: { id: "user-789", email: "engineer@nexamind.ai", name: "Lead Engineer", roles: ["USER"] },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    };

    // Fire 3 simultaneous renewal calls
    const [t1, t2, t3] = await Promise.all([
      authManager.refreshSession(),
      authManager.refreshSession(),
      authManager.refreshSession(),
    ]);

    assert.strictEqual(refreshCallCount, 1, "Only 1 refresh HTTP request must be executed for concurrent calls");
    assert.strictEqual(t1, "rotated-access-token-1");
    assert.strictEqual(t2, "rotated-access-token-1");
    assert.strictEqual(t3, "rotated-access-token-1");
    assert.strictEqual(await mockSecrets.get(SECRET_KEY_TOKEN), "rotated-access-token-1");

    // -------------------------------------------------------------------------
    // Test 8: Cross-Window Synchronization
    // -------------------------------------------------------------------------
    console.log("  Testing cross-window SecretStorage synchronization...");
    // Simulate another window deleting credentials on logout
    mockSecrets.simulateExternalChange(SECRET_KEY_TOKEN, undefined);
    // Allow microtask to process
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(authManager.getCurrentUser(), null, "User cache must clear when token is deleted externally");

    // -------------------------------------------------------------------------
    // Test 9: Secure Logout & Remote Revocation
    // -------------------------------------------------------------------------
    console.log("  Testing secure logout and server revocation...");
    await mockSecrets.store(SECRET_KEY_TOKEN, "token-to-logout");
    await mockSecrets.store(SECRET_KEY_REFRESH_TOKEN, "refresh-to-revoke");

    let logoutPayload: any = null;
    (globalThis as any).fetch = async (url: string, init: any) => {
      if (url.endsWith("/auth/logout")) {
        logoutPayload = JSON.parse(init.body);
        return new Response(JSON.stringify({ success: true, message: "Logged out" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    };

    await authManager.logout();
    assert.strictEqual(logoutPayload.refreshToken, "refresh-to-revoke", "Refresh token must be sent to backend logout");
    assert.strictEqual(await mockSecrets.get(SECRET_KEY_TOKEN), undefined, "Access token must be deleted");
    assert.strictEqual(await mockSecrets.get(SECRET_KEY_REFRESH_TOKEN), undefined, "Refresh token must be deleted");
    assert.strictEqual(authManager.getCurrentUser(), null);

    // -------------------------------------------------------------------------
    // Test 10: Revocation & Failure Handling During Renewal
    // -------------------------------------------------------------------------
    console.log("  Testing revocation detection during renewal...");
    await mockSecrets.store(SECRET_KEY_TOKEN, "stale-access");
    await mockSecrets.store(SECRET_KEY_REFRESH_TOKEN, "revoked-refresh");

    (globalThis as any).fetch = async (url: string) => {
      if (url.endsWith("/auth/refresh")) {
        return new Response(
          JSON.stringify({
            success: false,
            error: { code: "REVOKED_TOKEN", message: "Token revoked" },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not found", { status: 404 });
    };

    const failedRenewal = await authManager.refreshSession();
    assert.strictEqual(failedRenewal, undefined);
    assert.strictEqual(await mockSecrets.get(SECRET_KEY_TOKEN), undefined, "Secrets must be purged on REVOKED_TOKEN");
    assert.strictEqual(await mockSecrets.get(SECRET_KEY_REFRESH_TOKEN), undefined);

    console.log("  ✓ All 10 VS Code PKCE authentication & renewal tests passed successfully.");
  } finally {
    globalThis.fetch = originalFetch;
    vscode.env.openExternal = originalOpenExternal;
  }
}
