import assert from "node:assert";
import { isPathExcluded, containsSensitiveData } from "../src/context/secret.filter";

export function runSecretFilterTests(): void {
  console.log("[Test Suite] Secret & Sensitive File Filter");

  // 1. Blocked dot-env files
  assert.strictEqual(isPathExcluded(".env"), true);
  assert.strictEqual(isPathExcluded(".env.local"), true);
  assert.strictEqual(isPathExcluded(".env.production"), true);
  assert.strictEqual(isPathExcluded("config/.env.test"), true);

  // 2. Blocked private keys and certs
  assert.strictEqual(isPathExcluded("id_rsa"), true);
  assert.strictEqual(isPathExcluded("id_ed25519"), true);
  assert.strictEqual(isPathExcluded("keys/server.key"), true);
  assert.strictEqual(isPathExcluded("certs/tls.pem"), true);
  assert.strictEqual(isPathExcluded("auth/service-account.json"), true);
  assert.strictEqual(isPathExcluded("credentials.json"), true);
  assert.strictEqual(isPathExcluded("jwt-secret.txt"), true);

  // 3. Blocked directories
  assert.strictEqual(isPathExcluded("node_modules/express/index.js"), true);
  assert.strictEqual(isPathExcluded(".git/config"), true);
  assert.strictEqual(isPathExcluded("dist/app.js"), true);
  assert.strictEqual(isPathExcluded("build/bundle.js"), true);
  assert.strictEqual(isPathExcluded(".gemini/antigravity-ide/settings.json"), true);

  // 4. Allowed source files
  assert.strictEqual(isPathExcluded("src/app.ts"), false);
  assert.strictEqual(isPathExcluded("src/middleware/auth.ts"), false);
  assert.strictEqual(isPathExcluded("package.json"), false);
  assert.strictEqual(isPathExcluded("README.md"), false);
  assert.strictEqual(isPathExcluded("frontend/src/App.tsx"), false);

  // 5. Sensitive data content inspection
  assert.strictEqual(
    containsSensitiveData("const x = 42;\nexport default x;"),
    false,
  );
  assert.strictEqual(
    containsSensitiveData("-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----"),
    true,
  );

  console.log("  ✓ Secret and sensitive file filter tests passed.");
}
