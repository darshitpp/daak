import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The desktop host half draws the same pairing words as the phone. The module
// loads native pairing code at import time, so this test reads the source. It
// pins the words and the engine calls, and not the layout.
const source = readFileSync(join(__dirname, '..', 'src', 'pairing.tsx'), 'utf8');
const code = source
  .split('\n')
  .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*'))
  .join('\n');

describe('the desktop pairing words', () => {
  it('uses the design button names', () => {
    expect(code).toContain('label="Show my code"');
    expect(code).toContain('label="Show a new code"');
  });

  it('keeps none of the old words', () => {
    expect(code).not.toContain('Show QR');
    expect(code).not.toContain('Show a new QR');
    expect(code).not.toContain('Pair with another Daak device');
    expect(code).not.toContain('Nothing here leaves the network');
  });

  it('passes the busy, error, and retry props to the shared screen', () => {
    expect(code).toMatch(/busy=\{/);
    expect(code).toMatch(/error=\{/);
    expect(code).toMatch(/onRetry=\{showQr\}/);
  });

  // Commit 552459d. A new pairing is pending until the user confirms it.
  it('confirms a pending pairing and revokes a rejected one', () => {
    // The plan's pin said `engine.confirmPairing(peerId)`, but the plan's OWN
    // code snippet reads `const id = peerId;` and then `confirmPairing(id)` (the
    // `pendingRef.current = id;` pin below confirms it). The pin follows the code.
    expect(code).toContain('engine.confirmPairing(id)');
    expect(code).toContain('engine.revokePairing(id)');
    expect(code).toMatch(/onConfirm=\{peerId \? confirm : undefined\}/);
    expect(code).toMatch(/onReject=\{peerId \? reject : undefined\}/);
    // The shared toast (P3 Task 3), not an inline Note.
    expect(code).toContain("toast.show('Pairing cancelled')");
    expect(code).toContain('useToast');
    expect(code).not.toContain('pairing-cancelled');
  });

  // Leaving the route is "Does not match". The behavior is tested in
  // pairing-unmount.spec.ts. These pins keep the three clears and the restore.
  it('revokes an unanswered pairing on unmount and clears the ref on each answer', () => {
    expect(code).toContain('engineRef.current.revokePairing(pending)');
    expect(code.match(/pendingRef\.current = ''/g)?.length).toBe(4);
    expect(code).toContain('pendingRef.current = id;');
    expect(code).not.toMatch(/AppState/);
  });

  it('reads the peer id from the SAS event and not from pairing.done', () => {
    expect(code).toContain("event.type === 'pairing.sas'");
    expect(code).toContain('event.peerDeviceId');
    expect(code).not.toContain("'pairing.done'");
  });
});

