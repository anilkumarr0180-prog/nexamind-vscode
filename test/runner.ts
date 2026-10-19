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
 * Standalone Extension Unit Test Runner
 * Executes all extension unit suites without requiring backend/.env, MongoDB, or external provider keys.
 */
async function main(): Promise<void> {
  console.log("==================================================");
  console.log(" NexaMind VS Code Extension - Unit Test Suite");
  console.log("==================================================\n");

  try {
    const { runConfigTests } = await import("./config.test");
    const { runSecretFilterTests } = await import("./secret-filter.test");
    const { runSSEParserTests } = await import("./sse-parser.test");
    const { runContextCollectorTests } = await import("./context-collector.test");
    const { runDiffTests } = await import("./diff.test");
    const { runAuthTests } = await import("./auth.test");
    const { runWebviewCspTests } = await import("./webview-csp.test");

    runConfigTests();
    runSecretFilterTests();
    runSSEParserTests();
    runContextCollectorTests();
    await runDiffTests();
    await runAuthTests();
    runWebviewCspTests();

    console.log("\n==================================================");
    console.log(" ALL UNIT TESTS PASSED (7/7 suites)");
    console.log("==================================================");
  } catch (error) {
    console.error("\n❌ Unit test suite failure:", error);
    process.exit(1);
  }
}

void main();
