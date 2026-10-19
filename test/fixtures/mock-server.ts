import * as http from "http";

export class MockAgentServer {
  private server?: http.Server;
  public url = "";
  public lastRequestBody?: any;
  public lastHeaders?: http.IncomingHttpHeaders;
  public abortedCount = 0;
  public requestsReceived: string[] = [];

  public start(port = 0): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        const parsedUrl = new URL(req.url || "", `http://${req.headers.host || "127.0.0.1"}`);
        this.requestsReceived.push(`${req.method} ${parsedUrl.pathname}`);
        this.lastHeaders = req.headers;

        let bodyRaw = "";
        req.on("data", (chunk) => {
          bodyRaw += chunk;
        });

        req.on("end", () => {
          if (bodyRaw) {
            try {
              this.lastRequestBody = JSON.parse(bodyRaw);
            } catch {
              this.lastRequestBody = bodyRaw;
            }
          }

          const authHeader = req.headers.authorization || "";
          const token = authHeader.replace(/^Bearer\s+/i, "");

          // 1. Session check endpoint GET /api/v1/auth/me
          if (parsedUrl.pathname === "/api/v1/auth/me" && req.method === "GET") {
            if (token === "expired-token") {
              res.writeHead(401, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: false, message: "Token expired" }));
              return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                success: true,
                user: { id: "mock-user-1", email: "test@nexamind.ai", name: "Test User" },
              }),
            );
            return;
          }

          // 2. Stream execution endpoint POST /api/v1/agent/stream
          if (parsedUrl.pathname === "/api/v1/agent/stream" && req.method === "POST") {
            const scenario = (req.headers["x-mock-scenario"] as string) || token;

            if (scenario === "expired-token" || scenario === "simulate-401") {
              res.writeHead(401, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  error: { message: "Session expired or invalid. NexaMind tokens expire after 15 minutes. Please log in again." },
                }),
              );
              return;
            }

            if (scenario === "no-credit-token" || scenario === "simulate-402") {
              res.writeHead(402, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  error: { message: "Insufficient credit balance. Please replenish your NexaMind credits." },
                }),
              );
              return;
            }

            // Setup SSE Response
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });

            req.on("close", () => {
              if (!res.writableEnded) {
                this.abortedCount++;
              }
            });

            if (scenario === "simulate-cancellation") {
              res.write(
                `data: ${JSON.stringify({ type: "start", conversationId: "conv-abort-test" })}\n\n`,
              );
              res.write(
                `data: ${JSON.stringify({ type: "chunk", content: "Initial chunk before abort..." })}\n\n`,
              );
              // Keep open without calling res.end() to allow client abort
              return;
            }

            // Normal streaming
            res.write(
              `data: ${JSON.stringify({ type: "start", conversationId: "conv-123" })}\n\n`,
            );
            res.write(
              `data: ${JSON.stringify({ type: "status", status: "running", message: "Analyzing active context..." })}\n\n`,
            );
            res.write(
              `data: ${JSON.stringify({ type: "chunk", content: "Hello from mock agent! " })}\n\n`,
            );
            res.write(
              `data: ${JSON.stringify({ type: "chunk", content: "Everything is functioning correctly." })}\n\n`,
            );
            res.write(
              `data: ${JSON.stringify({
                type: "done",
                data: {
                  status: "completed",
                  output: "Hello from mock agent! Everything is functioning correctly.",
                },
              })}\n\n`,
            );
            res.end();
            return;
          }

          // Fallback 404
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
        });
      });

      this.server.listen(port, "127.0.0.1", () => {
        const address = this.server!.address() as any;
        this.url = `http://127.0.0.1:${address.port}/api/v1`;
        resolve(this.url);
      });

      this.server.on("error", reject);
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}
