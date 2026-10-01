import { describe, expect, it } from "vitest";
import { redactUrl } from "../src/utils/url";

describe("redactUrl", () => {
  it.each([
    [
      "leaves a URL without credentials unchanged",
      "wss://csms.example.com/ocpp/CP-001",
      "wss://csms.example.com/ocpp/CP-001",
    ],
    [
      "masks the userinfo",
      "wss://user:secret@csms.example.com/ocpp",
      "wss://***@csms.example.com/ocpp",
    ],
    [
      "masks a username alone",
      "wss://token@csms.example.com/ocpp",
      "wss://***@csms.example.com/ocpp",
    ],
    [
      "masks every query value, keeping the keys",
      "wss://csms.example.com/ocpp?token=secret&tenant=a&token=again",
      "wss://csms.example.com/ocpp?token=***&tenant=***",
    ],
    ["masks the fragment", "wss://csms.example.com/ocpp#secret", "wss://csms.example.com/ocpp#***"],
    ["does not echo an unparseable value", "not a url, secret", "<invalid url>"],
  ])("%s", (_description, input, expected) => {
    expect(redactUrl(input)).toBe(expected);
  });
});
