import * as vscode from "vscode";
import * as path from "path";
import { randomUUID } from "crypto";
import type { ProposedContentProvider } from "./proposal.provider";
import {
  validateTargetFilePath,
  validateCanonicalPathBoundary,
  applyReplacementChunks,
  type CanonicalValidatorOptions,
} from "./edit.validator";
import type {
  ActiveProposal,
  FileEditProposal,
  ValidatedFileEdit,
} from "./edit.types";

/**
 * Manages the lifecycle of code edit proposals: validation, diff previewing,
 * human approval, conflict/stale-file detection, canonical symlink protection,
 * and atomic application.
 */
export class ProposalManager {
  private readonly proposals = new Map<string, ActiveProposal>();
  private readonly onProposalUpdatedEmitter = new vscode.EventEmitter<ActiveProposal>();
  public readonly onProposalUpdated = this.onProposalUpdatedEmitter.event;

  constructor(
    private readonly contentProvider: ProposedContentProvider,
    private readonly validatorOptions?: CanonicalValidatorOptions,
  ) {}

  public getProposal(id: string): ActiveProposal | undefined {
    return this.proposals.get(id);
  }

  /**
   * Prepares and validates a parsed edit proposal against workspace files.
   * Performs path traversal checks, security filtering, canonical symlink validation,
   * and search uniqueness verification.
   */
  public async prepareProposal(
    rawProposals: FileEditProposal[],
  ): Promise<{ success: boolean; proposal?: ActiveProposal; error?: string }> {
    if (!rawProposals || rawProposals.length === 0) {
      return { success: false, error: "No edit proposals provided." };
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath || "";

    const validatedFiles: ValidatedFileEdit[] = [];

    for (const prop of rawProposals) {
      // 1. Path traversal & security & canonical symlink checks (fails closed)
      const pathCheck = validateTargetFilePath(
        prop.filePath,
        workspaceRoot,
        this.validatorOptions,
      );

      if (!pathCheck.valid || !pathCheck.normalizedPath) {
        return { success: false, error: pathCheck.error };
      }

      const relativePath = pathCheck.normalizedPath;
      const fullPath = workspaceRoot
        ? path.resolve(workspaceRoot, relativePath)
        : relativePath;

      // 2. Read existing file content
      const fileUri = vscode.Uri.file(fullPath);
      let originalContent: string;
      try {
        const fileBytes = await vscode.workspace.fs.readFile(fileUri);
        originalContent = new TextDecoder("utf-8").decode(fileBytes);
      } catch {
        return {
          success: false,
          error: `File not found in workspace: "${relativePath}". Cannot apply modifications to a non-existent file.`,
        };
      }

      // 3. Apply replacement chunks & verify uniqueness
      const replResult = applyReplacementChunks(
        originalContent,
        prop.chunks,
        relativePath,
      );

      if (!replResult.success || replResult.proposedContent === undefined) {
        return {
          success: false,
          error:
            replResult.error ||
            `Failed to calculate replacement for "${relativePath}".`,
        };
      }

      validatedFiles.push({
        filePath: relativePath,
        fullPath,
        originalContent,
        proposedContent: replResult.proposedContent,
        chunks: prop.chunks,
      });
    }

    const proposalId = `prop_${randomUUID().substring(0, 8)}`;
    const activeProposal: ActiveProposal = {
      id: proposalId,
      timestamp: Date.now(),
      files: validatedFiles,
      status: "pending",
    };

    this.proposals.set(proposalId, activeProposal);
    this.onProposalUpdatedEmitter.fire(activeProposal);

    return { success: true, proposal: activeProposal };
  }

  /**
   * Opens native side-by-side diff using vscode.diff.
   */
  public async openDiffPreview(proposalId: string, fileIndex = 0): Promise<void> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal || !proposal.files[fileIndex]) {
      vscode.window.showErrorMessage("Proposed edit not found.");
      return;
    }

    const file = proposal.files[fileIndex];
    const originalUri = vscode.Uri.file(file.fullPath || file.filePath);

    // Register virtual proposed document
    const virtualUri = vscode.Uri.parse(
      `nexamind-proposed:/${file.filePath}?proposal=${proposalId}&idx=${fileIndex}`,
    );
    this.contentProvider.setContent(virtualUri, file.proposedContent);

