// Staging-only: never PR this into main.
// Server half of the "today override". Returns the X-Staging-Today date only
// when the request is a staging request (isStagingRequest) AND the header is a
// valid yyyy-mm-dd. Anywhere else, or with a bad value, it returns null and the
// caller keeps its real date. The header is not even read off the gate.
import { isStagingRequest } from "./staging-gate";
import { parseStagingToday, STAGING_TODAY_HEADER } from "../../lib/staging-today";

type TodayCtx = Parameters<typeof isStagingRequest>[0] & {
  req: { header(name: string): string | undefined };
};

export function stagingTodayFromRequest(c: TodayCtx): string | null {
  if (!isStagingRequest(c)) return null;
  return parseStagingToday(c.req.header(STAGING_TODAY_HEADER));
}
