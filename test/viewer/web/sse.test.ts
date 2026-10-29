import { describe, expect, it } from "vitest";
import { type SseEvent, SseParser } from "../../../web/viewer/sse";

function parse(...chunks: string[]): SseEvent[] {
  const events: SseEvent[] = [];
  const parser = new SseParser((event) => events.push(event));
  for (const chunk of chunks) parser.push(chunk);
  return events;
}

/** Every way of cutting `text` in two. */
function splits(text: string): [string, string][] {
  return Array.from({ length: text.length + 1 }, (_, i) => [text.slice(0, i), text.slice(i)]);
}

describe("SseParser", () => {
  it("dispatches an event with its type and data", () => {
    expect(parse('event: trace\ndata: {"a":1}\n\n')).toEqual([{ event: "trace", data: '{"a":1}' }]);
  });

  it('defaults the type to "message"', () => {
    expect(parse("data: x\n\n")).toEqual([{ event: "message", data: "x" }]);
  });

  it("ignores id and retry fields: the stream has no history to resume", () => {
    expect(parse("id: 1\nretry: 5\nevent: trace\ndata: a\n\nevent: delivery\ndata: b\n\n")).toEqual(
      [
        { event: "trace", data: "a" },
        { event: "delivery", data: "b" },
      ],
    );
  });

  it("joins multi-line data with newlines", () => {
    expect(parse("data: one\ndata: two\ndata:\n\n")).toEqual([
      { event: "message", data: "one\ntwo\n" },
    ]);
  });

  it("accepts CRLF and lone CR line endings", () => {
    expect(parse("event: a\r\ndata: 1\r\n\r\nevent: b\rdata: 2\r\r")).toEqual([
      { event: "a", data: "1" },
      { event: "b", data: "2" },
    ]);
  });

  it("strips one leading space only, and reads a field without a colon as empty", () => {
    expect(parse("data:  two spaces\ndata\ndata:none\n\n")).toEqual([
      { event: "message", data: " two spaces\n\nnone" },
    ]);
  });

  it("ignores comments, unknown fields and retry", () => {
    expect(parse(": ping\n\nretry: 10\nfoo: bar\ndata: x\n: inside\n\n")).toEqual([
      { event: "message", data: "x" },
    ]);
  });

  it("dispatches nothing for an event without data, and resets its type", () => {
    expect(parse("event: hello\n\ndata: x\n\n")).toEqual([{ event: "message", data: "x" }]);
  });

  it("strips a leading byte order mark once", () => {
    expect(parse("\uFEFFdata: x\n\n")).toEqual([{ event: "message", data: "x" }]);
    expect(parse("\uFEFF", "data: x\n\n")).toEqual([{ event: "message", data: "x" }]);
  });

  it("keeps an incomplete event until its blank line arrives", () => {
    const events: SseEvent[] = [];
    const parser = new SseParser((event) => events.push(event));
    parser.push("event: trace\ndata: x\n");
    expect(events).toEqual([]);
    parser.push("\n");
    expect(events).toEqual([{ event: "trace", data: "x" }]);
  });

  it("drops an incomplete event when the stream ends", () => {
    const events: SseEvent[] = [];
    const parser = new SseParser((event) => events.push(event));
    parser.push("data: x\n");
    parser.end();
    parser.push("\n");
    expect(events).toEqual([]);
  });

  it("gives the same events however the stream is cut", () => {
    const stream =
      'id: 3\r\nevent: trace\r\ndata: {"é":"\\n"}\r\n\r\n: ping\r\rdata: a\rdata: b\n\n';
    const expected = parse(stream);
    expect(expected).toEqual([
      { event: "trace", data: '{"é":"\\n"}' },
      { event: "message", data: "a\nb" },
    ]);
    for (const [a, b] of splits(stream)) expect(parse(a, b)).toEqual(expected);
    expect(parse(...stream.split(""))).toEqual(expected);
  });

  it("reads a CR ending one chunk and an LF starting the next as one line ending", () => {
    expect(parse("data: a\r", "\ndata: b\r", "\n\r", "\n")).toEqual([
      { event: "message", data: "a\nb" },
    ]);
  });

  it("parses a large event pushed in small chunks in linear time", () => {
    const value = "x".repeat(6 * 1024 * 1024);
    const stream = `event: trace\ndata: ${value}\n\n`;
    const events: SseEvent[] = [];
    const parser = new SseParser((event) => events.push(event));
    const chunk = 4096;
    const started = performance.now();
    for (let i = 0; i < stream.length; i += chunk) parser.push(stream.slice(i, i + chunk));
    const elapsed = performance.now() - started;

    expect(events).toHaveLength(1);
    expect(events[0].data.length).toBe(value.length);
    // Rescanning the buffer on every push takes seconds here.
    expect(elapsed).toBeLessThan(500);
  });
});
