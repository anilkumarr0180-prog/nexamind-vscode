# NexaMind AI for Visual Studio Code

NexaMind AI is an intelligent coding assistant for Visual Studio Code. It integrates with your workspace to answer questions about code, explain complex logic, and generate structured code modification proposals that you can visually inspect and approve using VS Code's native diff viewer before any changes are written to disk.

---

## Key Features

- **Activity Bar & Chat Sidebar:** Dedicated interactive chat interface with token-by-token streaming, progress status badges, step-by-step execution plans, and source citations.
- **Context-Aware Code Assistance:**
  - `NexaMind: Ask About Code`: Query the active file with bounded context.
  - `NexaMind: Explain Selection`: Break down selected code logic and algorithmic complexity.
  - `NexaMind: Propose Code Edit`: Request targeted code refactorings, bug fixes, or enhancements.
- **Structured Diff Review & Human-in-the-Loop:**
  - Proposed code modifications are rendered in VS Code's side-by-side diff editor (`vscode.diff`) before application.
  - Never modifies files automatically. Changes require explicit confirmation (`✓ Apply Changes`).
  - Stale-file conflict detection prevents accidental overwrites if files changed on disk or in the editor while a proposal was pending.
  - Path traversal and symbolic-link boundary checks fail closed if proposed edits resolve outside the workspace root.
- **Security & Secret Filtering:**
  - Automatically excludes `.env*`, private keys (`.pem`, `.key`, `id_rsa`), certificates, credentials, `.git`, `node_modules`, and build artifacts from workspace context.
  - Inspects file content for private key markers and excludes matching files.
  - Bounded character budgets and active editor selections prevent accidental context overload.
- **Secure Browser-Based Authentication:**
  - Standards-compliant OAuth 2.0 PKCE flow (RFC 7636 with S256 code challenge).
  - Credentials stored securely in your operating system's keychain via VS Code `SecretStorage`.
  - Automatic background token renewal with concurrency mutex locks.
  - Hardened chat webview with per-render cryptographic nonce Content Security Policy (CSP).

---

## Prerequisites

Before using the extension, ensure you have:

