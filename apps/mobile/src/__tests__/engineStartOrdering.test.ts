import { readFileSync } from 'fs';
import { join } from 'path';

// The Android app shipped a red "No device list / engine not started; call
// start() first" note on every launch, with no engine fault anywhere in
// logcat, while the process was in fact listening on its engine port. The cause
// is an ordering hole in DaakModule.kt, not a failed start:
//
//   handle() reads the `engine` field and throws when it is null, and that
//   field was only assigned AFTER e.start() returned. start() takes seconds on
//   a cold process, and every screen calls devices() on mount. So each call
//   that arrived during startup got a rejection, and the app rendered an
//   engine fault for an engine that was merely not ready yet.
//
// The rule this pins: a caller must WAIT for the in-flight start rather than be
// told the engine does not exist.
const module = readFileSync(
  join(__dirname, '../../android/app/src/main/java/dev/darshit/daak/DaakModule.kt'),
  'utf8',
);

function startBody(): string {
  const start = module.indexOf('override fun start(');
  expect(start).toBeGreaterThan(-1);
  const end = module.indexOf('override fun pairingBundle(', start);
  return module.slice(start, end);
}

describe('the engine handles calls that arrive during startup', () => {
  it('records the engine before start blocks', () => {
    // The engine object exists after the store constructor returns. Assigning
    // it there means a caller that wakes mid-start calls into a real object
    // rather than a null field.
    const body = startBody();
    const create = body.indexOf('DaakEngine.newWithStore');
    const assign = body.indexOf('engine = e');
    const start = body.indexOf('e.start(dir.absolutePath');
    expect(create).toBeGreaterThan(-1);
    expect(assign).toBeGreaterThan(-1);
    expect(assign).toBeLessThan(start);
  });

  it('waits for the in-flight start instead of reporting a missing engine', () => {
    // A latch, not a spin: start() runs on its own Thread and can take
    // seconds, so handle() blocks on the latch and the calling thread -- which
    // is already the per-call background thread -- waits it out.
    expect(module).toMatch(/CountDownLatch\(/);
    expect(module).toMatch(/startedLatch\.await\(\)/);
    // The rejection must survive for the case that genuinely never starts:
    // a call that arrives before start() was ever called at all.
    expect(module).toMatch(/engine not started/);
  });

  it('waits while the Rust engine is still inside e.start()', () => {
    // The Kotlin field is not the engine's readiness. crates/daak-ffi assigns
    // its OWN engine slot at the END of DaakEngine.start(), so a call that
    // arrives after `engine = e` but before `e.start()` returns finds a
    // non-null Kotlin field and calls straight through into Rust, which answers
    // 'engine not started'. The gate must therefore key on start COMPLETION,
    // not on the field being assigned.
    const body = startBody();
    const start = body.indexOf('e.start(dir.absolutePath');
    const complete = body.indexOf('startComplete = true');
    expect(complete).toBeGreaterThan(-1);
    expect(complete).toBeGreaterThan(start);
    // The gate keys on completion, NOT on `engine == null`: the field is
    // assigned before e.start() blocks, so keying on it left the window open.
    expect(module).toMatch(/startAttempted && !startComplete/);
  });
});
