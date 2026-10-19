import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, "../../");
    const extensionTestsPath = path.resolve(__dirname, "./suite/index");

    // Create isolated temporary directories for user data, extensions, and test workspace
    const tempUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexamind-userdata-"));
    const tempExtensionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexamind-extensions-"));
    const tempWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexamind-workspace-"));

    // Populate a test file in the workspace directory
    const sampleFilePath = path.join(tempWorkspaceDir, "sample-project.ts");
    fs.writeFileSync(
      sampleFilePath,
      `export const APP_NAME = "NexaMind";\nexport const VERSION = "0.2.0";\nexport function run() { return true; }\n`,
      "utf8",
    );

    console.log("[Test Host] Launching real VS Code Extension Host...");
    console.log(`[Test Host] Development Path: ${extensionDevelopmentPath}`);
    console.log(`[Test Host] Tests Path: ${extensionTestsPath}`);
    console.log(`[Test Host] Workspace: ${tempWorkspaceDir}`);

    try {
      await runTests({
        extensionDevelopmentPath,
        extensionTestsPath,
        launchArgs: [
          tempWorkspaceDir,
          `--user-data-dir=${tempUserDataDir}`,
          `--extensions-dir=${tempExtensionsDir}`,
          "--disable-extensions",
          "--disable-gpu",
        ],
      });
      console.log("\n[Test Host] All VS Code Extension Host tests completed successfully.");
    } finally {
      // Clean up isolated directories
      try { fs.rmSync(tempUserDataDir, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(tempExtensionsDir, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(tempWorkspaceDir, { recursive: true, force: true }); } catch {}
    }
  } catch (err) {
    console.error("[Test Host] Failed to run VS Code Extension Host tests:", err);
    process.exit(1);
  }
}

void main();
