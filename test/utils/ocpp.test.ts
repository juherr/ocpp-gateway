import { describe, expect, it } from "vitest";
import { isOcppResponse } from "../../src/utils/ocpp";

describe("isOcppResponse", () => {
  it.each([
    ["a CALLRESULT", '[3,"m1",{}]'],
    ["a CALLERROR", '[4,"m1","InternalError","boom",{}]'],
    ["a message type id sent as a decimal string", '["3","m1",{}]'],
    ["a frame surrounded by whitespace", ' \n[ 4 ,"m1","NotImplemented","",{}] '],
  ])("recognises %s", (_, raw) => {
    expect(isOcppResponse(raw)).toBe(true);
  });

  it.each([
    ["a CALL", '[2,"m1","Heartbeat",{}]'],
    ["a CALL whose type id is a string", '["2","m1","Heartbeat",{}]'],
    ["an unknown message type id", '[5,"m1","InternalError","",{}]'],
    ["a non-decimal string type id", '["3a","m1",{}]'],
    ["an empty string type id", '["","m1",{}]'],
    ["invalid JSON", "[3,"],
    ["a JSON object", '{"type":3}'],
    ["an empty array", "[]"],
    ["an empty frame", ""],
  ])("does not treat %s as a response", (_, raw) => {
    expect(isOcppResponse(raw)).toBe(false);
  });
});
