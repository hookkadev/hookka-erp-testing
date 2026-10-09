import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  COMPACT_RAIL_WIDTH,
  FULL_RAIL_WIDTH,
  resolveResponsiveLayout,
} from "../src/pages/m/lib/responsive-layout.tsx";

const mobileLayoutSource = readFileSync(
  new URL("../src/pages/m/MobileLayout.tsx", import.meta.url),
  "utf8",
);
const homeSource = readFileSync(
  new URL("../src/pages/m/screens/Home.tsx", import.meta.url),
  "utf8",
);

test("390px preserves the phone shell", () => {
  const layout = resolveResponsiveLayout(390, 390);
  assert.equal(layout.mode, "phone");
  assert.equal(layout.railWidth, 0);
  assert.equal(layout.hasBottomNavigation, true);
  assert.equal(layout.canSplitDetail, false);
});

test("768px uses a compact rail and single-pane content", () => {
  const contentWidth = 768 - COMPACT_RAIL_WIDTH;
  const layout = resolveResponsiveLayout(768, contentWidth);
  assert.equal(layout.mode, "tablet-portrait");
  assert.equal(layout.railWidth, 72);
  assert.equal(layout.contentWidth, 696);
  assert.equal(layout.hasBottomNavigation, false);
  assert.equal(layout.canSplitDetail, false);
});

test("1024px uses a full rail and permits split view", () => {
  const contentWidth = 1024 - FULL_RAIL_WIDTH;
  const layout = resolveResponsiveLayout(1024, contentWidth);
  assert.equal(layout.mode, "tablet-landscape");
  assert.equal(layout.railWidth, 198);
  assert.equal(layout.contentWidth, 826);
  assert.equal(layout.hasBottomNavigation, false);
  assert.equal(layout.canSplitDetail, true);
  assert.ok(layout.splitMasterWidth >= 320 && layout.splitMasterWidth <= 340);
  assert.ok(layout.contentWidth - layout.splitMasterWidth >= 440);
});

test("navigation boundaries do not imply split eligibility", () => {
  assert.equal(resolveResponsiveLayout(719, 719).mode, "phone");
  assert.equal(resolveResponsiveLayout(720, 648).mode, "tablet-portrait");
  assert.equal(resolveResponsiveLayout(1023, 951).mode, "tablet-portrait");
  assert.equal(resolveResponsiveLayout(1024, 826).mode, "tablet-landscape");
  assert.equal(resolveResponsiveLayout(820, 748).canSplitDetail, false);
  assert.equal(resolveResponsiveLayout(884, 812).canSplitDetail, true);
});

test("shell and Home consume the shared responsive model", () => {
  assert.match(mobileLayoutSource, /layout\.canSplitDetail/);
  assert.match(mobileLayoutSource, /<LeftRail compact=\{compactRail\}/);
  assert.match(mobileLayoutSource, /layout\.hasBottomNavigation/);
  assert.doesNotMatch(mobileLayoutSource, /useMediaQuery\("\(min-width: 720px\)"\)/);
  assert.match(homeSource, /useResponsiveLayout/);
  assert.doesNotMatch(homeSource, /orientation: landscape/);
});
