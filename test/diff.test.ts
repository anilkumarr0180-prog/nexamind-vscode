import assert from "node:assert/strict";
import path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { parseEditProposals } from "../src/diff/edit.parser";
import {
  validateTargetFilePath,
  validateCanonicalPathBoundary,
  applyReplacementChunks,
} from "../src/diff/edit.validator";
import { ProposedContentProvider } from "../src/diff/proposal.provider";
import { ProposalManager } from "../src/diff/proposal.manager";
import {
  mockFilesystem,
} from "./mocks/vscode";

export async function runDiffTests(): Promise<void> {
  console.log("[Test Suite] Structured Code Edit Proposals & Diff Management");

  // 1. Valid Edit Parsing
  console.log("  Testing valid edit parsing...");
  const validText = `Here is the proposed change:
\`\`\`edit:src/middleware/auth.ts
<<<<<<< SEARCH
  if (!authHeader.startsWith("Bearer ")) {
    return next(new AppError("Invalid auth header", 401));
  }
=======
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return next(new AppError("Invalid bearer token format", 401));
  }
>>>>>>> REPLACE
\`\`\`
Hope this helps!`;

  const parsed = parseEditProposals(validText);
  assert.strictEqual(parsed.hasProposals, true);
  assert.strictEqual(parsed.proposals.length, 1);
  assert.strictEqual(parsed.proposals[0].filePath, "src/middleware/auth.ts");
  assert.strictEqual(parsed.proposals[0].chunks.length, 1);
  assert.match(parsed.proposals[0].chunks[0].search, /!authHeader\.startsWith/);
  assert.match(parsed.proposals[0].chunks[0].replace, /!authHeader\.toLowerCase\(\)\.startsWith/);
  assert.strictEqual(parsed.errors.length, 0);

  // 2. Multi-chunk parsing in single file
  console.log("  Testing multi-chunk parsing...");
  const multiChunkText = `\`\`\`edit:src/utils.ts
<<<<<<< SEARCH
const a = 1;
=======
const a = 10;
>>>>>>> REPLACE

<<<<<<< SEARCH
const b = 2;
=======
const b = 20;
>>>>>>> REPLACE
\`\`\``;

  const multiParsed = parseEditProposals(multiChunkText);
  assert.strictEqual(multiParsed.hasProposals, true);
  assert.strictEqual(multiParsed.proposals[0].chunks.length, 2);
  assert.strictEqual(multiParsed.proposals[0].chunks[0].replace, "const a = 10;");
  assert.strictEqual(multiParsed.proposals[0].chunks[1].replace, "const b = 20;");

  // 3. Multi-file proposal parsing
  console.log("  Testing multi-file proposal parsing...");
  const multiFileText = `\`\`\`edit:src/file1.ts
<<<<<<< SEARCH
old 1
=======
new 1
>>>>>>> REPLACE
\`\`\`

\`\`\`edit:src/file2.ts
<<<<<<< SEARCH
old 2
=======
new 2
>>>>>>> REPLACE
\`\`\``;

  const multiFileParsed = parseEditProposals(multiFileText);
  assert.strictEqual(multiFileParsed.proposals.length, 2);
  assert.strictEqual(multiFileParsed.proposals[0].filePath, "src/file1.ts");
  assert.strictEqual(multiFileParsed.proposals[1].filePath, "src/file2.ts");

  // 4. Safe Non-Executable Text (Never parse standard code blocks)
  console.log("  Testing non-edit code blocks ignored...");
  const ordinaryCodeText = `Here is an example:
\`\`\`typescript
function foo() {
  return "bar";
}
\`\`\`
Notice how this function works.`;

  const ordinaryParsed = parseEditProposals(ordinaryCodeText);
  assert.strictEqual(ordinaryParsed.hasProposals, false);
  assert.strictEqual(ordinaryParsed.proposals.length, 0);
  assert.strictEqual(ordinaryParsed.errors.length, 0);

  // 5. Malformed Edit Blocks
  console.log("  Testing malformed edit block detection...");
  const malformedMissingSearch = `\`\`\`edit:src/app.ts
Just some code without markers
\`\`\``;
  const malformedParsed1 = parseEditProposals(malformedMissingSearch);
  assert.strictEqual(malformedParsed1.hasProposals, false);
  assert.strictEqual(malformedParsed1.errors.length, 1);
  assert.match(malformedParsed1.errors[0], /missing '<<<<<<< SEARCH'/);

  const malformedIncompleteMarkers = `\`\`\`edit:src/app.ts
<<<<<<< SEARCH
some code
missing replace and end markers
\`\`\``;
  const malformedParsed2 = parseEditProposals(malformedIncompleteMarkers);
  assert.strictEqual(malformedParsed2.hasProposals, false);
  assert.strictEqual(malformedParsed2.errors.length, 1);
  assert.match(malformedParsed2.errors[0], /could not parse valid/);

  // 6. Path Traversal & Lexical Security Rejection
  console.log("  Testing path traversal and protected file rejection...");
  assert.strictEqual(validateTargetFilePath("../outside.ts").valid, false);
  assert.strictEqual(validateTargetFilePath("../../etc/passwd").valid, false);
  assert.strictEqual(validateTargetFilePath("/etc/hosts").valid, false);
  assert.strictEqual(validateTargetFilePath("foo/bar\0null").valid, false);

  // Protected files
  assert.strictEqual(validateTargetFilePath(".env").valid, false);
  assert.strictEqual(validateTargetFilePath(".env.local").valid, false);
  assert.strictEqual(validateTargetFilePath("certs/server.pem").valid, false);
  assert.strictEqual(validateTargetFilePath("id_rsa").valid, false);
  assert.strictEqual(validateTargetFilePath("node_modules/express/index.js").valid, false);

  // 7. Real Filesystem Symlink Traversal Verification (Un-mocked)
  console.log("  Testing canonical symlink boundary enforcement on real filesystem...");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nexamind-sec-test-"));
  const realWorkspace = path.join(tempDir, "workspace");
  const outsideDir = path.join(tempDir, "outside");
  fs.mkdirSync(realWorkspace);
  fs.mkdirSync(outsideDir);

  const outsideFile = path.join(outsideDir, "external-code.ts");
  fs.writeFileSync(outsideFile, "export const externalCode = 'safe-filename-outside';");

  // Create symlink inside workspace pointing outside
  const symlinkInside = path.join(realWorkspace, "symlink-to-outside");
  fs.symlinkSync(outsideDir, symlinkInside);

  // Attempting to target file through the symlink must be REJECTED
  const symlinkTarget = "symlink-to-outside/external-code.ts";
  const symlinkCheck = validateTargetFilePath(symlinkTarget, realWorkspace);
  assert.strictEqual(symlinkCheck.valid, false, "Targeting file via symlink outside workspace must fail");
  assert.match(symlinkCheck.error || "", /escapes the workspace boundary via symbolic link/);

  // Test symlink to a protected file (.env) outside workspace
  const outsideEnv = path.join(outsideDir, ".env");
  fs.writeFileSync(outsideEnv, "SECRET=123");
  const symlinkToEnv = path.join(realWorkspace, "link-to-env");
  fs.symlinkSync(outsideEnv, symlinkToEnv);

  const envSymlinkCheck = validateTargetFilePath("link-to-env", realWorkspace);
  assert.strictEqual(envSymlinkCheck.valid, false, "Symlink targeting sensitive file must fail");

  // Test fail-closed behavior on broken path / realpath failure
  const brokenPathResult = validateCanonicalPathBoundary("some/file.ts", "/nonexistent-workspace-root-12345");
  assert.strictEqual(brokenPathResult.valid, false, "Non-existent workspace root must fail closed");
  assert.match(brokenPathResult.error || "", /Failing closed/);

  // Clean up real test directory
  fs.rmSync(tempDir, { recursive: true, force: true });

  // 8. Ambiguity & Missing Search Matching
  console.log("  Testing search matching, ambiguity, and replacements...");
  const originalDoc = `function calculate() {
  const x = 10;
  console.log(x);
  const x = 10;
  return x;
}`;

  // Ambiguous match (appears twice)
  const ambiguousResult = applyReplacementChunks(
    originalDoc,
    [{ search: "  const x = 10;", replace: "  const x = 20;" }],
    "src/calc.ts",
  );
  assert.strictEqual(ambiguousResult.success, false);
  assert.match(ambiguousResult.error || "", /Ambiguous match/);

  // Missing match (0 occurrences)
  const missingResult = applyReplacementChunks(
    originalDoc,
    [{ search: "const nonexistent = 999;", replace: "const x = 20;" }],
    "src/calc.ts",
  );
  assert.strictEqual(missingResult.success, false);
  assert.match(missingResult.error || "", /Search block 1 not found/);

  // Unique successful match
  const uniqueResult = applyReplacementChunks(
    originalDoc,
    [{ search: "function calculate() {", replace: "function computeTotal() {" }],
    "src/calc.ts",
  );
  assert.strictEqual(uniqueResult.success, true);
  assert.match(uniqueResult.proposedContent || "", /function computeTotal\(\) {/);

  // 9. Lifecycle: Proposal Preparation, Approval, Stale Detection, and Application
  console.log("  Testing ProposalManager lifecycle with mock workspace...");
  const contentProvider = new ProposedContentProvider();

  // In mock testing, provide mock realpath that resolves within mock workspace
  const mockWorkspaceRoot = "/test-workspace";
  const mockValidatorOptions = {
    realpathSync: (p: string) => p,
    existsSync: (p: string) => p.startsWith("/test-workspace"),
  };

  const manager = new ProposalManager(contentProvider, mockValidatorOptions);

  const testFilePath = "src/example.ts";
  const fullFsPath = path.resolve(mockWorkspaceRoot, testFilePath);

  const initialCode = "export const VERSION = '1.0.0';\nexport const ENV = 'development';";
  mockFilesystem.set(fullFsPath, initialCode);

  // Prepare valid proposal
  const prep = await manager.prepareProposal([
    {
      filePath: testFilePath,
      chunks: [
        {
          search: "export const VERSION = '1.0.0';",
          replace: "export const VERSION = '1.1.0';",
        },
      ],
      rawBlock: "",
    },
  ]);

  assert.strictEqual(prep.success, true);
  assert.ok(prep.proposal);
  const proposalId = prep.proposal.id;
  assert.strictEqual(prep.proposal.status, "pending");

  // Verify diff preview setup
  await manager.openDiffPreview(proposalId, 0);

  // 10. Rejection leaving file unchanged
  console.log("  Testing proposal rejection leaves files unchanged...");
  await manager.rejectProposal(proposalId);
  assert.strictEqual(prep.proposal.status, "rejected");
  assert.strictEqual(
    mockFilesystem.get(fullFsPath),
    initialCode,
    "File must remain unchanged after rejection",
  );

  // 11. Stale File Detection
  console.log("  Testing stale file detection...");
  // Prepare a new proposal on initialCode
  const prep2 = await manager.prepareProposal([
    {
      filePath: testFilePath,
      chunks: [
        {
          search: "export const VERSION = '1.0.0';",
          replace: "export const VERSION = '2.0.0';",
        },
      ],
      rawBlock: "",
    },
  ]);
  assert.strictEqual(prep2.success, true);
  const proposal2Id = prep2.proposal!.id;

  // Simulate file being modified in editor/disk concurrently before user clicks Apply
  mockFilesystem.set(fullFsPath, "export const VERSION = '1.0.0';\n// Concurrent change by dev");

  // Attempt apply
  const staleApply = await manager.applyProposal(proposal2Id, true);
  assert.strictEqual(staleApply.success, false);
  assert.match(staleApply.error || "", /modified since the proposal was generated/);
  assert.strictEqual(prep2.proposal!.status, "stale");
  assert.strictEqual(
    mockFilesystem.get(fullFsPath),
    "export const VERSION = '1.0.0';\n// Concurrent change by dev",
    "Stale file must not be overwritten",
  );

  // 12. Atomic Multi-File Failure Handling
  console.log("  Testing atomic multi-file failure handling...");
  const fileA = "src/a.ts";
  const fileB = "src/b.ts";
  const fullPathA = path.resolve(mockWorkspaceRoot, fileA);
  const fullPathB = path.resolve(mockWorkspaceRoot, fileB);

  mockFilesystem.set(fullPathA, "const a = 1;");
  mockFilesystem.set(fullPathB, "const b = 2;");

  // Prepare proposal modifying both files
  const multiPrep = await manager.prepareProposal([
    {
      filePath: fileA,
      chunks: [{ search: "const a = 1;", replace: "const a = 100;" }],
      rawBlock: "",
    },
    {
      filePath: fileB,
      chunks: [{ search: "const b = 2;", replace: "const b = 200;" }],
      rawBlock: "",
    },
  ]);
  assert.strictEqual(multiPrep.success, true);
  const multiProposalId = multiPrep.proposal!.id;

  // Corrupt fileB so it fails stale check
  mockFilesystem.set(fullPathB, "const b = 2; // modified by user");

  // Attempt apply: fileA is valid, but fileB is stale
  const atomicApplyResult = await manager.applyProposal(multiProposalId, true);
  assert.strictEqual(atomicApplyResult.success, false);
  assert.match(atomicApplyResult.error || "", /was modified since/);

  // Verify fileA was NOT touched (atomic all-or-nothing)
  assert.strictEqual(
    mockFilesystem.get(fullPathA),
    "const a = 1;",
    "File A must not be partially modified when File B fails",
  );

  // 13. Pre-Apply Symlink Validation Check
  console.log("  Testing pre-apply symlink validation...");
  mockFilesystem.set(fullPathA, "const a = 1;");
  const symlinkEscapingProposal = await manager.prepareProposal([
    {
      filePath: fileA,
      chunks: [{ search: "const a = 1;", replace: "const a = 999;" }],
      rawBlock: "",
    },
  ]);
  assert.strictEqual(symlinkEscapingProposal.success, true);

  // Instantiate manager with an options checker simulating a symlink created post-preparation
  const symlinkHijackManager = new ProposalManager(contentProvider, {
    realpathSync: (p: string) => {
      if (p.includes("src/a.ts")) {
        return "/outside-workspace/a.ts";
      }
      return p;
    },
    existsSync: () => true,
  });

  // Transfer proposal to hijacked manager to simulate target escaping before apply
  (symlinkHijackManager as any).proposals.set(
    symlinkEscapingProposal.proposal!.id,
    symlinkEscapingProposal.proposal!,
  );

  const hijackedApply = await symlinkHijackManager.applyProposal(
    symlinkEscapingProposal.proposal!.id,
    true,
  );
  assert.strictEqual(hijackedApply.success, false);
  assert.match(hijackedApply.error || "", /escapes the workspace boundary via symbolic link/);

  // 14. Successful Apply with Approval
  console.log("  Testing successful apply with approval...");
  mockFilesystem.set(fullPathA, "const a = 1;");
  mockFilesystem.set(fullPathB, "const b = 2;");

  const cleanPrep = await manager.prepareProposal([
    {
      filePath: fileA,
      chunks: [{ search: "const a = 1;", replace: "const a = 100;" }],
      rawBlock: "",
    },
    {
      filePath: fileB,
      chunks: [{ search: "const b = 2;", replace: "const b = 200;" }],
      rawBlock: "",
    },
  ]);
  assert.strictEqual(cleanPrep.success, true);

  const cleanApplyResult = await manager.applyProposal(cleanPrep.proposal!.id, true);
  assert.strictEqual(cleanApplyResult.success, true);
  assert.strictEqual(mockFilesystem.get(fullPathA), "const a = 100;");
  assert.strictEqual(mockFilesystem.get(fullPathB), "const b = 200;");
  assert.strictEqual(cleanPrep.proposal!.status, "applied");

  console.log("  ✓ All structured edit proposal and diff tests passed successfully.");
}
