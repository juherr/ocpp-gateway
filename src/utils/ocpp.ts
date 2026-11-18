import { OCPP_MSG_CALLERROR, OCPP_MSG_CALLRESULT } from "../types";

/**
 * Whether a raw OCPP-J frame is a response (CALLRESULT or CALLERROR). The
 * message type id may be a number or a decimal string (`"3"`), which some
 * chargers send. Anything that cannot be classified is not a response.
 */
export function isOcppResponse(raw: string): boolean {
  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!Array.isArray(frame)) return false;
  const [type] = frame as unknown[];
  const id = typeof type === "string" && /^[0-9]+$/.test(type) ? Number(type) : type;
  return id === OCPP_MSG_CALLRESULT || id === OCPP_MSG_CALLERROR;
}
