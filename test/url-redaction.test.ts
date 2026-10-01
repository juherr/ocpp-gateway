import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { configureLogger } from "../src/logger";
import { parseRouteTable } from "../src/routes";
import { connectWhenOpen, makeCsms, sleep, startGateway, waitFor } from "./helpers";

// Backend URLs may carry credentials (userinfo, query tokens): they must never
// reach the logs, which a platform such as Cloudflare observability collects.
const PASSWORD = "pa55word";
const TOKEN = "s3cr3t-token";

let cleanup: (() => unknown)[] = [];

afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

function captureLogs() {
  const lines: string[] = [];
  configureLogger({
    logLevel: "debug",
    sink: { stdout: (line) => lines.push(line), stderr: (line) => lines.push(line) },
  });
  return lines;
}

describe("credentials in backend URLs", () => {
  it("are redacted from the gateway's connection logs", async () => {
    const csms = makeCsms("csms");
    await once(csms.wss, "listening");
    cleanup.push(() => csms.close());
    const lines = captureLogs();
    const gw = await startGateway({
      default: {
        primary: `ws://csms-user:${PASSWORD}@127.0.0.1:${csms.port()}/ocpp?token=${TOKEN}`,
        // Unreachable: its connection errors are logged with the URL too.
        secondaries: [`ws://mirror-user:${PASSWORD}@127.0.0.1:1/mirror?token=${TOKEN}`],
      },
    });
    cleanup.push(() => gw.close());

    const ws = await connectWhenOpen(`ws://127.0.0.1:${gw.port}/CP-001`, "ocpp1.6");
    cleanup.push(() => ws.close());
    await waitFor(() => lines.some((line) => line.includes("primary connected")));
    await waitFor(() => lines.some((line) => line.includes("secondary error")));
    await sleep(50);

    const logs = lines.join("\n");
    expect(logs).toContain("127.0.0.1");
    expect(logs).toContain("/ocpp/CP-001");
    expect(logs).not.toContain(PASSWORD);
    expect(logs).not.toContain(TOKEN);
  });

  it("are redacted from routes file validation errors", () => {
    const invalid = (url: string) => () => parseRouteTable({ default: { primary: url } });

    expect(invalid(`ftp://user:${PASSWORD}@csms.example.com/?token=${TOKEN}`)).toThrow(
      /ftp:\/\/.*csms\.example\.com/,
    );
    expect(invalid(`ftp://user:${PASSWORD}@csms.example.com/?token=${TOKEN}`)).not.toThrow(
      new RegExp(`${PASSWORD}|${TOKEN}`),
    );
    expect(invalid(`not a url, ${PASSWORD}`)).not.toThrow(new RegExp(PASSWORD));
  });
});
