import * as vscode from "vscode";
import { AuthManager, NexaMindUriHandler } from "./auth/auth.manager";
import { NexaMindClient } from "./client/nexamind.client";
import { NexaMindChatViewProvider } from "./views/chat.view";
import { ProposedContentProvider } from "./diff/proposal.provider";
import { ProposalManager } from "./diff/proposal.manager";
import { registerAskCommand } from "./commands/ask";
import { registerExplainCommand } from "./commands/explain";
import { registerProposeEditCommand } from "./commands/propose-edit";

export interface NexaMindExtensionApi {
  authManager: AuthManager;
  client: NexaMindClient;
  contentProvider: ProposedContentProvider;
  proposalManager: ProposalManager;
  chatViewProvider: NexaMindChatViewProvider;
}

export async function activate(context: vscode.ExtensionContext): Promise<NexaMindExtensionApi> {
  // 1. Initialize core managers and providers
  const authManager = new AuthManager(context.secrets);
  context.subscriptions.push(authManager);

  const client = new NexaMindClient(authManager);
  const contentProvider = new ProposedContentProvider();
  const proposalManager = new ProposalManager(contentProvider);

  // 2. Register URI handler for browser PKCE login handoff
  const uriHandler = new NexaMindUriHandler(authManager);
  context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));

  // 3. Register virtual document content provider for nexamind-proposed://
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      ProposedContentProvider.scheme,
      contentProvider,
    ),
  );

  // 4. Register Webview View Provider
  const chatViewProvider = new NexaMindChatViewProvider(
    context.extensionUri,
    authManager,
    client,
    proposalManager,
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      NexaMindChatViewProvider.viewType,
      chatViewProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  // 5. Register user commands
  registerAskCommand(context, chatViewProvider);
  registerExplainCommand(context, chatViewProvider);
  registerProposeEditCommand(context, chatViewProvider);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "nexamind.reviewDiff",
      async (proposalId: string, fileIndex?: number) => {
        await proposalManager.openDiffPreview(proposalId, fileIndex || 0);
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "nexamind.applyProposal",
      async (proposalId: string) => {
        await proposalManager.applyProposal(proposalId);
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "nexamind.rejectProposal",
      async (proposalId: string) => {
        await proposalManager.rejectProposal(proposalId);
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nexamind.login", async () => {
      await authManager.promptLogin();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nexamind.logout", async () => {
      await authManager.logout();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("nexamind.clearChat", () => {
      chatViewProvider.clearChat();
    }),
  );

  // 6. Background session check (non-blocking)
  void authManager.validateSession().then((result) => {
    if (result.valid && result.user) {
      console.log(`[NexaMind] Authenticated as ${result.user.email} (${result.sessionType || "unknown"} session)`);
    } else if (result.expired) {
      vscode.window.showWarningMessage(
        "NexaMind session has expired. Run 'NexaMind: Login / Configure Token' to reconnect.",
      );
    }
  });

  return {
    authManager,
    client,
    contentProvider,
    proposalManager,
    chatViewProvider,
  };
}

export function deactivate(): void {
  // Cleanup if needed
}
