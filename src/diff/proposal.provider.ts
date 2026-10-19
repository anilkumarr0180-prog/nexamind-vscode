import * as vscode from "vscode";

export const PROPOSED_SCHEME = "nexamind-proposed";

/**
 * TextDocumentContentProvider providing virtual in-memory documents for side-by-side diff previews.
 */
export class ProposedContentProvider implements vscode.TextDocumentContentProvider {
  public static readonly scheme = PROPOSED_SCHEME;

  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this.onDidChangeEmitter.event;

  private readonly contentMap = new Map<string, string>();

  public setContent(uri: vscode.Uri, content: string): void {
    this.contentMap.set(uri.toString(), content);
    this.onDidChangeEmitter.fire(uri);
  }

  public removeContent(uri: vscode.Uri): void {
    this.contentMap.delete(uri.toString());
  }

  public clear(): void {
    this.contentMap.clear();
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contentMap.get(uri.toString()) ?? "";
  }
}