1. **A NexaMind Account:** Register or sign in at the official NexaMind web application:
   [https://nexamind-frontend.vercel.app](https://nexamind-frontend.vercel.app)
2. **Account Credits:** The NexaMind backend deducts credits per AI assistant invocation (1 credit per request, with automatic refunds if backend processing encounters errors). Ensure your account has available credits.
3. **Network Connectivity:** Outbound HTTPS access to:
   - Backend API: `https://nexamind-backend-a19d.onrender.com`
   - Frontend Auth: `https://nexamind-frontend.vercel.app`

---

## Installation

1. Open **Visual Studio Code** (version `1.85.0` or higher).
2. Open the Extensions view (`Ctrl+Shift+X` on Windows/Linux or `Cmd+Shift+X` on macOS).
3. Search for `NexaMind AI` (Extension ID: `nexamind.nexamind-vscode`).
4. Click **Install**.

---

## Quick Start & First Use

### 1. Open the NexaMind Sidebar
Click the **NexaMind icon** in the VS Code Activity Bar (left-hand sidebar) or run the command:
```
View: Show NexaMind AI
```

### 2. Sign In Through Your Browser
1. In the NexaMind sidebar, click **Log in** (or run `NexaMind: Login / Configure Token` from the Command Palette).
2. Select **$(globe) Log in with Browser (Recommended)**.
3. Your default web browser will open to the NexaMind authorization page:
   ```
   https://nexamind-frontend.vercel.app/auth/vscode
   ```
4. Click **Authorize Visual Studio Code**.
5. When prompted by your browser to open Visual Studio Code, confirm the prompt.
6. VS Code will exchange the single-use PKCE authorization code and save the session tokens in your OS keychain. The sidebar header will update to show your active user profile.

*(Note: Direct email/password login and manual JWT access token input are also supported as legacy options in the login menu).*

### 3. Ask Questions About Code
1. Open any source file in your workspace.
2. Select a block of code (optional).
3. In the sidebar chat input, enter your prompt (e.g., *"Explain how this function handles edge cases"* or *"Refactor this logic to use async/await"*).
4. Click **Send** or press `Enter`.
5. The extension streams the agent's step-by-step plan and response in real time. Click **Stop** at any point to cancel streaming.

### 4. Review and Apply Proposed Code Modifications
When NexaMind generates code edits for your workspace:
1. An interactive **Proposed Code Modification** card appears in the chat.
2. Click **Review Diff** (or the individual file **Diff** button).
3. VS Code opens a native side-by-side diff editor (`Original` ↔ `Proposed`).
4. Review the highlighted additions and deletions.
5. To accept the changes, click **✓ Apply Changes** in the proposal card and confirm the modal prompt. The edits are applied atomically and the files are saved.
6. To discard the changes, click **✗ Reject**. Your workspace files remain completely untouched.

---

## Edit Safety & Boundary Protections

NexaMind implements multiple layers of guardrails before writing to workspace files:

- **Explicit Human Approval:** Edits are never applied without your direct interaction.
- **Single-Match Precision:** Replacement blocks are strictly validated. If a search block matches multiple locations or zero locations, the proposal is rejected as ambiguous.
- **Pre-Apply Stale File Checks:** Immediately before applying an approved edit, NexaMind verifies both the in-memory document state and the on-disk file bytes against the snapshot taken when the proposal was generated. If the file was modified in the interim, the proposal transitions to **Conflict / Stale ⚠️** and the operation aborts to protect your work.
- **Canonical Filesystem Boundaries:** File paths are normalized and verified via `fs.realpathSync`. Symbolic links targeting directories outside the workspace root are blocked.

---

## Configuration Reference

Customize extension behavior in VS Code Settings (`Cmd+,` or `Ctrl+,` search for `NexaMind`):

| Setting | Type | Default | Description |
|---|---|---|---|
| `nexamind.apiUrl` | `string` | `https://nexamind-backend-a19d.onrender.com/api/v1` | Base URL of the NexaMind backend API. Self-hosters can point this to a private deployment. Trailing slashes and `/api/v1` anchors are normalized automatically. |
| `nexamind.webUrl` | `string` | `https://nexamind-frontend.vercel.app` | Base URL of the NexaMind web application for browser-based PKCE authorization. |
| `nexamind.maxContextChars` | `number` | `24000` | Maximum character budget for workspace context sent to the backend agent. Values are clamped between `1000` and `30000`. |
| `nexamind.includeDiagnostics` | `boolean` | `true` | When enabled, includes up to 5 compiler/linter errors and warnings from the active editor in the agent context. |

---

## Privacy & Security Disclosures

Please review how NexaMind handles your workspace data:

### 1. Data Collected & Transmitted
- **Active Code Excerpt:** When you send a prompt with the "Include active code context" checkbox enabled, the extension collects:
  - The relative file path and programming language identifier of the active editor.
  - Selected text, or a 150-line window centered on the cursor (budgeted up to 70% of `nexamind.maxContextChars`).
  - Active compiler/linter diagnostics (if `nexamind.includeDiagnostics` is enabled).
- **Prompt Content:** Your query and the bounded workspace context are transmitted over HTTPS to the configured `nexamind.apiUrl`.
- **Untrusted Isolation:** Transmitted context is wrapped in explicit `=== UNTRUSTED WORKSPACE CONTEXT ===` delimiters with instructions instructing the AI model to treat repository code strictly as passive reference data.

### 2. Sensitive File Exclusions
The extension automatically blocks inclusion of sensitive paths and credentials:
- **Protected Directories:** `.git`, `node_modules`, `dist`, `build`, `out`, `.next`, `.cache`, `.gemini`, `.vscode`, `.idea`, `coverage`.
- **Sensitive Files:** `.env*`, `id_rsa*`, `id_ecdsa*`, `id_ed25519*`, `*.pem`, `*.key`, `*.pkcs12`, `*.pfx`, `*.p12`, `*.cer`, `*.crt`, `*.keystore`, and any filename containing `secret`, `credential`, `token`, or `service-account`.
- **Pattern Matching:** Files containing private key headers (`-----BEGIN ... PRIVATE KEY-----`) are automatically detected and omitted.

### 3. Backend Processing & AI Provider Handling
- **AI Processing:** The NexaMind backend forwards your prompt, bounded context, and system instructions to the configured AI provider (such as Groq or a self-hosted LLM) to generate responses and code proposals.
- **Provider Retention:** Prompts and code excerpts transmitted to third-party AI providers are subject to the specific data-retention and privacy terms of the configured provider. NexaMind does not make representations regarding third-party model training policies.
- **Data Retention:** Ad-hoc requests sent from the VS Code extension do not persist messages to the persistent conversation repository in the NexaMind database unless explicitly linked to an existing conversation identifier. Backend server logs may record standard request metadata (timestamp, HTTP status, endpoint, user ID).

### 4. Credential Storage
- JWT access tokens and refresh tokens are stored exclusively in VS Code's `SecretStorage` service, backed by the operating system keychain (Apple Keychain, Windows Credential Manager, or Linux Secret Service/libsecret).
- Tokens and secrets are never stored in plain-text workspace configuration files or exposed to the webview DOM.

---

## Troubleshooting

### Browser Login Doesn't Return to VS Code
- **Cause:** Your browser or popup blocker may have intercepted the custom protocol redirect (`vscode://nexamind.nexamind-vscode/auth`).
- **Fix:** On the authorization success screen in your browser, click the fallback link: *"Click here if VS Code didn't open automatically"*. Alternatively, verify that your browser has permission to open Visual Studio Code protocol handlers.

### "Failed to reach NexaMind API" (Cold Starts / Timeouts)
- **Cause:** The default cloud backend is hosted on a free/shared tier (Render) which spins down after periods of inactivity.
- **Fix:** Initial requests may take 30–60 seconds while the backend service warms up. Open the web application at [https://nexamind-frontend.vercel.app](https://nexamind-frontend.vercel.app) to trigger container wake-up, or retry your request after 30 seconds.

### Session Expired (HTTP 401)
- **Cause:** Access tokens expire after 15 minutes. While renewable sessions auto-renew in the background, manual JWT entries or revoked sessions require re-authentication.
- **Fix:** Run `NexaMind: Login / Configure Token` from the Command Palette and sign in with the browser to establish an auto-renewing session.

### "Insufficient credit balance" (HTTP 402)
- **Cause:** Your NexaMind account balance has reached 0 credits.
- **Fix:** Sign in to the web application at [https://nexamind-frontend.vercel.app](https://nexamind-frontend.vercel.app) to review your usage and replenish account credits.

### Custom Backend / Self-Hosted Configuration
- If deploying your own NexaMind backend:
  1. Set `nexamind.apiUrl` in VS Code Settings to `https://your-api-domain.com/api/v1`.
  2. Set `nexamind.webUrl` to `https://your-web-domain.com`.
  3. Ensure your backend environment configures `CORS_ORIGINS` to allow your web application origin and `VSCODE_ALLOWED_CALLBACK_URIS` to include `vscode://nexamind.nexamind-vscode/auth`.

---

## Commands Reference

Access these commands from the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) or editor context menus:

| Command | Title | Description |
|---|---|---|
| `nexamind.ask` | `NexaMind: Ask About Code` | Query the assistant with current file context. |
| `nexamind.explain` | `NexaMind: Explain Selection` | Explain logic of highlighted code. |
| `nexamind.proposeEdit` | `NexaMind: Propose Code Edit` | Request structured modifications for active file. |
| `nexamind.reviewDiff` | `NexaMind: Review Proposed Diff` | Open side-by-side diff comparison for a proposal. |
| `nexamind.applyProposal` | `NexaMind: Apply Proposed Edit` | Apply approved changes to workspace files. |
| `nexamind.rejectProposal` | `NexaMind: Reject Proposed Edit` | Discard pending code modification proposal. |
| `nexamind.login` | `NexaMind: Login / Configure Token` | Authenticate via browser PKCE or direct credentials. |
| `nexamind.logout` | `NexaMind: Logout` | Revoke session and purge local credentials. |
| `nexamind.clearChat` | `NexaMind: Clear Chat History` | Reset the sidebar chat conversation view. |

---

## License

This project is licensed under the MIT License. See the `LICENSE` file included in this distribution for full license terms.