    const title = `NexaMind Review: ${path.basename(file.filePath)} (Original ↔ Proposed)`;
    await vscode.commands.executeCommand("vscode.diff", originalUri, virtualUri, title);
  }

  /**
   * Atomically applies proposal after human approval, fresh canonical path verification,
   * and stale-file checks.
   */
  public async applyProposal(
    proposalId: string,
    skipPrompt = false,
  ): Promise<{ success: boolean; error?: string }> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      return { success: false, error: "Proposal not found." };
    }

    if (proposal.status !== "pending") {
      return {
        success: false,
        error: `Cannot apply proposal in status "${proposal.status}".`,
      };
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath || "";
    const fileCount = proposal.files.length;

    // 1. Explicit user confirmation
    if (!skipPrompt) {
      let confirm: string | undefined;
      try {
        confirm = await vscode.window.showInformationMessage(
          `Apply NexaMind code proposal to ${fileCount} file(s)?`,
          { modal: true },
          "Apply Changes",
        );
      } catch {
        confirm = undefined;
      }

      if (confirm !== "Apply Changes") {
        return { success: false, error: "User cancelled edit." };
      }
    }

    // 2. Precondition check: verify canonical symlink boundary and stale status for ALL files before applying ANY
    const workspaceEdit = new vscode.WorkspaceEdit();
    const openDocs: Array<{ doc: vscode.TextDocument; file: ValidatedFileEdit }> = [];

    for (const file of proposal.files) {
      // Re-verify canonical symlink boundary immediately before write (fails closed)
      if (workspaceRoot) {
        const canonicalCheck = validateCanonicalPathBoundary(
          file.filePath,
          workspaceRoot,
          this.validatorOptions,
        );

        if (!canonicalCheck.valid) {
          proposal.status = "stale";
          proposal.errorMessage = canonicalCheck.error;
          this.onProposalUpdatedEmitter.fire(proposal);
          return {
            success: false,
            error: canonicalCheck.error || "Canonical path validation failed before apply.",
          };
        }
      }

      const targetUri = vscode.Uri.file(file.fullPath || file.filePath);
      let doc: vscode.TextDocument;

      try {
        doc = await vscode.workspace.openTextDocument(targetUri);
      } catch (err: unknown) {
        proposal.status = "stale";
        proposal.errorMessage = `Could not open file "${file.filePath}".`;
        this.onProposalUpdatedEmitter.fire(proposal);
        return {
          success: false,
          error: `Could not open file "${file.filePath}". Edit aborted.`,
        };
      }

      const currentContent = doc.getText();
      let diskContent = currentContent;
      try {
        const diskBytes = await vscode.workspace.fs.readFile(targetUri);
        diskContent = new TextDecoder("utf-8").decode(diskBytes);
      } catch {}

      // Detect if file changed on disk or in editor since proposal was generated
      if (currentContent !== file.originalContent || diskContent !== file.originalContent) {
        proposal.status = "stale";
        proposal.errorMessage = `File "${file.filePath}" has been modified since this proposal was generated.`;
        this.onProposalUpdatedEmitter.fire(proposal);
        return {
          success: false,
          error: `Conflict: "${file.filePath}" was modified since the proposal was generated. Apply cancelled to protect your work.`,
        };
      }

      openDocs.push({ doc, file });
    }

    // 3. Queue edits atomically
    for (const { doc, file } of openDocs) {
      const fullRange = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(doc.getText().length),
      );
      workspaceEdit.replace(doc.uri, fullRange, file.proposedContent);
    }

    // 4. Apply via VS Code Workspace API
    const applied = await vscode.workspace.applyEdit(workspaceEdit);
    if (!applied) {
      return {
        success: false,
        error: "Failed to apply workspace edit through VS Code API.",
      };
    }

    // 5. Save modified files
    for (const { doc } of openDocs) {
      try {
        await doc.save();
      } catch (saveErr: unknown) {
        proposal.status = "stale";
        return {
          success: false,
          error: `Failed to save "${doc.uri.fsPath}": ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`,
        };
      }
    }

    proposal.status = "applied";
    this.onProposalUpdatedEmitter.fire(proposal);

    vscode.window.showInformationMessage(
      `✓ Successfully applied NexaMind edits to ${fileCount} file(s).`,
    );

    return { success: true };
  }

  /**
   * Rejects proposal and leaves workspace files unchanged.
   */
  public async rejectProposal(proposalId: string): Promise<void> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      return;
    }

    proposal.status = "rejected";
    this.onProposalUpdatedEmitter.fire(proposal);

    vscode.window.showInformationMessage(
      "NexaMind proposed edits were rejected. Workspace files remain unchanged.",
    );
  }
}
