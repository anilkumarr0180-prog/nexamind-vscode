import * as vscode from "vscode";
import type { NexaMindChatViewProvider } from "../views/chat.view";

export function registerAskCommand(
  context: vscode.ExtensionContext,
  chatViewProvider: NexaMindChatViewProvider,
): void {
  const disposable = vscode.commands.registerCommand("nexamind.ask", async () => {
    const input = await vscode.window.showInputBox({
      title: "Ask NexaMind AI",
      prompt: "What would you like to ask about this code?",
      placeHolder: "e.g., How does this function handle rate limiting?",
      ignoreFocusOut: true,
    });

    if (!input || !input.trim()) {
      return;
    }

    await vscode.commands.executeCommand("nexamind.chatView.focus");
    await chatViewProvider.askQuestionWithContext(input.trim());
  });

  context.subscriptions.push(disposable);
}
