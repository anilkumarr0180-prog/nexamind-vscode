import assert from "node:assert";
import * as vscode from "vscode";
import { getNonce, NexaMindChatViewProvider } from "../src/views/chat.view";

export function runWebviewCspTests(): void {
  console.log("[Test Suite] Webview Content Security Policy (CSP)");

  // 1. Nonce Generation Entropy & Security
  console.log("  Testing nonce generation security & entropy...");
  const nonce1 = getNonce();
  assert.ok(nonce1 && typeof nonce1 === "string", "Nonce must be a non-empty string");
  assert.ok(nonce1.length >= 22, `Nonce must have adequate length (got ${nonce1.length})`);
  assert.match(nonce1, /^[A-Za-z0-9+/=]+$/, "Nonce must be valid base64");

  const nonces = new Set<string>();
  const iterations = 200;
  for (let i = 0; i < iterations; i++) {
    const n = getNonce();
    assert.strictEqual(nonces.has(n), false, `Nonce collision detected at iteration ${i}`);
    nonces.add(n);
  }
  assert.strictEqual(nonces.size, iterations, "Every generated nonce must be unique");

  // Mock dependencies for NexaMindChatViewProvider
  const mockExtensionUri = vscode.Uri.file("/mock/extension/path");
  const mockAuthManager: any = {
    onAuthStateChanged: () => ({ dispose: () => {} }),
    getCurrentUser: () => null,
  };
  const mockClient: any = {};
  const mockProposalManager: any = {
    onProposalUpdated: () => ({ dispose: () => {} }),
  };

  const provider = new NexaMindChatViewProvider(
    mockExtensionUri,
    mockAuthManager,
    mockClient,
    mockProposalManager,
  );

  const mockWebview: any = {
    cspSource: "vscode-webview:",
    asWebviewUri: (uri: any) => uri,
  };

  // 2. CSP Meta Tag Presence and Parsing
  console.log("  Testing CSP meta tag presence and directives...");
  const html = provider.getHtmlForWebview(mockWebview);

  const cspMetaMatch = html.match(
    /<meta\s+http-equiv=["']Content-Security-Policy["']\s+content="([^"]+)"\s*\/?>/i,
  );
  assert.ok(cspMetaMatch, "Webview HTML must include a Content-Security-Policy meta tag");

  const cspContent = cspMetaMatch[1];

  // Parse directives
  const directives = new Map<string, string[]>();
  cspContent.split(";").forEach((part) => {
    const trimmed = part.trim();
    if (!trimmed) return;
    const tokens = trimmed.split(/\s+/);
    const directiveName = tokens[0].toLowerCase();
    const directiveValues = tokens.slice(1);
    directives.set(directiveName, directiveValues);
  });

  // Verify default-src 'none'
  assert.ok(directives.has("default-src"), "CSP must define default-src");
  assert.deepStrictEqual(directives.get("default-src"), ["'none'"], "default-src must be 'none'");

  // Verify connect-src 'none' (webview does not make direct external network calls)
  assert.ok(directives.has("connect-src"), "CSP must define connect-src");
  assert.deepStrictEqual(directives.get("connect-src"), ["'none'"], "connect-src must be 'none'");

  // 3. Script-src Policy: Nonce enforcement and prohibition of unsafe keywords
  console.log("  Testing script-src policy and unsafe keyword prohibition...");
  assert.ok(directives.has("script-src"), "CSP must define script-src");
  const scriptSrcValues = directives.get("script-src") || [];

  // MUST NOT allow unsafe-eval or unsafe-inline for scripts
  assert.strictEqual(
    scriptSrcValues.includes("'unsafe-eval'"),
    false,
    "script-src MUST NOT permit 'unsafe-eval'",
  );
  assert.strictEqual(
    scriptSrcValues.includes("'unsafe-inline'"),
    false,
    "script-src MUST NOT permit 'unsafe-inline'",
  );

  // MUST contain a valid nonce in script-src
  const scriptNonceToken = scriptSrcValues.find((val) => val.startsWith("'nonce-"));
  assert.ok(scriptNonceToken, "script-src must include a 'nonce-...' token");
  const extractedNonce = scriptNonceToken.replace(/^'nonce-/, "").replace(/'$/, "");
  assert.ok(extractedNonce.length >= 22, "Extracted script nonce must have valid length");

  // 4. Script Tags Nonce Association
  console.log("  Testing script tags nonce association...");
  const scriptTags = html.match(/<script\b[^>]*>/gi) || [];
  assert.ok(scriptTags.length > 0, "Webview HTML must contain at least one <script> tag");

  for (const tag of scriptTags) {
    const nonceMatch = tag.match(/nonce=["']([^"']+)["']/i);
    assert.ok(nonceMatch, `Script tag must declare a nonce: ${tag}`);
    assert.strictEqual(
      nonceMatch[1],
      extractedNonce,
      `Script tag nonce (${nonceMatch[1]}) must match CSP header nonce (${extractedNonce})`,
    );
  }

  // 5. Style, Font, and Image Directives
  console.log("  Testing style, font, and image source directives...");
  assert.ok(directives.has("style-src"), "CSP must define style-src");
  const styleSrcValues = directives.get("style-src") || [];
  assert.ok(
    styleSrcValues.includes(mockWebview.cspSource),
    "style-src must include webview.cspSource",
  );
  assert.ok(
    styleSrcValues.includes("'unsafe-inline'"),
    "style-src must include 'unsafe-inline' for VS Code theme variables",
  );

  // Check style tag nonce
  const styleTagMatch = html.match(/<style\b[^>]*nonce=["']([^"']+)["'][^>]*>/i);
  assert.ok(styleTagMatch, "<style> block must have a valid nonce attribute");
  assert.strictEqual(
    styleTagMatch[1],
    extractedNonce,
    "Style tag nonce must match the render nonce",
  );

  assert.ok(directives.has("font-src"), "CSP must define font-src");
  assert.ok(
    directives.get("font-src")?.includes(mockWebview.cspSource),
    "font-src must include webview.cspSource",
  );

  assert.ok(directives.has("img-src"), "CSP must define img-src");
  const imgSrcValues = directives.get("img-src") || [];
  assert.ok(imgSrcValues.includes(mockWebview.cspSource), "img-src must include webview.cspSource");
  assert.ok(imgSrcValues.includes("https:"), "img-src must allow secure https: images");
  assert.ok(imgSrcValues.includes("data:"), "img-src must allow data: URIs");

  // 6. Per-Render Nonce Freshness
  console.log("  Testing per-render nonce freshness...");
  const html1 = provider.getHtmlForWebview(mockWebview);
  const html2 = provider.getHtmlForWebview(mockWebview);
  const html3 = provider.getHtmlForWebview(mockWebview);

  const extractNonceFromHtml = (h: string): string => {
    const m = h.match(/script-src\s+'nonce-([^']+)'/);
    return m ? m[1] : "";
  };

  const n1 = extractNonceFromHtml(html1);
  const n2 = extractNonceFromHtml(html2);
  const n3 = extractNonceFromHtml(html3);

  assert.ok(n1 && n2 && n3, "All renderings must produce nonces");
  assert.notStrictEqual(n1, n2, "Consecutive renders must produce distinct nonces (1 vs 2)");
  assert.notStrictEqual(n2, n3, "Consecutive renders must produce distinct nonces (2 vs 3)");
  assert.notStrictEqual(n1, n3, "Consecutive renders must produce distinct nonces (1 vs 3)");

  // 7. Absence of Inline Event Handlers & Dangerous Constructs
  console.log("  Testing absence of inline event handlers...");
  assert.strictEqual(
    /onclick\s*=/i.test(html),
    false,
    "Webview HTML must not contain inline onclick handlers",
  );
  assert.strictEqual(
    /onload\s*=/i.test(html),
    false,
    "Webview HTML must not contain inline onload handlers",
  );
  assert.strictEqual(
    /onerror\s*=/i.test(html),
    false,
    "Webview HTML must not contain inline onerror handlers",
  );
  assert.strictEqual(
    /javascript:/i.test(html),
    false,
    "Webview HTML must not contain javascript: URIs",
  );

  // 8. Event Delegation & DOM Attributes Verification
  console.log("  Testing event delegation data attributes...");
  assert.ok(
    html.includes('data-action="reviewDiff"'),
    "HTML must include data-action for reviewDiff buttons",
  );
  assert.ok(
    html.includes('data-action="applyProposal"'),
    "HTML must include data-action for applyProposal buttons",
  );
  assert.ok(
    html.includes('data-action="rejectProposal"'),
    "HTML must include data-action for rejectProposal buttons",
  );
  assert.ok(
    html.includes("messagesContainer.addEventListener(\"click\""),
    "Script must attach delegated click listener to messagesContainer",
  );

  // 9. UI Structure & Theme Variables
  console.log("  Testing UI structure and VS Code theme variables...");
  assert.ok(html.includes("var(--vscode-sideBar-background)"), "Must use VS Code theme variables");
  assert.ok(html.includes("acquireVsCodeApi()"), "Must acquire VS Code API");
  assert.ok(html.includes('id="messagesContainer"'), "Must include messagesContainer");
  assert.ok(html.includes('id="promptInput"'), "Must include promptInput");
  assert.ok(html.includes('id="sendBtn"'), "Must include sendBtn");

  console.log("  ✓ All 9 Webview Content Security Policy tests passed successfully.");
}
