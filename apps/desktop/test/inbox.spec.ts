import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ingestInbox, scanInbox } from '../src/inbox';

describe('scanInbox', () => {
  it('returns regular files sorted, ignoring dotfiles and directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daak-inbox-'));
    writeFileSync(join(dir, 'b.txt'), 'b');
    writeFileSync(join(dir, 'a.txt'), 'a');
    writeFileSync(join(dir, '.hidden'), 'x');
    mkdirSync(join(dir, 'sub'));
    expect(scanInbox(dir)).toEqual([join(dir, 'a.txt'), join(dir, 'b.txt')]);
  });

  it('returns an empty array for a missing directory', () => {
    expect(scanInbox(join(tmpdir(), 'daak-does-not-exist-12345'))).toEqual([]);
  });

  // lstat, not stat: a watch folder or App Group inbox can hold a symlink to a
  // file the user dropped elsewhere, and statSync would follow it and report a
  // regular file -- handing daakd a path outside the inbox. A symlink is not a
  // staged payload, so it is skipped exactly like a directory is. A symlink to
  // a DIRECTORY is the more dangerous case: statSync reports a dir (skipped by
  // the isFile() check) and lstat reports a symlink (skipped by isSymbolicLink),
  // so the two agree on the result and only lstat refuses the broken-link case.
  it('does not follow symlinks, so a link out of the inbox is never sent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daak-inbox-'));
    const outside = mkdtempSync(join(tmpdir(), 'daak-outside-'));
    const secret = join(outside, 'secret.txt');
    writeFileSync(secret, 'do not send me');
    symlinkSync(secret, join(dir, 'leak.txt'));
    expect(scanInbox(dir)).toEqual([]);
  });

  // A staged payload is named "<uuid>-<original>" (iOS ShareViewController) or
  // "shared-text-<uuid>.txt" (the macOS plan shape), so both always end in a
  // file extension. Scanning by suffix would read the manifest as payload, and
  // the iOS code already rejected a suffix filter for the same reason
  // (a shared "report.batch" staged as "<uuid>-report.batch"). Non-recursive
  // is the property that makes a directory a safe namespace holder: nothing
  // below a subdir is ever visible here.
  it('never descends into a subdirectory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daak-inbox-'));
    mkdirSync(join(dir, 'batches'));
    writeFileSync(join(dir, 'batches', '0123.json'), '[]');
    writeFileSync(join(dir, 'top.txt'), 't');
    expect(scanInbox(dir)).toEqual([join(dir, 'top.txt')]);
  });
});

describe('ingestInbox', () => {
  it('sends each staged file and reports the count', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daak-inbox-'));
    writeFileSync(join(dir, 'one.txt'), 'one');
    writeFileSync(join(dir, 'two.txt'), 'two');
    const sent: Array<{ peerDeviceId: string; files?: string[] }> = [];
    const engine = { send: async (req: never) => { sent.push(req); return { transferId: 'x', queued: false }; } } as never;
    const count = await ingestInbox(dir, engine, 'peer-1');
    expect(count).toBe(2);
    expect(sent.every((r) => r.peerDeviceId === 'peer-1')).toBe(true);
    expect(sent.flatMap((r) => r.files ?? []).sort()).toEqual([
      join(dir, 'one.txt'), join(dir, 'two.txt'),
    ]);
  });

  // One IPC round trip and one outbox row per file, not per drain: daakd's
  // Send maps to Engine::enqueue_outbox_send, which writes a durable outbox row
  // and returns a payload id without blocking on the peer (engine.rs:826), so
  // awaiting each one serialises nothing and only orders the rows. A batched
  // single send would be one transfer for N unrelated shares -- wrong shape,
  // and a peer that goes away after file one would take the rest with it.
  it('sends one transfer per file, in scan order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daak-inbox-'));
    writeFileSync(join(dir, 'b.txt'), 'b');
    writeFileSync(join(dir, 'a.txt'), 'a');
    const order: string[][] = [];
    const engine = { send: async (req: never) => { order.push((req as { files: string[] }).files); return { transferId: 'x', queued: false }; } } as never;
    expect(await ingestInbox(dir, engine, 'peer-1')).toBe(2);
    expect(order).toEqual([[join(dir, 'a.txt')], [join(dir, 'b.txt')]]);
  });

  // A peer that has gone away is a durable-outbox condition, not a reason to
  // throw the remaining files away: DaemonClientEngine.send rejects only on a
  // transport/IPC failure, and the bytes stay staged in the inbox either way.
  // Stopping on the first failure is the honest behaviour -- the caller has to
  // decide whether to retry -- and it leaves the unsent files in place.
  it('stops at the first send failure and leaves the rest staged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daak-inbox-'));
    writeFileSync(join(dir, 'a.txt'), 'a');
    writeFileSync(join(dir, 'b.txt'), 'b');
    const seen: string[] = [];
    const engine = {
      send: async (req: never) => {
        seen.push((req as { files: string[] }).files[0]);
        throw new Error('daemon not running');
      },
    } as never;
    await expect(ingestInbox(dir, engine, 'peer-1')).rejects.toThrow('daemon not running');
    expect(seen).toEqual([join(dir, 'a.txt')]);
    expect(scanInbox(dir)).toEqual([join(dir, 'a.txt'), join(dir, 'b.txt')]);
  });

  it('returns 0 and sends nothing for an empty or missing inbox', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daak-inbox-'));
    const seen: string[] = [];
    const engine = { send: async (req: never) => { seen.push(req as never as string); return { transferId: 'x', queued: false }; } } as never;
    expect(await ingestInbox(dir, engine, 'peer-1')).toBe(0);
    expect(await ingestInbox(join(tmpdir(), 'daak-does-not-exist-12345'), engine, 'peer-1')).toBe(0);
    expect(seen).toEqual([]);
  });
});
