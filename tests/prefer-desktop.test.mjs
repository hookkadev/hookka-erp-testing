// The desktop shell's phone gate (src/lib/prefer-desktop.ts).
//
// BUG-2026-10-02-250: "Open the full desktop app" in /m More went to /dashboard,
// and the desktop shell sent every phone straight back to /m, so the link
// never worked. A phone that chose desktop must now get through.
import test from "node:test";
import assert from "node:assert/strict";
import { shouldRedirectToMobile } from "../src/lib/prefer-desktop.ts";

const ANDROID = "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPADOS = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";

test("phones go to /m by default", () => {
  assert.equal(shouldRedirectToMobile(ANDROID, false), true);
  assert.equal(shouldRedirectToMobile(IPHONE, false), true);
});

test("a phone that chose the desktop site stays on it", () => {
  assert.equal(shouldRedirectToMobile(ANDROID, true), false);
  assert.equal(shouldRedirectToMobile(IPHONE, true), false);
});

test("desktops and iPads never redirect", () => {
  assert.equal(shouldRedirectToMobile(DESKTOP, false), false);
  assert.equal(shouldRedirectToMobile(IPADOS, false), false);
});
