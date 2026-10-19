import * as assert from "assert";
import * as vscode from "vscode";
import * as path from "path";
import { MockAgentServer } from "../fixtures/mock-server";
export interface NexaMindExtensionApi {
  authManager: any;
  client: any;
  contentProvider: any;
  proposalManager: any;
  chatViewProvider: any;
}

suite("NexaMind Extension Host Integration Tests", () => {
  let mockServer: MockAgentServer;
  let ext: vscode.Extension<NexaMindExtensionApi>;
  let api: NexaMindExtensionApi;
  let testWorkspaceRoot: string;

  suiteSetup(async () => {
    // 1. Start local ephemeral mock SSE server
    mockServer = new MockAgentServer();
    const serverUrl = await mockServer.start();
    console.log(`[Test Suite] Mock server listening at ${serverUrl}`);

    // 2. Locate and activate the extension using the actual extension identifier
    ext = vscode.extensions.getExtension<NexaMindExtensionApi>("nexamind.nexamind-vscode")!;
    assert.ok(ext, "Extension nexamind.nexamind-vscode must be present in the extension host");

    api = await ext.activate();
    assert.ok(api, "Extension activate() must return public ExtensionApi");
    assert.strictEqual(ext.isActive, true, "Extension must be in active state");

    // 3. Configure nexamind.apiUrl to point to the local mock server
    await vscode.workspace
      .getConfiguration("nexamind")
      .update("apiUrl", serverUrl, vscode.ConfigurationTarget.Global);

    // 4. Verify test workspace folder
    const folders = vscode.workspace.workspaceFolders;
    assert.ok(folders && folders.length > 0, "A temporary test workspace folder must be open");
    testWorkspaceRoot = folders[0].uri.fsPath;
  });

  suiteTeardown(async () => {
    await mockServer.stop();
  });

  // --------------------------------------------------------------------------
  // Domain 1: Extension Activation & Command Registration
  // --------------------------------------------------------------------------
  test("1. All 9 contributed commands must be registered in the VS Code command registry", async () => {
    const allCommands = await vscode.commands.getCommands(true);

    const expectedCommands = [
      "nexamind.ask",
      "nexamind.explain",
      "nexamind.proposeEdit",
      "nexamind.reviewDiff",
      "nexamind.applyProposal",
      "nexamind.rejectProposal",
      "nexamind.login",
      "nexamind.logout",
      "nexamind.clearChat",
    ];

    for (const cmd of expectedCommands) {
      assert.ok(
        allCommands.includes(cmd),
        `Command "${cmd}" was declared in package.json but not registered during activation.`,
      );
    }
  });

  // --------------------------------------------------------------------------
  // Domain 2: Sidebar Initialization & Message Handling
  // --------------------------------------------------------------------------
  test("2. Sidebar view provider initializes and processes webview message flow", async () => {
    assert.ok(api.chatViewProvider, "chatViewProvider must be available on extension API");

    let messageListener: ((msg: any) => Promise<any> | void) | undefined;
    const postedToWebview: any[] = [];

    const mockWebviewView: any = {
      webview: {
        options: {},
        html: "",
        onDidReceiveMessage: (listener: (msg: any) => Promise<any> | void) => {
          messageListener = listener;
          return { dispose: () => {} };
        },
        postMessage: async (msg: any) => {
          postedToWebview.push(msg);
          return true;
        },
      },
    };

    // Simulate VS Code resolving the webview view
    api.chatViewProvider.resolveWebviewView(mockWebviewView, {} as any, {} as any);
    assert.ok(messageListener, "resolveWebviewView must register onDidReceiveMessage listener");

    // Test "ready" message handling
    await messageListener!({ type: "ready" });
    const restoreMsg = postedToWebview.find((m) => m.type === "restoreMessages");
    assert.ok(restoreMsg, "Webview ready must prompt restoreMessages to synchronize state");

    // Test "clear" message handling
    await messageListener!({ type: "clear" });
    const clearedMsg = postedToWebview.reverse().find((m) => m.type === "restoreMessages");
    assert.ok(clearedMsg && clearedMsg.messages.length === 0, "clear must post empty messages array");

    // Test "logout" message handling
    await messageListener!({ type: "logout" });
    const user = api.authManager.getCurrentUser();
    assert.strictEqual(user, null, "logout message must clear the active user");
  });

  // --------------------------------------------------------------------------
  // Domain 3: AI Streaming, Cancellation, and HTTP 401/402 Error Handling
  // --------------------------------------------------------------------------
  test("3.1 SSE streaming receives live chunks and finishes cleanly from local mock server", async () => {
    // Populate valid token in secrets
    await (api.authManager as any).secrets.store("nexamind.jwt_access_token", "valid-test-token");
    await api.authManager.validateSession();

    const receivedChunks: string[] = [];
    let completed = false;

    await api.client.executeStream(
      {
        task: "Explain sample code",
        stream: true,
      },
      {
        onChunk: (chunk: string) => {
          receivedChunks.push(chunk);
        },
        onDone: (res: any) => {
          completed = true;
          assert.strictEqual(res.status, "completed");
        },
      },
    );

    assert.ok(receivedChunks.length > 0, "Streaming chunks must be received through SSE");
    assert.strictEqual(completed, true, "onDone must be triggered upon stream completion");
  });

  test("3.2 Stream cancellation via AbortController aborts cleanly without unhandled rejection", async () => {
    const abortController = new AbortController();
    let wasAborted = false;

    const executePromise = api.client.executeStream(
      {
        task: "Task to cancel",
        stream: true,
      },
      {
        onStart: () => {
          // Abort mid-flight
          abortController.abort();
        },
        onAborted: () => {
          wasAborted = true;
        },
      },
      abortController.signal,
    );

    await executePromise;
    assert.strictEqual(wasAborted, true, "onAborted callback must be invoked when AbortSignal fires");
  });

  test("3.3 HTTP 401 Session Expiration error is captured and formatted", async () => {
    // Set expired token
    await (api.authManager as any).secrets.store("nexamind.jwt_access_token", "expired-token");

    let capturedError: Error | undefined;

    try {
      await api.client.executeStream(
        { task: "Expired task", stream: true },
        {
          onError: (err: any) => {
            capturedError = err;
          },
        },
      );
    } catch (err: any) {
      capturedError = err;
    }

    assert.ok(capturedError, "Expected executeStream to report 401 error");
    assert.match(capturedError.message, /Session expired or invalid/i);
  });

  test("3.4 HTTP 402 Insufficient Credits error is captured and formatted", async () => {
    // Set no-credit token
    await (api.authManager as any).secrets.store("nexamind.jwt_access_token", "no-credit-token");

    let capturedError: Error | undefined;

    try {
      await api.client.executeStream(
        { task: "No-credit task", stream: true },
        {
          onError: (err: any) => {
            capturedError = err;
          },
        },
      );
    } catch (err: any) {
      capturedError = err;
    }

    assert.ok(capturedError, "Expected executeStream to report 402 error");
    assert.match(capturedError.message, /Insufficient credit balance/i);
  });

  // --------------------------------------------------------------------------
  // Domain 4: Diff Preview, Rejection, and Approval Workflows on Real Files
  // --------------------------------------------------------------------------
  test("4.1 Prepare edit proposal and verify native vscode.diff resolution", async () => {
    const testFileName = "sample-project.ts";
    const testFileUri = vscode.Uri.file(path.join(testWorkspaceRoot, testFileName));

    // Reset initial file content
    const initialContent = `export const APP_NAME = "NexaMind";\nexport const VERSION = "0.2.0";\nexport function run() { return true; }\n`;
    await vscode.workspace.fs.writeFile(testFileUri, new TextEncoder().encode(initialContent));

    const prep = await api.proposalManager.prepareProposal([
      {
        filePath: testFileName,
        chunks: [
          {
            search: 'export const VERSION = "0.2.0";',
            replace: 'export const VERSION = "0.2.1-beta";',
          },
        ],
        rawBlock: "",
      },
    ]);

    assert.strictEqual(prep.success, true, `prepareProposal failed: ${prep.error}`);
    assert.ok(prep.proposal, "ActiveProposal must be generated");
    const proposalId = prep.proposal.id;

    // Verify openDiffPreview executes vscode.diff and registers proposed content
    await api.proposalManager.openDiffPreview(proposalId, 0);

    // Verify virtual document content provider resolves nexamind-proposed://
    const virtualUri = vscode.Uri.parse(
      `nexamind-proposed:/${testFileName}?proposal=${proposalId}&idx=0`,
    );
    const virtualDocContent = api.contentProvider.provideTextDocumentContent(virtualUri);
    assert.ok(virtualDocContent, "ProposedContentProvider must supply virtual document content");
    assert.match(virtualDocContent, /VERSION = "0.2.1-beta"/);
  });

  test("4.2 Rejection flow transitions proposal to rejected and leaves target file byte-for-byte unchanged", async () => {
    const testFileName = "sample-project.ts";
    const testFileUri = vscode.Uri.file(path.join(testWorkspaceRoot, testFileName));

    const initialContent = `export const APP_NAME = "NexaMind";\nexport const VERSION = "0.2.0";\nexport function run() { return true; }\n`;
    await vscode.workspace.fs.writeFile(testFileUri, new TextEncoder().encode(initialContent));

    const prep = await api.proposalManager.prepareProposal([
      {
        filePath: testFileName,
        chunks: [
          {
            search: 'export const VERSION = "0.2.0";',
            replace: 'export const VERSION = "0.9.9-rejected";',
          },
        ],
        rawBlock: "",
      },
    ]);

    assert.strictEqual(prep.success, true);
    assert.ok(prep.proposal);
    const proposalId = prep.proposal.id;
    assert.strictEqual(prep.proposal.status, "pending");

    // Perform explicit rejection through ProposalManager
    await api.proposalManager.rejectProposal(proposalId);
    assert.strictEqual(prep.proposal.status, "rejected", "Proposal status must transition to rejected");

    // Assert that target file remains byte-for-byte unchanged
    const bytesOnDisk = await vscode.workspace.fs.readFile(testFileUri);
    const currentOnDisk = new TextDecoder().decode(bytesOnDisk);
    assert.strictEqual(currentOnDisk, initialContent, "Target file must remain byte-for-byte unchanged after rejection");

    // Verify rejected proposal cannot subsequently be applied
    const applyAfterReject = await api.proposalManager.applyProposal(proposalId, true);
    assert.strictEqual(applyAfterReject.success, false);
    assert.match(applyAfterReject.error || "", /Cannot apply proposal in status "rejected"/);
  });

  test("4.3 Apply approved edit proposal modifies real workspace file atomically", async () => {
    const testFileName = "sample-project.ts";
    const testFileUri = vscode.Uri.file(path.join(testWorkspaceRoot, testFileName));

    const prep = await api.proposalManager.prepareProposal([
      {
        filePath: testFileName,
        chunks: [
          {
            search: 'export const APP_NAME = "NexaMind";',
            replace: 'export const APP_NAME = "NexaMind AI Studio";',
          },
        ],
        rawBlock: "",
      },
    ]);

    assert.strictEqual(prep.success, true);
    const proposalId = prep.proposal!.id;

    // Apply with skipPrompt = true (headless approval)
    const applyResult = await api.proposalManager.applyProposal(proposalId, true);
    assert.strictEqual(applyResult.success, true, `Apply failed: ${applyResult.error}`);
    assert.strictEqual(prep.proposal!.status, "applied");

    // Read back file from real filesystem
    const diskBytes = await vscode.workspace.fs.readFile(testFileUri);
    const updatedContent = new TextDecoder().decode(diskBytes);
    assert.match(updatedContent, /export const APP_NAME = "NexaMind AI Studio";/);
  });

  test("4.4 User cancellation during apply aborts edit and preserves pending status", async () => {
    const testFileName = "sample-project.ts";
    const testFileUri = vscode.Uri.file(path.join(testWorkspaceRoot, testFileName));

    const contentBefore = new TextDecoder().decode(await vscode.workspace.fs.readFile(testFileUri));

    const prep = await api.proposalManager.prepareProposal([
      {
        filePath: testFileName,
        chunks: [
          {
            search: 'export const APP_NAME = "NexaMind AI Studio";',
            replace: 'export const APP_NAME = "NexaMind Cancelled";',
          },
        ],
        rawBlock: "",
      },
    ]);

    assert.strictEqual(prep.success, true);
    const proposalId = prep.proposal!.id;

    // Call applyProposal with skipPrompt = false (interactive prompt in headless host returns undefined = user cancelled)
    const cancelResult = await api.proposalManager.applyProposal(proposalId, false);
    assert.strictEqual(cancelResult.success, false);
    assert.strictEqual(cancelResult.error, "User cancelled edit.");
    assert.strictEqual(prep.proposal!.status, "pending", "Cancelled proposal must remain pending, not rejected");

    // Target file remains untouched
    const bytesOnDisk = await vscode.workspace.fs.readFile(testFileUri);
    assert.strictEqual(new TextDecoder().decode(bytesOnDisk), contentBefore, "File must remain untouched after user cancellation");
  });

  // --------------------------------------------------------------------------
  // Domain 5: Stale-File Conflict Protection
  // --------------------------------------------------------------------------
  test("5. Stale-file conflict detection protects file from corrupted concurrent overwrites", async () => {
    const testFileName = "sample-project.ts";
    const testFileUri = vscode.Uri.file(path.join(testWorkspaceRoot, testFileName));

    // Prepare proposal against current version
    const prep = await api.proposalManager.prepareProposal([
      {
        filePath: testFileName,
        chunks: [
          {
            search: 'export function run() { return true; }',
            replace: 'export function run() { return false; }',
          },
        ],
        rawBlock: "",
      },
    ]);

    assert.strictEqual(prep.success, true);
    const proposalId = prep.proposal!.id;

    // Simulate concurrent external modification by user / linter before apply
    const conflictingContent = `export const APP_NAME = "NexaMind AI Studio";\nexport const VERSION = "0.2.0";\nexport function run() { /* concurrent developer edit */ return true; }\n`;
    await vscode.workspace.fs.writeFile(testFileUri, new TextEncoder().encode(conflictingContent));

    // Attempt to apply the now-stale proposal
    const staleApplyResult = await api.proposalManager.applyProposal(proposalId, true);

    assert.strictEqual(staleApplyResult.success, false, "Stale file must cause applyProposal to fail closed");
    assert.match(
      staleApplyResult.error || "",
      /modified since the proposal was generated/i,
      "Error must identify stale file conflict",
    );
    assert.strictEqual(prep.proposal!.status, "stale");

    // Verify disk content was NOT overwritten or corrupted
    const currentDisk = new TextDecoder().decode(await vscode.workspace.fs.readFile(testFileUri));
    assert.strictEqual(
      currentDisk,
      conflictingContent,
      "File content on disk must remain preserved when stale conflict occurs",
    );
  });
});
