export class Uri {
  public fsPath: string;
  public path: string;
  public scheme: string;
  public query: string;
  public authority: string;

  constructor(fsPath: string, scheme = "file", query = "", authority = "", path?: string) {
    this.fsPath = fsPath;
    this.scheme = scheme;
    this.query = query;
    this.authority = authority;
    this.path = path !== undefined ? path : fsPath;
  }

  public toString(): string {
    const authPart = this.authority ? `//${this.authority}` : "";
    return `${this.scheme}:${authPart}${this.path}${this.query ? "?" + this.query : ""}`;
  }

  public static file(path: string): Uri {
    return new Uri(path, "file", "", "", path);
  }

  public static parse(val: string): Uri {
    try {
      const parsed = new URL(val);
      const scheme = parsed.protocol.replace(/:$/, "");
      const authority = parsed.host;
      const path = parsed.pathname;
      const query = parsed.search.replace(/^\?/, "");
      return new Uri(path, scheme, query, authority, path);
    } catch {
      const parts = val.split("?");
      const schemeAndPath = parts[0];
      const query = parts[1] || "";
      const schemeMatch = schemeAndPath.match(/^([a-zA-Z0-9_-]+):(?:\/\/)?(.*)$/);
      if (schemeMatch) {
        return new Uri(schemeMatch[2], schemeMatch[1], query, "", schemeMatch[2]);
      }
      return new Uri(val, "file", query, "", val);
    }
  }
}

export class Position {
  constructor(public readonly line: number, public readonly character: number) {}
}

export class Range {
  public readonly start: Position;
  public readonly end: Position;

  constructor(
    startLineOrPos: number | Position,
    startCharOrPos: number | Position,
    endLine?: number,
    endChar?: number,
  ) {
    if (typeof startLineOrPos === "number") {
      this.start = new Position(startLineOrPos, startCharOrPos as number);
      this.end = new Position(endLine ?? startLineOrPos, endChar ?? (startCharOrPos as number));
    } else {
      this.start = startLineOrPos;
      this.end = startCharOrPos as Position;
    }
  }
}

export class WorkspaceEdit {
  public readonly entries = new Map<string, Array<{ range: Range; newText: string }>>();

  public replace(uri: Uri, range: Range, newText: string): void {
    const key = uri.toString();
    const list = this.entries.get(key) || [];
    list.push({ range, newText });
    this.entries.set(key, list);
  }
}

export interface MockDocument {
  uri: Uri;
  getText: (range?: Range) => string;
  positionAt: (offset: number) => Position;
  save: () => Promise<boolean>;
  lineCount: number;
}

// In-memory test virtual filesystem
export const mockFilesystem = new Map<string, string>();

export const workspace = {
  workspaceFolders: [{ uri: Uri.file("/test-workspace") }],
  getConfiguration: (_section?: string) => ({
    get: (key: string, defaultValue: any) => defaultValue,
  }),
  getWorkspaceFolder: (_uri: Uri) => ({ uri: Uri.file("/test-workspace"), name: "test-workspace" }),
  registerTextDocumentContentProvider: () => ({ dispose: () => {} }),
  fs: {
    readFile: async (uri: Uri) => {
      const content = mockFilesystem.get(uri.fsPath);
      if (content === undefined) {
        throw new Error(`File not found: ${uri.fsPath}`);
      }
      return new TextEncoder().encode(content);
    },
    writeFile: async (uri: Uri, content: Uint8Array) => {
      mockFilesystem.set(uri.fsPath, new TextDecoder().decode(content));
    },
  },
  openTextDocument: async (uri: Uri): Promise<MockDocument> => {
    const content = mockFilesystem.get(uri.fsPath);
    if (content === undefined) {
      throw new Error(`File not found: ${uri.fsPath}`);
    }
    return {
      uri,
      getText: () => mockFilesystem.get(uri.fsPath) || "",
      positionAt: (offset: number) => new Position(0, offset),
      save: async () => true,
      lineCount: (content.match(/\n/g) || []).length + 1,
    };
  },
  applyEdit: async (edit: WorkspaceEdit): Promise<boolean> => {
    for (const [uriKey, edits] of edit.entries.entries()) {
      for (const e of edits) {
        // Find matching path in mockFilesystem
        for (const fsPath of mockFilesystem.keys()) {
          if (uriKey.includes(fsPath)) {
            mockFilesystem.set(fsPath, e.newText);
          }
        }
      }
    }
    return true;
  },
};

export let mockConfirmationResponse = "Apply Changes";

export const window = {
  activeTextEditor: undefined,
  showInformationMessage: async (_msg: string, ...args: any[]) => {
    return mockConfirmationResponse;
  },
  showWarningMessage: async () => {},
  showErrorMessage: async () => {},
  showInputBox: async () => undefined,
  showQuickPick: async () => undefined,
  onDidChangeActiveTextEditor: () => ({ dispose: () => {} }),
  onDidChangeTextEditorSelection: () => ({ dispose: () => {} }),
  registerUriHandler: (_handler: any) => ({ dispose: () => {} }),
};

export const commands = {
  registerCommand: () => ({ dispose: () => {} }),
  executeCommand: async () => {},
};

export const languages = {
  getDiagnostics: () => [],
};

export class EventEmitter<T> {
  private listeners: Array<(e: T) => any> = [];
  public event = (listener: (e: T) => any) => {
    this.listeners.push(listener);
    return { dispose: () => {} };
  };
  public fire(data: T): void {
    for (const l of this.listeners) {
      l(data);
    }
  }
}

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export class MockSecretStorage {
  private storeMap = new Map<string, string>();
  private onDidChangeEmitter = new EventEmitter<{ key: string }>();
  public onDidChange = this.onDidChangeEmitter.event;

  public async get(key: string): Promise<string | undefined> {
    return this.storeMap.get(key);
  }

  public async store(key: string, value: string): Promise<void> {
    this.storeMap.set(key, value);
    this.onDidChangeEmitter.fire({ key });
  }

  public async delete(key: string): Promise<void> {
    this.storeMap.delete(key);
    this.onDidChangeEmitter.fire({ key });
  }

  // Helper for test assertions
  public dump(): Record<string, string> {
    return Object.fromEntries(this.storeMap.entries());
  }

  // Simulate remote modification from another window
  public simulateExternalChange(key: string, value?: string): void {
    if (value === undefined) {
      this.storeMap.delete(key);
    } else {
      this.storeMap.set(key, value);
    }
    this.onDidChangeEmitter.fire({ key });
  }
}

export const env = {
  uriScheme: "vscode",
  openExternal: async (_uri: Uri): Promise<boolean> => true,
};
