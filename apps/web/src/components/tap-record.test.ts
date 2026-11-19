import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// TapRecord is a client component with hooks: its wiring is checked on its source. The lifecycle it wires
// (lib/public-record.ts watchTapRecord, tapSendsSoon) is tested in lib/public-record.test.ts, its first render in
// app/public-record-pages.test.ts.
const source = readFileSync(new URL("./tap-record.tsx", import.meta.url), "utf8");

test("/t record line: the record gone (null or the tap's 404) hides it; after the schedule a visible tab loads it once more", () => {
  assert.match(source, /watchTapRecord\(\{/);
  assert.doesNotMatch(source, /startRecordPoll/, "the plain poller left a pending spinner for good");
  assert.match(source, /isGone: \(e\) => e instanceof ApiError && e\.status === 404,/);
  assert.match(source, /onVisible: onTabVisible,/);
  assert.match(source, /document\.addEventListener\("visibilitychange", h\);/);
  assert.match(source, /if \(document\.visibilityState === "visible"\) cb\(\);/);
  assert.match(source, /return \(\) => document\.removeEventListener\("visibilitychange", h\);/);
  // hidden means hidden: no line and no notice once the record is gone
  assert.match(source, /if \(!line\) return null;/);
  assert.match(source, /<RecordLine record=\{line\.record\} serial=\{serial\} soon=\{soon\} live=\{line\.live\} \/>/);
});

test("/t record line: 'within about 3 minutes' from the tap's own time, on a clock that never goes back, one way", () => {
  assert.match(source, /const soon = tapSendsSoon\(line\?\.record \?\? null, tapTs, now, leftSoon\);/);
  assert.match(source, /useEffect\(\(\) => \{ if \(!soon\) setLeftSoon\(true\); \}, \[soon\]\);/);
  assert.match(source, /setNow\(\(n\) => Math\.max\(n, Date\.now\(\) \/ 1000 \+ offset\)\)/);
  assert.doesNotMatch(source, /dueAt/);
});
