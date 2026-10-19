import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import dotenv from "dotenv";

// Load backend .env before importing any backend modules
dotenv.config({ path: path.resolve(__dirname, "../../backend/.env") });

export async function runBackendIntegrationTests(): Promise<void> {
  console.log("\n[Test Suite] Real Backend & Extension Client Integration");

  // Dynamically import backend after env is loaded
  const { default: app } = await import("../../backend/src/app.js");
  const { connectDatabase, disconnectDatabase } = await import("../../backend/src/config/database.js");
  const { User } = await import("../../backend/src/modules/users/user.model.js");
  const { TokenBalance } = await import("../../backend/src/modules/tokens/token.model.js");
  const authService = await import("../../backend/src/modules/auth/auth.service.js");
  const {
    AgentService,
    agentService,
    setAgentService,
    AGENT_STATUSES,
    ToolRegistry,
  } = await import("../../backend/src/modules/agent/index.js");
  const { NexaMindClient } = await import("../src/client/nexamind.client");
  const { AuthManager } = await import("../src/auth/auth.manager");

  class MockStreamProvider {
    public readonly name = "mock_vscode_provider";
    async generateChatResponse() {
      return {
        content: "This is a detailed code explanation generated for the VS Code extension.",
        provider: "mock",
        model: "mock-model",
        usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 },
      };
    }
  }

  await connectDatabase();

  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as { port: number };
  const testApiUrl = `http://127.0.0.1:${address.port}/api/v1`;

  // Create test user and token
  const testEmail = `vscode_test_${Date.now()}@nexamind.test`;
  const registerResult = await authService.register({
    email: testEmail,
    password: "Password123!",
    name: "VSCode Test User",
  });
  const token = registerResult.accessToken;
  const userId = registerResult.user.id;

  // Ensure credit balance
  await TokenBalance.findOneAndUpdate(
    { userId },
    { $set: { balance: 25 } },
    { upsert: true },
  );

  // Set mock agent service to isolate AI calls
  const testRegistry = new ToolRegistry();
  const testProvider = new MockStreamProvider();
  const testAgentService = new AgentService({
    provider: testProvider as any,
    registry: testRegistry,
  });
  setAgentService(testAgentService);

  // Configure extension AuthManager with mock secret storage
  const inMemorySecrets: Record<string, string> = {
    "nexamind.jwt_access_token": token,
  };
  const mockSecretStorage: any = {
    get: async (k: string) => inMemorySecrets[k],
    store: async (k: string, v: string) => { inMemorySecrets[k] = v; },
    delete: async (k: string) => { delete inMemorySecrets[k]; },
  };

  const authManager = new AuthManager(mockSecretStorage);

  // Configure extension client
  const client = new NexaMindClient(authManager);

  // Point config to testApiUrl dynamically via test mock
  const { workspace } = await import("./mocks/vscode");
  (workspace as any).getConfiguration = () => ({
    get: (key: string, defaultValue: any) => {
      if (key === "apiUrl") return testApiUrl;
      return defaultValue;
    },
  });

  try {
    // 1. Verify session validation against real backend /api/v1/auth/me
    const session = await authManager.validateSession();
    assert.strictEqual(session.valid, true);
    assert.strictEqual(session.user?.email, testEmail);
    console.log("  ✓ Session validation against /api/v1/auth/me succeeded.");

    // 2. Verify 401 handling for invalid/expired token
    const invalidSession = await authManager.validateSession("invalid-token-12345");
    assert.strictEqual(invalidSession.valid, false);
    assert.strictEqual(invalidSession.expired, true);
    console.log("  ✓ 401 session expiration cleanly intercepted and flagged.");

    // 3. Verify streaming SSE task execution with workspace context
    const receivedChunks: string[] = [];
    let completedResult: any;

    await client.executeStream(
      {
        task: "Explain how authentication works in the active file",
        context: {
          workspace: {
            activeFile: {
              relativePath: "src/middleware/auth.ts",
              language: "typescript",
              content: "export const authenticate = ...",
            },
          },
        },
        stream: true,
      },
      {
        onChunk: (chunk) => {
          receivedChunks.push(chunk);
        },
        onDone: (result) => {
          completedResult = result;
        },
      },
    );

    assert.ok(receivedChunks.length > 0 || completedResult?.output);
    assert.strictEqual(completedResult?.status, AGENT_STATUSES.COMPLETED);
    console.log("  ✓ End-to-end streaming agent execution with workspace context succeeded.");

    // 4. Verify cancellation via AbortController
    const abortController = new AbortController();
    let wasAborted = false;

    // Trigger abort immediately
    abortController.abort();

    await client.executeStream(
      {
        task: "Task to cancel",
        stream: true,
      },
      {
        onAborted: () => {
          wasAborted = true;
        },
      },
      abortController.signal,
    );

    assert.strictEqual(wasAborted, true);
    console.log("  ✓ AbortController cancellation successfully caught and dispatched.");

    // 5. Verify live PKCE authorization code generation and exchange
    const { generatePkceVerifier, generatePkceChallenge, generateState } = await import("../src/auth/auth.manager");
    const pkceVerifier = generatePkceVerifier();
    const pkceChallenge = generatePkceChallenge(pkceVerifier);
    const pkceState = generateState();
    const allowedRedirectUri = "vscode://nexamind.nexamind-vscode/auth";

    const authCodeResult = await authService.vscodeAuthorize(userId, {
      codeChallenge: pkceChallenge,
      codeChallengeMethod: "S256",
      state: pkceState,
      redirectUri: allowedRedirectUri,
    });

    const exchangeResult = await authManager.exchangePkceCode(authCodeResult.code, pkceVerifier, allowedRedirectUri);
    assert.strictEqual(exchangeResult.success, true);
    assert.strictEqual(exchangeResult.user?.email, testEmail);
    assert.ok(inMemorySecrets["nexamind.jwt_access_token"]);
    assert.ok(inMemorySecrets["nexamind.jwt_refresh_token"]);
    assert.strictEqual(await authManager.getSessionType(), "pkce");
    console.log("  ✓ Live PKCE code exchange with real backend succeeded.");

    // 6. Verify live refresh token rotation
    const originalAccessToken = inMemorySecrets["nexamind.jwt_access_token"];
    const originalRefreshToken = inMemorySecrets["nexamind.jwt_refresh_token"];

    const rotatedAccessToken = await authManager.refreshSession();
    assert.ok(rotatedAccessToken);
    assert.ok(rotatedAccessToken);
    // Refresh token must be rotated to a fresh random opaque token
    assert.notStrictEqual(inMemorySecrets["nexamind.jwt_refresh_token"], originalRefreshToken);

    const renewedSession = await authManager.validateSession();
    assert.strictEqual(renewedSession.valid, true);
    assert.strictEqual(renewedSession.user?.email, testEmail);
    console.log("  ✓ Live refresh-token rotation with real backend succeeded.");

    // 7. Verify live remote session revocation and logout
    await authManager.logout();
    assert.strictEqual(inMemorySecrets["nexamind.jwt_access_token"], undefined);
    assert.strictEqual(inMemorySecrets["nexamind.jwt_refresh_token"], undefined);
    assert.strictEqual(await authManager.getSessionType(), "none");
    console.log("  ✓ Live logout and remote refresh-family revocation succeeded.");

  } finally {
    // Reset agent service to default singleton
    setAgentService(agentService);

    // Clean up test user
    await User.findByIdAndDelete(userId);
    await TokenBalance.findOneAndDelete({ userId });

    // Close server and disconnect DB
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disconnectDatabase();
  }
}
