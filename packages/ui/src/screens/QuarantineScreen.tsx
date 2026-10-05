import React, { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { QuarantineReport } from '@daak/core';
import { useEngine } from '../EngineContext';
import { AppBar } from '../components/Onboarding';
import { Btn, Empty, Note } from '../components/ds';
import { ui } from '../theme';
import { NOT_RECORDED, arrivedAt, fingerprintGroups, humanBytes, senderLabel } from './quarantine-facts';

function noop(): void {
  // A host may omit onBack; a Pressable still needs SOME function, and crashing
  // a security screen because a route had no exit is worse than an inert one.
  // AppShell always supplies it.
}

/**
 * The prototype's "Held back" screen (sc-quarantine), with its fabricated data
 * replaced by facts.
 *
 * THE PROTOTYPE'S FOUR VALUES AND ITS PRIMARY BUTTON ARE ALL LIES. Its card
 * reads `harbor-lighthouse.jpg` / `4.2 MB` / `Kitchen Tablet` / `2 minutes ago`,
 * pairs `7f3a 91c2 04be` against `7f3a 91c2 04c9`, and its primary button says
 * "Ask the sender again". None of that can be rendered as written:
 *
 *   - The name, size, sender and arrival time are only whatever this device
 *     RECORDED. A sender that was never paired has no stored label, and an item
 *     sent with no size has no size. Each of those renders as an explicit
 *     "Not recorded", because filling them in would be a fabricated fact on the
 *     one screen whose whole job is telling the user not to trust a file.
 *   - The two fingerprints are REAL and are shown as a PAIR, never as a
 *     verdict. The engine computed one from the bytes on this disk; it does not
 *     and must not decide which of the two a person should believe. So there is
 *     no "corrupt" badge: the comparison is the user's to make.
 *   - "Ask the sender again" is not wired, and could not be. Daak's wire
 *     protocol is PUSH-ONLY -- a receiver has no message it can send a sender
 *     to request a file -- and the held bytes are the exact bytes that just
 *     failed this comparison, so re-reading them can only reproduce the same
 *     mismatch. A button here would promise what the engine cannot do.
 *
 * What IS real, and therefore rendered: both fingerprints, everything the item
 * row recorded, and a delete that removes the held bytes for good.
 */
export function QuarantineScreen({
  transferId,
  itemIndex,
  onBack,
  onDeleted,
}: {
  transferId: string;
  itemIndex: number;
  /** Closes the screen. The shell owns the route, exactly as for pairing. */
  onBack?: () => void;
  /**
   * Called after the held bytes are really gone, so the LIST this was opened
   * from can drop the row. Without it the Inbox keeps offering a row for a file
   * that no longer exists, and re-opening it shows an error.
   */
  onDeleted?: () => void;
}) {
  const engine = useEngine();
  const [report, setReport] = useState<QuarantineReport | null>(null);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [gone, setGone] = useState(false);

  // A READ. `quarantineReport` mutates nothing, so opening this screen cannot
  // change what is being held.
  useEffect(() => {
    let live = true;
    void engine.quarantineReport(transferId, itemIndex).then(
      (r) => {
        if (live) {
          setReport(r);
          setError('');
        }
      },
      (e: unknown) => {
        if (live) {
          setError(e instanceof Error ? e.message : 'this held-back file could not be read');
        }
      },
    );
    return () => {
      live = false;
    };
  }, [engine, transferId, itemIndex]);

  const remove = () => {
    setDeleting(true);
    void engine.deleteQuarantined(transferId, itemIndex).then(
      () => {
        setDeleting(false);
        setGone(true);
        onDeleted?.();
      },
      (e: unknown) => {
        setDeleting(false);
        setError(e instanceof Error ? e.message : 'the held-back file could not be deleted');
      },
    );
  };

  if (gone) {
    return (
      <View style={ui.screen} testID="screen-quarantine">
        <AppBar title="Held back" onBack={onBack} backLabel="Back to Inbox" />
        <ScrollView contentContainerStyle={ui.pad}>
          <Empty
            title="Deleted"
            body="The held-back file is gone. Nothing else on this device changed."
          />
          <Btn
            variant="ghost"
            block
            label="Back to Inbox"
            onPress={onBack ?? noop}
            testID="quarantine-gone-back"
          />
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={ui.screen} testID="screen-quarantine">
      <AppBar title="Held back" onBack={onBack} backLabel="Back to Inbox" />
      <ScrollView contentContainerStyle={ui.pad}>
        <View style={ui.stack}>
          <Text style={ui.h1}>This file didn't pass its check</Text>
          <Text style={ui.lead}>
            Daak compares every arriving file against a short fingerprint sent with
            it. This one doesn't match, so it was not opened.
          </Text>
        </View>

        {error ? (
          <Note tone="err" title="Nothing was changed" body={error} testID="quarantine-error" />
        ) : report === null ? (
          <Text style={ui.muted}>Reading what was held back.</Text>
        ) : (
          <View style={ui.cardTight} testID="quarantine-details">
            <Row k="File" v={report.name ?? NOT_RECORDED} />
            <Row k="Size" v={report.size === null ? NOT_RECORDED : humanBytes(report.size)} />
            <Row k="From" v={senderLabel(report)} />
            <Row
              k="Arrived"
              v={report.receivedAt === null ? NOT_RECORDED : arrivedAt(report.receivedAt)}
            />
            <Row k="Fingerprint it should have" v={fingerprintGroups(report.expected)} mono />
            <Row k="Fingerprint it has" v={fingerprintGroups(report.actual)} mono />
          </View>
        )}

        {report === null ? null : (
          <Note
            tone="err"
            title="Nothing was changed"
            body="It is still in Daak's holding area and has not been opened. Nothing else on this device was touched."
          />
        )}

        {report === null ? null : confirming ? (
          <View style={ui.stackSm} testID="quarantine-confirm">
            <Text style={ui.h3}>Delete this held-back file for good?</Text>
            <Text style={ui.hint}>
              It is still held back and not opened, so nothing you can see is lost.
              There is no way to get these bytes back.
            </Text>
            <Btn
              variant="danger"
              block
              label={deleting ? 'Deleting' : 'Yes, delete it'}
              disabled={deleting}
              onPress={remove}
              testID="quarantine-delete-confirm"
            />
            <Btn
              variant="ghost"
              block
              label="Keep it"
              onPress={() => setConfirming(false)}
              testID="quarantine-delete-cancel"
            />
          </View>
        ) : (
          <View style={ui.stackSm}>
            {/*
              The prototype's PRIMARY action here is "Ask the sender again",
              and it is deliberately absent. The engine has no re-fetch: the
              protocol is push-only, so there is no message to send a sender
              asking. What remains is the delete, which is real -- and it gets a
              confirmation step, because it is irreversible.
            */}
            <Btn
              variant="danger"
              block
              label="Delete it"
              onPress={() => setConfirming(true)}
              testID="quarantine-delete"
            />
          </View>
        )}

        <WhyExplained />
      </ScrollView>
    </View>
  );
}

/**
 * The prototype's disclosure, kept in substance: this explanation is true of
 * the real fingerprint check, unlike most of the prototype's hardcoded values.
 */
function WhyExplained() {
  const [open, setOpen] = useState(false);
  return (
    <View style={ui.stackSm}>
      <Btn
        variant="ghost"
        block
        label="What does this mean?"
        onPress={() => setOpen((v) => !v)}
        testID="quarantine-why"
      />
      {open ? (
        <View style={ui.cardTight} testID="quarantine-why-body">
          <Text style={ui.hint}>
            A fingerprint is a short code Daak works out from a file before it
            travels. If the code on arrival is different, the file was damaged on
            the way or something changed it. Daak will not open a file it cannot
            vouch for, so nothing untrustworthy reaches your photos or documents.
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <View style={[ui.kv, ui.kvFirst]}>
      <Text style={ui.kvK}>{k}</Text>
      <Text style={[ui.kvV, mono ? [ui.nowrap, ui.mono] : null]} testID={'quarantine-' + k}>
        {v}
      </Text>
    </View>
  );
}
