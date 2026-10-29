import { once } from "node:events";
import { Agent, type IncomingMessage, request } from "node:http";
import { type AddressInfo, connect, createServer as createTcpServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { ViewerConfig } from "../../src/config";
import { configureLogger } from "../../src/logger";
import { startViewer, type ViewerDeps, type ViewerServer } from "../../src/viewer/server";

// Distinctive values, so a test can tell they never leak into a log line.
const USERNAME = "viewer-user-5b8e21";
const PASSWORD = "pw-4c1d:9f7a-viewer";
const GOOD = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`;
const BAD = `Basic ${Buffer.from(`${USERNAME}:wrong-pw-0e6c`).toString("base64")}`;

const ASSETS = {
  html: "<!doctype html><title>viewer test page</title>",
  js: "/* viewer test script */",
  css: "/* viewer test style */",
};

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

let viewer: ViewerServer | undefined;

afterEach(async () => {
  await viewer?.close();
  viewer = undefined;
});

async function start(
  overrides: Partial<ViewerConfig> = {},
  deps: Partial<ViewerDeps> = {},
): Promise<number> {
  viewer = startViewer(
    {
      username: USERNAME,
      password: PASSWORD,
      host: "127.0.0.1",
      port: 0,
      maxBufferedMessages: 1234,
      maxClients: 5,
      ...overrides,
    },
    { assets: ASSETS, authLimits: { maxFailures: 3 }, ...deps },
  );
  await once(viewer.server, "listening");
  return (viewer.server.address() as AddressInfo).port;
}

interface Response {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function get(
  port: number,
  path: string,
  {
    method = "GET",
    headers = {},
    agent,
  }: { method?: string; headers?: Record<string, string>; agent?: Agent } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method, headers, agent: agent ?? false },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const auth = (value = GOOD) => ({ authorization: value });

/** Status code of a request written byte for byte (e.g. with duplicated headers). */
async function rawStatus(port: number, headerLines: string[]): Promise<number> {
  const socket = connect(port, "127.0.0.1");
  try {
    await once(socket, "connect");
    let data = "";
    socket.on("data", (chunk: Buffer) => (data += chunk.toString()));
    socket.write(
      ["GET / HTTP/1.1", "Host: 127.0.0.1", ...headerLines, "Connection: close", "", ""].join(
        "\r\n",
      ),
    );
    await once(socket, "end");
    return Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1]);
  } finally {
    socket.destroy();
  }
}

function expectSecurityHeaders(res: Response) {
  expect(res.headers["cache-control"]).toBe("no-store");
  expect(res.headers["content-security-policy"]).toBe(CSP);
  expect(res.headers["x-content-type-options"]).toBe("nosniff");
  expect(res.headers["referrer-policy"]).toBe("no-referrer");
  expect(res.headers["x-frame-options"]).toBe("DENY");
}

const ROUTES = ["/", "/viewer.js", "/viewer.css", "/api/config", "/events", "/nope", "/index.html"];

describe("viewer server", () => {
  describe("authentication", () => {
    it.each(ROUTES)(
      "answers %s with 401 and a Basic challenge without credentials",
      async (path) => {
        const port = await start();

        const res = await get(port, path);
        expect(res.status).toBe(401);
        expect(res.headers["www-authenticate"]).toBe(
          'Basic realm="OCPP Gateway Viewer", charset="UTF-8"',
        );
        expect(res.body).not.toContain("viewer test");
        expectSecurityHeaders(res);
      },
    );

    it.each(["POST", "PUT", "DELETE", "OPTIONS"])(
      "authenticates a %s before refusing it",
      async (method) => {
        const port = await start();

        expect((await get(port, "/", { method })).status).toBe(401);
        const res = await get(port, "/", { method, headers: auth() });
        expect(res.status).toBe(405);
        expect(res.headers.allow).toBe("GET, HEAD");
        expectSecurityHeaders(res);
      },
    );

    it.each([
      ["a wrong password", BAD],
      ["a wrong username", `Basic ${Buffer.from(`someone:${PASSWORD}`).toString("base64")}`],
      ["another scheme", `Bearer ${PASSWORD}`],
      ["malformed base64", "Basic %%%"],
    ])("answers 401 to %s", async (_, header) => {
      const port = await start();

      const res = await get(port, "/", { headers: auth(header) });
      expect(res.status).toBe(401);
      expect(res.headers["www-authenticate"]).toContain("Basic");
    });

    it("rejects duplicated Authorization headers, even both valid", async () => {
      const port = await start();

      expect(await rawStatus(port, [`Authorization: ${GOOD}`])).toBe(200);
      expect(await rawStatus(port, [`Authorization: ${GOOD}`, `Authorization: ${GOOD}`])).toBe(401);
    });
  });

  describe("routes", () => {
    it("serves the page, its assets and its settings to an authenticated client", async () => {
      const port = await start();

      const page = await get(port, "/", { headers: auth() });
      expect(page.status).toBe(200);
      expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(page.body).toBe(ASSETS.html);
      expectSecurityHeaders(page);

      const js = await get(port, "/viewer.js", { headers: auth() });
      expect(js.status).toBe(200);
      expect(js.headers["content-type"]).toBe("text/javascript; charset=utf-8");
      expect(js.body).toBe(ASSETS.js);

      const css = await get(port, "/viewer.css", { headers: auth() });
      expect(css.status).toBe(200);
      expect(css.headers["content-type"]).toBe("text/css; charset=utf-8");
      expect(css.body).toBe(ASSETS.css);
    });

    it("ignores the query string", async () => {
      const port = await start();

      expect((await get(port, "/viewer.js?v=1", { headers: auth() })).body).toBe(ASSETS.js);
    });

    // `/api/config` too: the capacity comes from the stream's `hello` event.
    it.each(["/nope", "/index.html", "//viewer.js", "/viewer.js/", "/events", "/api/config"])(
      "answers %s with 404 once authenticated",
      async (path) => {
        const port = await start();

        const res = await get(port, path, { headers: auth() });
        expect(res.status).toBe(404);
        expectSecurityHeaders(res);
      },
    );

    it("answers HEAD with the headers only", async () => {
      const port = await start();

      const res = await get(port, "/", { method: "HEAD", headers: auth() });
      expect(res.status).toBe(200);
      expect(res.headers["content-length"]).toBe(String(Buffer.byteLength(ASSETS.html)));
      expect(res.body).toBe("");
    });

    it("hands /events to the optional handler, only once authenticated", async () => {
      const seen: string[] = [];
      const port = await start(
        {},
        {
          events: (req, res) => {
            seen.push(req.method ?? "");
            res.writeHead(200, { "Content-Type": "text/event-stream" }).end("event: test\n\n");
          },
        },
      );

      expect((await get(port, "/events")).status).toBe(401);
      expect(seen).toEqual([]);

      const res = await get(port, "/events?x=1", { headers: auth() });
      expect(res.status).toBe(200);
      expect(res.body).toBe("event: test\n\n");
      // Security headers are set before any handler runs.
      expectSecurityHeaders(res);
      expect(seen).toEqual(["GET"]);
    });

    it("answers 500 when a handler throws, and keeps serving", async () => {
      const port = await start(
        {},
        {
          events: () => {
            throw new Error("handler failure");
          },
        },
      );

      const res = await get(port, "/events", { headers: auth() });
      expect(res.status).toBe(500);
      expectSecurityHeaders(res);
      expect((await get(port, "/", { headers: auth() })).status).toBe(200);
    });
  });

  describe("failed authentication limit", () => {
    it("answers 429 with Retry-After once a source failed too often, even with valid credentials", async () => {
      const port = await start();
      for (let i = 0; i < 3; i++) {
        expect((await get(port, "/", { headers: auth(BAD) })).status).toBe(401);
      }

      const res = await get(port, "/", { headers: auth() });
      expect(res.status).toBe(429);
      const retryAfter = Number(res.headers["retry-after"]);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);
      expect(res.body).not.toContain("viewer test");
      expectSecurityHeaders(res);
    });

    it("does not count a request without credentials, a browser's first one", async () => {
      const port = await start();
      for (let i = 0; i < 5; i++) expect((await get(port, "/")).status).toBe(401);

      expect((await get(port, "/", { headers: auth() })).status).toBe(200);
    });

    it("does not reset the count on a success", async () => {
      const port = await start();
      await get(port, "/", { headers: auth(BAD) });
      await get(port, "/", { headers: auth(BAD) });
      expect((await get(port, "/", { headers: auth() })).status).toBe(200);

      await get(port, "/", { headers: auth(BAD) });
      expect((await get(port, "/", { headers: auth() })).status).toBe(429);
    });

    it("unblocks the source once the window is over", async () => {
      let now = 0;
      const port = await start(
        {},
        { authLimits: { maxFailures: 1, windowMs: 60_000, now: () => now } },
      );
      await get(port, "/", { headers: auth(BAD) });
      expect((await get(port, "/", { headers: auth() })).status).toBe(429);

      now = 60_000;
      expect((await get(port, "/", { headers: auth() })).status).toBe(200);
    });
  });

  describe("client IP header", () => {
    const XFF = "x-real-ip";

    it("keys the limit on the header's value", async () => {
      const port = await start({ clientIpHeader: XFF });
      for (let i = 0; i < 3; i++)
        await get(port, "/", { headers: { ...auth(BAD), [XFF]: "192.0.2.1" } });

      expect((await get(port, "/", { headers: { ...auth(), [XFF]: "192.0.2.1" } })).status).toBe(
        429,
      );
      expect((await get(port, "/", { headers: { ...auth(), [XFF]: "192.0.2.2" } })).status).toBe(
        200,
      );
    });

    it.each([
      ["missing", {}],
      ["not an IP address", { [XFF]: "not-an-ip" }],
      ["a list", { [XFF]: "192.0.2.1, 192.0.2.2" }],
      ["with a port", { [XFF]: "192.0.2.1:1234" }],
    ])(
      "answers 400 when it is %s, before checking credentials",
      async (_, headers: Record<string, string>) => {
        const port = await start({ clientIpHeader: XFF });

        const res = await get(port, "/", { headers: { ...auth(), ...headers } });
        expect(res.status).toBe(400);
        expectSecurityHeaders(res);
      },
    );

    it("answers 400 when it is duplicated", async () => {
      const port = await start({ clientIpHeader: XFF });

      expect(await rawStatus(port, [`Authorization: ${GOOD}`, "X-Real-IP: 192.0.2.1"])).toBe(200);
      expect(
        await rawStatus(port, [
          `Authorization: ${GOOD}`,
          "X-Real-IP: 192.0.2.1",
          "X-Real-IP: 192.0.2.1",
        ]),
      ).toBe(400);
    });

    it("is ignored when not configured", async () => {
      const port = await start();
      for (let i = 0; i < 3; i++)
        await get(port, "/", { headers: { ...auth(BAD), [XFF]: `192.0.2.${i}` } });

      // All three failures came from the same socket address.
      expect((await get(port, "/", { headers: { ...auth(), [XFF]: "192.0.2.9" } })).status).toBe(
        429,
      );
    });
  });

  describe("logging", () => {
    it("never logs credentials, and logs failures once per source and window", async () => {
      const lines: string[] = [];
      configureLogger({
        logLevel: "debug",
        sink: { stdout: (line) => lines.push(line), stderr: (line) => lines.push(line) },
      });
      const port = await start();

      await get(port, "/", { headers: auth() });
      await get(port, "/", { headers: auth(BAD) });
      await get(port, "/", { headers: auth(BAD) });
      await get(port, "/", { headers: auth(BAD) });
      await get(port, "/", { headers: auth() });
      await viewer?.close();

      const output = lines.join("\n");
      expect(output).toContain('"msg":"viewer listening"');
      for (const secret of [USERNAME, PASSWORD, GOOD.slice(6), BAD.slice(6), "wrong-pw-0e6c"]) {
        expect(output).not.toContain(secret);
      }
      const messages = lines.map((line) => (JSON.parse(line) as { msg: string }).msg);
      expect(messages.filter((m) => m === "viewer authentication failed")).toHaveLength(1);
      expect(messages.filter((m) => m === "viewer source blocked")).toHaveLength(1);
    });
  });

  describe("lifecycle", () => {
    it("close() resolves promptly with an open keep-alive connection", async () => {
      const port = await start();
      const agent = new Agent({ keepAlive: true });
      try {
        expect((await get(port, "/", { headers: auth(), agent })).status).toBe(200);
        expect(Object.keys(agent.freeSockets)).toHaveLength(1);

        const started = Date.now();
        await viewer?.close();
        expect(Date.now() - started).toBeLessThan(1000);
      } finally {
        agent.destroy();
      }
    });

    it("close() resolves promptly with a response still streaming", async () => {
      const port = await start(
        {},
        {
          events: (_req, res) => {
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.write(": open\n\n");
          },
        },
      );
      const req = request({
        host: "127.0.0.1",
        port,
        path: "/events",
        headers: auth(),
        agent: false,
      });
      req.end();
      const [res] = (await once(req, "response")) as [IncomingMessage];
      await once(res, "data");
      // The client sees the stream cut ("aborted"), not a clean end.
      res.on("error", () => undefined);
      const ended = new Promise((resolve) => res.once("close", resolve));

      const started = Date.now();
      await viewer?.close();
      expect(Date.now() - started).toBeLessThan(1000);
      await ended;
    });

    it("close() is idempotent", async () => {
      await start();

      await Promise.all([viewer?.close(), viewer?.close()]);
      await viewer?.close();
    });

    it("emits a listen error, and close() still resolves", async () => {
      const held = createTcpServer().listen(0, "127.0.0.1");
      await once(held, "listening");
      try {
        const { port } = held.address() as AddressInfo;
        viewer = startViewer(
          {
            username: USERNAME,
            password: PASSWORD,
            host: "127.0.0.1",
            port,
            maxBufferedMessages: 1,
            maxClients: 1,
          },
          { assets: ASSETS },
        );
        const [err] = (await once(viewer.server, "error")) as [NodeJS.ErrnoException];
        expect(err.code).toBe("EADDRINUSE");
        await viewer.close();
      } finally {
        held.close();
      }
    });
  });
});
