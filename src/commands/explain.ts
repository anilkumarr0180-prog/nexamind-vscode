import * as vscode from "vscode";
import type { NexaMindChatViewProvider } from "../views/chat.view";

export function registerExplainCommand(
  context: vscode.ExtensionContext,
  chatViewProvider: NexaMindChatViewProvider,
): void {
  const disposable = vscode.commands.registerCommand("nexamind.explain", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      vscode.window.showInformationMessage(
        "Please select a block of code in the active editor to explain.",
      );
      return;
    }

    await vscode.commands.executeCommand("nexamind.chatView.focus");
    await chatViewProvider.askQuestionWithContext(
      "Please explain this selected code in detail. Break down its purpose, internal logic, parameter/return contracts, and any potential edge cases or bugs.",
    );
  });

  context.subscriptions.push(disposable);
}
