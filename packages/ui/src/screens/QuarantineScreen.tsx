import React, { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { QuarantineReport } from '@daak/core';
import { useEngine } from '../EngineContext';
import { AppBar } from '../components/Onboarding';
import { Btn, Empty, Note, type DeviceNoun } from '../components/ds';
import { Sheet } from '../components/Sheet';
import { ui } from '../theme';
import { NOT_RECORDED, arrivedAt, fingerprintGroups, humanBytes, senderLabel } from './quarantine-facts';

function noop(): void {
  // A host may omit onBack. A Pressable still needs a function, and a crash on a
  // security screen is worse than an inert button. AppShell always supplies it.
}

/**
 * The Held-back screen (design route `quarantine`), with real data in place of
 * the mock values.
 *
 * What is real: the file name, the size, the sender, the arrival time, and both
 * fingerprints. A value the device did not record shows "Not recorded". The two
 * fingerprints are a pair and never a verdict. The engine does not decide which
 * one a person should believe, so the screen has no "corrupt" badge.
 *
 * "Ask the sender again" is absent (ruling D1). The wire protocol is push-only,
 * so a receiver has no message that asks a sender for a file. The held bytes are
 * the bytes that failed the check, so reading them again gives the same result.
 *
 * Delete is irreversible, so it asks first. The question is a sheet, as in the
 * design.
 */
export function QuarantineScreen({
  transferId,
  itemIndex,
  onBack,
  onDeleted,
  deviceNoun = 'device',
}: {
  transferId: string;
  itemIndex: number;
  /** Closes the screen. The shell owns the route. */
  onBack?: () => void;
  /**
   * Called after the held bytes are gone, so the list that opened this screen
   * can drop the row.
   */
  onDeleted?: () => void;
  /** The word for this device. The host sets it, because ui has no platform check. */
  deviceNoun?: DeviceNoun | 'device';
}) {
  const engine = useEngine();
  const [report, setReport] = useState<QuarantineReport | null>(null);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [gone, setGone] = useState(false);

  // A read. `quarantineReport` changes nothing, so opening this screen cannot
  // change what is held.
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
        setConfirming(false);
        setGone(true);
        onDeleted?.();
      },
      (e: unknown) => {
        setDeleting(false);
        setConfirming(false);
        setError(e instanceof Error ? e.message : 'the held-back file could not be deleted');
      },
    );
  };

  if (gone) {
    return (
      <View style={ui.screen} testID="screen-quarantine">
        <AppBar title="Held back" onBack={onBack} backLabel="Back to conversation" />
        <ScrollView contentContainerStyle={ui.pad}>
          <Empty
            title="Deleted"
            body={`The held-back file is gone. Nothing else on this ${deviceNoun} changed.`}
          />
          <Btn
            variant="ghost"
            block
            label="Back to conversation"
            onPress={onBack ?? noop}
            testID="quarantine-gone-back"
          />
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={ui.screen} testID="screen-quarantine">
      <AppBar title="Held back" onBack={onBack} backLabel="Back to conversation" />
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
            body={`It is still in Daak's holding area and has not been opened. Nothing else on this ${deviceNoun} was touched.`}
          />
        )}

        {report === null ? null : (
          <View style={ui.stackSm}>
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

      <Sheet
        open={confirming}
        title="Delete this file?"
        onClose={() => setConfirming(false)}
        actions={
          <>
            <Btn
              variant="danger"
              block
              label={deleting ? 'Deleting' : 'Delete it'}
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
          </>
        }
      >
        <Text style={ui.lead}>
          {`It was never opened. Deleting it only clears the holding area on this ${deviceNoun}.`}
        </Text>
      </Sheet>
    </View>
  );
}

/**
 * The design disclosure, kept in substance. The explanation is true of the real
 * fingerprint check.
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
