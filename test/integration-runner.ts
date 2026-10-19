import * as path from "node:path";
import * as fs from "node:fs";
import Module from "node:module";
import * as mockVscode from "./mocks/vscode";

// Intercept 'vscode' import for standalone unit tests outside VS Code host
const originalResolveFilename = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (
  request: string,
  parent: any,
  isMain: boolean,
  options: any,
) {
  if (request === "vscode") {
    return "vscode";
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

require.cache["vscode"] = {
  id: "vscode",
  filename: "vscode",
  loaded: true,
  exports: mockVscode,
} as any;

/**
 * Live Backend Integration Test Runner
 * Explicitly checks prerequisites before importing backend modules or loading secrets.
 */
async function main(): Promise<void> {
  console.log("==================================================");
  console.log(" NexaMind VS Code Extension - Live Backend Integration");
  console.log("==================================================\n");

  const backendEnvPath = path.resolve(__dirname, "../../backend/.env");

  if (!fs.existsSync(backendEnvPath)) {
    console.error("❌ Cannot run live backend integration tests: backend environment configuration is missing.");
    console.error(`   Expected file: ${backendEnvPath}`);
    console.error("   Prerequisites: Live integration tests require a configured backend environment with MONGODB_URI and JWT_SECRET.");
    console.error("   To run standalone unit tests without backend dependencies, run: npm run test:unit\n");
    process.exit(1);
  }

  try {
    const { runBackendIntegrationTests } = await import("./backend-integration.test");
    await runBackendIntegrationTests();

    console.log("\n==================================================");
    console.log(" BACKEND INTEGRATION TESTS PASSED");
    console.log("==================================================");
  } catch (error) {
    console.error("\n❌ Live backend integration test failure:", error);
    process.exit(1);
  }
}

void main();
