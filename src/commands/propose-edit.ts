import * as vscode from "vscode";
import type { NexaMindChatViewProvider } from "../views/chat.view";
import { STRUCTURED_EDIT_SYSTEM_PROMPT } from "../diff/edit.parser";

export function registerProposeEditCommand(
  context: vscode.ExtensionContext,
  chatViewProvider: NexaMindChatViewProvider,
): void {
  const disposable = vscode.commands.registerCommand(
    "nexamind.proposeEdit",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage(
          "Please open a file to request a code modification proposal.",
        );
        return;
      }

      const input = await vscode.window.showInputBox({
        title: "Propose Code Edit",
        prompt: "Describe the change you want NexaMind to propose for this file:",
        placeHolder: "e.g., Add try/catch error handling around async operations",
        ignoreFocusOut: true,
      });

      if (!input || !input.trim()) {
        return;
      }

      await vscode.commands.executeCommand("nexamind.chatView.focus");
      await chatViewProvider.askQuestionWithContext(
        `Please propose the following code changes:\n${input.trim()}`,
        STRUCTURED_EDIT_SYSTEM_PROMPT,
      );
    },
  );

  context.subscriptions.push(disposable);
}
