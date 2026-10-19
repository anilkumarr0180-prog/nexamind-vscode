import * as vscode from "vscode";
import * as crypto from "crypto";
import { getConfig } from "../config";
import type { NexamindUser } from "../types";

export const SECRET_KEY_TOKEN = "nexamind.jwt_access_token";
export const SECRET_KEY_REFRESH_TOKEN = "nexamind.jwt_refresh_token";

export type SessionType = "pkce" | "legacy" | "none";

export interface SessionValidationResult {
  valid: boolean;
  user?: NexamindUser;
  expired?: boolean;
  error?: string;
  sessionType?: SessionType;
}

export interface PendingPkceFlow {
  state: string;
  verifier: string;
  redirectUri: string;
  expiresAt: number;
}

/**
 * Generates an RFC 7636 compliant PKCE code_verifier (43 base64url characters).
 */
export function generatePkceVerifier(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/**
 * Computes an RFC 7636 compliant S256 code_challenge from a verifier.
 */
export function generatePkceChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Generates an unpredictable random state parameter for CSRF mitigation.
 */
export function generateState(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Checks whether a JWT is expired or within the expiration skew window.
 */
export function isJwtExpired(token: string, skewSeconds = 60): boolean {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return true;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (typeof payload.exp !== "number") return false;
    return Date.now() >= (payload.exp - skewSeconds) * 1000;
  } catch {
    return true;
  }
}

/**
 * Authentication manager for NexaMind VS Code extension.
 * Features:
 * - Browser-based PKCE login flow (RFC 7636 S256)
 * - Secure multi-key VS Code SecretStorage (OS Keychain / DPAPI / libsecret)
 * - Automatic background token renewal with in-flight Promise mutex
 * - Cross-window synchronization via vscode.secrets.onDidChange
 * - Distinguishes renewable PKCE sessions from legacy manual JWT sessions
 * - Secure remote session revocation upon logout
 */
export class AuthManager implements vscode.Disposable {
  private cachedUser: NexamindUser | null = null;
  private pendingPkceFlow: PendingPkceFlow | null = null;
  private refreshPromise: Promise<string | undefined> | null = null;
  private readonly disposables: vscode.Disposable[] = [];

  private readonly onAuthStateChangedEmitter = new vscode.EventEmitter<NexamindUser | null>();
  public readonly onAuthStateChanged = this.onAuthStateChangedEmitter.event;

  constructor(private readonly secrets: vscode.SecretStorage) {
    // Cross-window synchronization: listen for secrets changes across VS Code windows
    if (typeof this.secrets?.onDidChange === "function") {
      this.disposables.push(
        this.secrets.onDidChange(async (e) => {
          if (e.key === SECRET_KEY_TOKEN || e.key === SECRET_KEY_REFRESH_TOKEN) {
            await this.handleSecretChange();
          }
        }),
      );
    }
  }

  /**
   * Responds to SecretStorage mutations made by this or another VS Code process/window.
   */
  private async handleSecretChange(): Promise<void> {
    const token = await this.secrets.get(SECRET_KEY_TOKEN);
    if (!token) {
      this.cachedUser = null;
      this.onAuthStateChangedEmitter.fire(null);
    } else if (!this.refreshPromise) {
      // Quietly refresh local user session without surfacing false error toasts
      void this.validateSession(token, false);
    }
  }

  /**
   * Determines whether the current session is renewable (PKCE) or manual (legacy).
   */
  public async getSessionType(): Promise<SessionType> {
    const token = await this.secrets.get(SECRET_KEY_TOKEN);
    if (!token) return "none";
    const refresh = await this.secrets.get(SECRET_KEY_REFRESH_TOKEN);
    return refresh ? "pkce" : "legacy";
  }

  /**
   * Retrieves the stored access token securely.
   * Automatically executes renewal if the token is expired or expiring within 60s.
   */
  public async getToken(): Promise<string | undefined> {
    const token = await this.secrets.get(SECRET_KEY_TOKEN);
    if (!token) {
      return undefined;
    }

    const trimmed = token.trim();
    if (isJwtExpired(trimmed)) {
      const refreshToken = await this.secrets.get(SECRET_KEY_REFRESH_TOKEN);
      if (refreshToken) {
        const renewed = await this.refreshSession();
        if (renewed) {
          return renewed;
        }
      }
    }

    return trimmed || undefined;
  }

  /**
   * Securely saves an access token into SecretStorage (manual / legacy entry).
   * Clears any existing refresh token to accurately flag as legacy session.
   */
  public async setToken(token: string): Promise<void> {
    const trimmed = token.trim();
    if (!trimmed) {
      await this.logout();
      return;
    }
    await this.secrets.store(SECRET_KEY_TOKEN, trimmed);
    await this.secrets.delete(SECRET_KEY_REFRESH_TOKEN);
  }

  /**
   * Legacy method for clearing local session.
   */
  public async clearToken(): Promise<void> {
    await this.logout();
  }

  /**
   * Clears local secrets and caches without calling the backend.
   */
  public async clearSecretsAndState(): Promise<void> {
    await this.secrets.delete(SECRET_KEY_TOKEN);
    await this.secrets.delete(SECRET_KEY_REFRESH_TOKEN);
    this.cachedUser = null;
    this.onAuthStateChangedEmitter.fire(null);
  }

  /**
   * Returns the cached user object if active.
   */
  public getCurrentUser(): NexamindUser | null {
    return this.cachedUser;
  }

  /**
   * Initiates browser-based PKCE authentication.
   * Generates code_verifier, code_challenge, state, stores in-memory flow state,
   * and opens the trusted NexaMind web authorization URL.
   */
  public async loginWithBrowser(): Promise<boolean> {
    const scheme = vscode.env.uriScheme || "vscode";
    const redirectUri = `${scheme}://nexamind.nexamind-vscode/auth`;

    const verifier = generatePkceVerifier();
    const challenge = generatePkceChallenge(verifier);
    const state = generateState();

    // Store pending PKCE state with 5-minute expiration
    this.pendingPkceFlow = {
      state,
      verifier,
      redirectUri,
      expiresAt: Date.now() + 5 * 60 * 1000,
    };

    const { webUrl } = getConfig();
    const params = new URLSearchParams({
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      redirect_uri: redirectUri,
    });

    const authUrl = `${webUrl}/auth/vscode?${params.toString()}`;
    vscode.window.showInformationMessage(
      "Opening browser to authenticate with NexaMind...",
    );

    await vscode.env.openExternal(vscode.Uri.parse(authUrl));
    return true;
  }

  /**
   * Handles incoming protocol URIs forwarded by VS Code UriHandler.
   * Validates scheme, authority, path, state, and authorization code before exchanging it.
   */
  public async handleUriCallback(uri: vscode.Uri): Promise<boolean> {
    const scheme = (uri.scheme || "").toLowerCase();
    const currentScheme = (vscode.env.uriScheme || "vscode").toLowerCase();
    if (scheme !== currentScheme && scheme !== "vscode" && scheme !== "vscode-insiders") {
      vscode.window.showErrorMessage(
        `Invalid callback scheme: ${uri.scheme}. Expected ${vscode.env.uriScheme}`,
      );
      return false;
    }

    const authority = (uri.authority || "").toLowerCase();
    if (authority !== "nexamind.nexamind-vscode") {
      vscode.window.showErrorMessage(
        `Invalid callback authority: ${uri.authority}. Expected nexamind.nexamind-vscode`,
      );
      return false;
    }

    const path = (uri.path || "").replace(/\/+$/, "");
    if (path !== "/auth" && path !== "/callback") {
      vscode.window.showErrorMessage(
        `Invalid callback path: ${uri.path}. Expected /auth or /callback`,
      );
      return false;
    }

    const params = new URLSearchParams(uri.query);
    const error = params.get("error");
    if (error) {
      const errorDescription =
        params.get("error_description") || params.get("error") || "Authentication rejected";
      this.pendingPkceFlow = null;
      vscode.window.showErrorMessage(`NexaMind authorization failed: ${errorDescription}`);
      return false;
    }

    const code = params.get("code");
    const state = params.get("state");

    if (!this.pendingPkceFlow) {
      vscode.window.showErrorMessage(
        "No pending NexaMind login request found or already completed. Please initiate login again.",
      );
      return false;
    }

    if (Date.now() > this.pendingPkceFlow.expiresAt) {
      this.pendingPkceFlow = null;
      vscode.window.showErrorMessage("Login session timed out. Please try logging in again.");
      return false;
    }

    if (!state || state !== this.pendingPkceFlow.state) {
      this.pendingPkceFlow = null;
      vscode.window.showErrorMessage(
        "Invalid authentication state parameter. Possible CSRF attack detected.",
      );
      return false;
    }

    if (!code || !code.trim()) {
      this.pendingPkceFlow = null;
      vscode.window.showErrorMessage("No authorization code received from browser.");
      return false;
    }

    const { verifier, redirectUri } = this.pendingPkceFlow;
    // Clear immediately to reject any replayed callbacks
    this.pendingPkceFlow = null;

    const exchangeResult = await this.exchangePkceCode(code, verifier, redirectUri);
    if (exchangeResult.success && exchangeResult.user) {
      vscode.window.showInformationMessage(
        `Successfully authenticated with NexaMind as ${exchangeResult.user.email} (${exchangeResult.user.name})`,
      );
      return true;
    } else {
      vscode.window.showErrorMessage(
        exchangeResult.error || "Failed to exchange authorization code for session tokens.",
      );
      return false;
    }
  }

  /**
   * Exchanges an authorization code and PKCE verifier for an access token and refresh token.
   */
  public async exchangePkceCode(
    code: string,
    codeVerifier: string,
    redirectUri?: string,
  ): Promise<{ success: boolean; user?: NexamindUser; error?: string }> {
    const { apiUrl } = getConfig();
    const url = `${apiUrl}/auth/vscode/exchange`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          code: code.trim(),
          codeVerifier: codeVerifier.trim(),
          redirectUri,
        }),
      });

      const data = (await response.json()) as any;
      if (!response.ok || !data.success) {
        const errorMsg =
          data.error?.message || data.message || `Code exchange failed (HTTP ${response.status})`;
        return { success: false, error: errorMsg };
      }

      const { user: rawUser, accessToken, refreshToken } = data.data;
      if (!accessToken || typeof accessToken !== "string") {
        return { success: false, error: "Backend did not return an access token." };
      }

      // Store both access token and refresh token in SecretStorage
      await this.secrets.store(SECRET_KEY_TOKEN, accessToken);
      if (refreshToken && typeof refreshToken === "string") {
        await this.secrets.store(SECRET_KEY_REFRESH_TOKEN, refreshToken);
      }

      const user: NexamindUser = {
        id: rawUser._id || rawUser.id || rawUser.sub || "unknown",
        email: rawUser.email || "",
        name: rawUser.name || rawUser.email || "NexaMind User",
        roles: Array.isArray(rawUser.roles) ? rawUser.roles : ["USER"],
      };

      this.cachedUser = user;
      this.onAuthStateChangedEmitter.fire(user);
      return { success: true, user };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: `Could not connect to NexaMind backend at ${apiUrl}: ${msg}`,
      };
    }
  }

  /**
   * Refreshes the access token using the stored refresh token.
   * Utilizes an in-flight Promise lock to serialize concurrent requests in the same host.
   */
  public async refreshSession(): Promise<string | undefined> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      try {
        const refreshToken = await this.secrets.get(SECRET_KEY_REFRESH_TOKEN);
        if (!refreshToken || !refreshToken.trim()) {
          return undefined;
        }

        const { apiUrl } = getConfig();
        const response = await fetch(`${apiUrl}/auth/refresh`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ refreshToken: refreshToken.trim() }),
        });

        if (!response.ok) {
          const data = (await response.json().catch(() => ({}))) as any;
          const code = data?.error?.code || data?.code;
          if (
            response.status === 401 ||
            code === "REVOKED_TOKEN" ||
            code === "REPLAY_ATTACK" ||
            code === "TOKEN_EXPIRED" ||
            code === "INVALID_TOKEN"
          ) {
            // Revoked, expired, or compromised: purge local secrets and alert user
            await this.clearSecretsAndState();
            vscode.window.showWarningMessage(
              "NexaMind authentication session has expired or was revoked. Please log in again.",
            );
          }
          return undefined;
        }

        const json = (await response.json()) as any;
        const data = json.data;
        if (!data?.accessToken) {
          return undefined;
        }

        await this.secrets.store(SECRET_KEY_TOKEN, data.accessToken);
        if (data.refreshToken) {
          await this.secrets.store(SECRET_KEY_REFRESH_TOKEN, data.refreshToken);
        }

        if (data.user) {
          const rawUser = data.user;
          this.cachedUser = {
            id: rawUser._id || rawUser.id || rawUser.sub || "unknown",
            email: rawUser.email || "",
            name: rawUser.name || rawUser.email || "NexaMind User",
            roles: Array.isArray(rawUser.roles) ? rawUser.roles : ["USER"],
          };
          this.onAuthStateChangedEmitter.fire(this.cachedUser);
        }

        return data.accessToken;
      } catch (err) {
        console.error("[NexaMind] Token renewal error:", err);
        return undefined;
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }

  /**
   * Revokes the active refresh token family on the backend and clears all local secrets.
   */
  public async logout(): Promise<void> {
    const refreshToken = await this.secrets.get(SECRET_KEY_REFRESH_TOKEN);
    if (refreshToken) {
      try {
        const { apiUrl } = getConfig();
        await fetch(`${apiUrl}/auth/logout`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ refreshToken: refreshToken.trim() }),
        });
      } catch {
        // Remote logout is best-effort; always clear local credentials
      }
    }

    await this.clearSecretsAndState();
    vscode.window.showInformationMessage("Logged out from NexaMind.");
  }

  /**
   * Validates the active or provided token against GET /api/v1/auth/me.
   * If expired and refresh token exists, automatically attempts renewal.
   */
  public async validateSession(
    tokenOverride?: string,
    showErrors = true,
  ): Promise<SessionValidationResult> {
    let token = tokenOverride || (await this.getToken());
    const sessionType = await this.getSessionType();

    if (!token) {
      this.cachedUser = null;
      this.onAuthStateChangedEmitter.fire(null);
      return { valid: false, sessionType, error: "No authentication token configured." };
    }

    const { apiUrl } = getConfig();
    const url = `${apiUrl}/auth/me`;

    try {
      let response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      });

      if (response.status === 401 && !tokenOverride) {
        // Attempt renewal if PKCE session
        const renewedToken = await this.refreshSession();
        if (renewedToken) {
          token = renewedToken;
          response = await fetch(url, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${renewedToken}`,
              Accept: "application/json",
            },
          });
        }
      }

      if (response.status === 401) {
        this.cachedUser = null;
        this.onAuthStateChangedEmitter.fire(null);
        const isLegacy = sessionType === "legacy";
        return {
          valid: false,
          expired: true,
          sessionType,
          error: isLegacy
            ? "Legacy session expired. Manual access tokens expire after 15 minutes without auto-renewal. Please log in using Browser Login."
            : "Session expired. NexaMind access tokens expire after 15 minutes. Please log in again.",
        };
      }

      if (!response.ok) {
        return {
          valid: false,
          sessionType,
          error: `Authentication failed (HTTP ${response.status})`,
        };
      }

      const json = (await response.json()) as any;
      const rawUser = json.data?.user || json.data || {};
      const user: NexamindUser = {
        id: rawUser._id || rawUser.id || rawUser.sub || "unknown",
        email: rawUser.email || "",
        name: rawUser.name || rawUser.email || "NexaMind User",
        roles: Array.isArray(rawUser.roles) ? rawUser.roles : ["USER"],
      };

      this.cachedUser = user;
      this.onAuthStateChangedEmitter.fire(user);
      return { valid: true, user, sessionType };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        valid: false,
        sessionType,
        error: `Failed to connect to NexaMind backend at ${apiUrl}: ${msg}`,
      };
    }
  }

  /**
   * Direct password login fallback.
   */
  public async loginWithCredentials(
    email: string,
    password: string,
  ): Promise<{ success: boolean; user?: NexamindUser; error?: string }> {
    const { apiUrl } = getConfig();
    const url = `${apiUrl}/auth/login`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ email: email.trim(), password }),
      });

      const data = (await response.json()) as any;
      if (!response.ok || !data.success) {
        const errorMsg =
          data.error?.message || data.message || `Login failed (HTTP ${response.status})`;
        return { success: false, error: errorMsg };
      }

      const token = data.data?.accessToken;
      if (!token || typeof token !== "string") {
        return { success: false, error: "Backend did not return an access token." };
      }

      await this.setToken(token);
      const validation = await this.validateSession(token);
      return {
        success: validation.valid,
        user: validation.user,
        error: validation.error,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: `Could not connect to NexaMind backend at ${apiUrl}: ${msg}`,
      };
    }
  }

  /**
   * Prompts the user to log in via VS Code UI dialogs.
   * Prioritizes Browser-based PKCE login with auto-renewal, preserving manual token input as legacy.
   */
  public async promptLogin(): Promise<boolean> {
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: "$(globe) Log in with Browser (Recommended)",
          description: "Secure PKCE authentication with automatic token renewal",
          method: "browser",
        },
        {
          label: "$(key) Enter JWT Access Token (Legacy)",
          description: "Paste a manual JWT token (no automatic renewal)",
          method: "token",
        },
        {
          label: "$(mail) Log in with Email & Password",
          description: "Direct credential authentication",
          method: "password",
        },
      ],
      { placeHolder: "Select how you would like to authenticate with NexaMind" },
    );

    if (!choice) {
      return false;
    }

    if (choice.method === "browser") {
      return await this.loginWithBrowser();
    }

    if (choice.method === "token") {
      const token = await vscode.window.showInputBox({
        title: "NexaMind Access Token (Legacy)",
        prompt: "Paste your NexaMind JWT Access Token (Note: manual tokens do not auto-renew)",
        password: true,
        ignoreFocusOut: true,
        validateInput: (val) => (!val?.trim() ? "Token cannot be empty" : null),
      });

      if (!token) {
        return false;
      }

      await this.setToken(token);
      const check = await this.validateSession(token);
      if (check.valid && check.user) {
        vscode.window.showInformationMessage(
          `Logged in to NexaMind as ${check.user.email} (${check.user.name}) [Legacy session: auto-renewal disabled]`,
        );
        return true;
      } else {
        await this.clearSecretsAndState();
        vscode.window.showErrorMessage(check.error || "Invalid NexaMind access token.");
        return false;
      }
    }

    if (choice.method === "password") {
      const email = await vscode.window.showInputBox({
        title: "NexaMind Login",
        prompt: "Enter your NexaMind account email",
        ignoreFocusOut: true,
        validateInput: (val) => (!val || !val.includes("@") ? "Enter a valid email" : null),
      });

      if (!email) {
        return false;
      }

      const password = await vscode.window.showInputBox({
        title: "NexaMind Login",
        prompt: "Enter your NexaMind password",
        password: true,
        ignoreFocusOut: true,
        validateInput: (val) => (!val ? "Password cannot be empty" : null),
      });

      if (!password) {
        return false;
      }

      const result = await this.loginWithCredentials(email, password);
      if (result.success && result.user) {
        vscode.window.showInformationMessage(
          `Successfully authenticated with NexaMind as ${result.user.email}`,
        );
        return true;
      } else {
        vscode.window.showErrorMessage(result.error || "Login failed.");
        return false;
      }
    }

    return false;
  }

  public dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.onAuthStateChangedEmitter.dispose();
  }
}

/**
 * VS Code Protocol URI Handler for NexaMind browser login callbacks.
 * Routes vscode://nexamind.nexamind-vscode/auth to AuthManager.handleUriCallback.
 */
export class NexaMindUriHandler implements vscode.UriHandler {
  constructor(private readonly authManager: AuthManager) {}

  public async handleUri(uri: vscode.Uri): Promise<void> {
    await this.authManager.handleUriCallback(uri);
  }
}
