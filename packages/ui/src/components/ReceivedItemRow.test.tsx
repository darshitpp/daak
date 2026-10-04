import React from 'react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pressable, Text, TouchableOpacity, View } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import type { ItemState } from '@daak/core';
import { ReceivedItemRow } from './ReceivedItemRow';

const item = { transferId: 't1', itemIndex: 2, state: 'quarantined' as ItemState };

// A source pin that reads RAW source cannot tell code from prose, so it is
// defeatable AND fragile at once: a comment can supply the string the pin is
// checking for, and the same comment breaks the pin when the prose is merely
// explaining itself. Both happened to this exact test -- the component's own
// JSDoc argues at length about why there is no Retry button, and the word
// "Retry" in that prose failed a property that is in fact true.
//
// Two layers, both taken from the house technique (metro-port.spec.ts:52-58,
// picker.spec.ts:53-57): strip comments first, then match what is left.
//
//   Layer 1 -- block comments as SPANS, then `//` from the delimiter to end of
//   line. Order and shape are load-bearing. A line-anchored filter
//   (`/^\s*(\/\/|\/\*|\*)/`) was the first version of this in metro-port and
//   was wrong twice: it never tracked that a block comment was still OPEN, so
//   every interior line survived, and a decoy parked after real code on the
//   same line survived too. That is why this strips spans first and strips
//   trailing `//`, not just whole-line ones.
//
//   Layer 2 -- nothing else is needed here, because unlike metro-port there is
//   no competing declaration to slice between: this pin is deliberately
//   whole-file. The property is "this component has no Retry affordance in it",
//   and a brace-balanced slice (componentSource in picker.spec.ts) would make
//   it WEAKER, not stronger, by ignoring code outside the returned function's
//   body -- e.g. an onRetry in this file's defaultProps or a module-scope const.
//   Metro-port needed the slice because it had to distinguish two methods that
//   write the same port; here there is nothing to distinguish, so a slice would
//   only add a way to be wrong.
//
// KNOWN ACCEPTED COST, stated because metro-port learned it the hard way, and
// corrected in review round 2 after a mutation proved the first draft of this
// block was wrong about its own evidence:
//   (a) a `//` inside a string or template literal is over-stripped, so text
//       after it in that literal is INVISIBLE to this pin. Measured:
//       `const decoy = 'press // Retry to resend'` strips down to
//       `const decoy = 'press ` and the `Retry` is gone. Such a decoy makes the
//       file GREATER, never smaller.
//   (b) an unterminated `/*` keeps `/*` and the rest of the file in CODE rather
//       than swallowing them -- the span regex is non-greedy, so with no closing
//       `*/` it simply never matches. Safe direction: it over-reports, and a
//       file carrying an unterminated block comment is a syntax error that
//       cannot ship. Verified by mutation, not assumed.
//   (c) a `/*` inside a string is read as a comment start and over-strips from
//       there to the next real `*/`. Same accepted direction as (a).
//
// WHAT MITIGATES (a) AND (c) -- and it is NOT a size check, because a size
// check cannot work here: over-stripping HIDES a decoy while making the file
// grow, so any byte floor is blind to this class by construction. A byte floor
// was tried in round 1 and removed in round 2 for exactly that reason (it also
// false-red honest refactors). The two things that actually stand behind this
// pin are:
//   1. THE RUNTIME LAYER, which is naming-INDEPENDENT. "offers no affordance
//      under any name" below asserts on role, on accessibility label and on a
//      pressable host node anywhere in the rendered tree -- not on the word
//      Retry. That is the layer that catches a real wired control whatever it is
//      called, and it reads no source at all, so no amount of over-stripping can
//      blind it. Its completeness is itself measured rather than asserted: the
//      detector block below renders each RN interactive shape and pins what it
//      emits, because round 3 proved a detector built from responder props alone
//      was blind to a bare Text carrying onPress.
//   2. The render-anchored non-vacuity check below, which proves the strip is
//      really reading code that builds the tree the runtime layer just saw.
// Neither of those catches a `Retry` that exists only inside a string literal,
// and that is stated here rather than glossed: such text renders nothing and
// wires nothing. TODO(phase-6-followup): keeping literals would close (a) and
// (c) and needs a real tokenizer, not two regexes. It is NOT the fix for a
// control labelled `Resend` -- the accessibility-label assertion is, and it is
// already here.
const stripComments = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '');

const rowCode = stripComments(readFileSync(join(__dirname, 'ReceivedItemRow.tsx'), 'utf8'));

// The runtime layer's third axis, as two small helpers. React Native renders
// composites down to HOST elements (plain strings: 'View', 'Text', ...), so
// this axis reads what is really on screen and needs no name to do it.
//
// `onPress` is in the list below, and the reason is measured rather than
// assumed. For the Pressable/Touchable*/Button/Switch family RN REWIRES
// `onPress` into responder props on the host node and the `onPress` key never
// reaches it -- probed on RN 0.76.5, a real `<TouchableOpacity onPress>`
// carries [onStartShouldSetResponder, onResponderGrant, onResponderMove,
// onResponderRelease, onResponderTerminate, onResponderTerminationRequest,
// onClick] and NO `onPress` key. But a bare `<Text onPress>` is wired straight
// through: it emits the single key `onPress` and NO responder prop at all. That
// shape is a real, wired, tappable control, so a detector built only from
// responder props called the tree clean while the row offered a working
// `Resend`, with no role, no accessibility label, and no `Retry` token anywhere
// in the source for the pin to catch. Review round 3 found it that way.
//
// The load-bearing detail, and the reason this reads key-PRESENCE on the live
// props instead of a substring match over toJSON: the live object does carry
// the key (`n.props.onPress !== undefined` is true for the Text case), while
// `JSON.stringify(toJSON())` contains the substring "onPress" for NONE of these
// shapes, because JSON.stringify drops function values. So an assertion shaped
// like `expect(JSON.stringify(tree)).not.toMatch(/"onPress"/)` can never fail --
// not for a Text, and not for a Touchable either. It is why that draft was
// discarded and why this one works.
//
// Which props count is pinned by tests below rather than asserted here, because
// this list is the whole mechanism and an unpinned list is exactly the kind of
// thing that silently stops matching after an RN upgrade.
const PRESSABLE_PROPS = ['onStartShouldSetResponder', 'onResponderRelease', 'onClick', 'onPress'];

// ITEM-3 SWEEP, recorded as an accepted limit rather than another pin, per the
// ruling that this task must not keep growing. The sibling RN handler props were
// probed on RN 0.76.5 and these emit no responder prop and no host View, so
// PRESSABLE_PROPS alone does not see them:
//     <Text onLongPress>      -> type=Text,  no responderish prop
//     <Text onPressIn>        -> type=Text,  no responderish prop
//     <TextInput onSubmitEditing> -> no responderish prop
//     <View onTouchEnd>       -> type=View,  no responderish prop
//     <Image onTouchStart>    -> type=Image, no responderish prop
// Only onPress is pinned, because it is the shape a retry affordance would
// actually be written with; pinning the whole handler surface would mean
// asserting that a received row renders no editable field and no image, which
// is a different component's contract. `onLongPress` is the honest gap and is
// left stated here rather than quietly widened.
type HostNode = { type: string; props?: Record<string, unknown>; children?: HostNode[] | null };

const hostTypes = (node: HostNode | HostNode[] | null): HostNode[] => {
  if (node === null) return [];
  const nodes = Array.isArray(node) ? node : [node];
  return nodes.flatMap((n) => [n, ...hostTypes(n.children ?? null)]);
};

const pressableHostTypes = (nodes: HostNode[]): string[] => nodes
  .filter((n) => typeof n.type === 'string' && PRESSABLE_PROPS.some((p) => n.props?.[p] !== undefined))
  .map((n) => n.type);

// The strip above is the whole mechanism, so it gets its own tests rather than
// being trusted. Each case is a shape that was a real hole somewhere in this
// repo's source pins; each one asserts the direction that matters -- comment
// shapes must not RED, code must.
describe('the comment strip this file pins with', () => {
  it('removes a block comment as a SPAN, including its interior lines', () => {
    const src = ['export function R() {', '  /* decoy Retry', '     label="Retry"', '  */', '  return null;', '}'].join('\n');
    expect(stripComments(src)).not.toContain('Retry');
    expect(stripComments(src)).toContain('return null;');
  });

  it('removes a trailing line-comment parked after real code on the same line', () => {
    const src = ['export function R() {', '  return null; // decoy onRetry', '}'].join('\n');
    expect(stripComments(src)).not.toContain('onRetry');
    expect(stripComments(src)).toContain('return null;');
  });

  it('removes a whole-line line-comment', () => {
    const src = ['// decoy Retry', 'export function R() { return null; }'].join('\n');
    expect(stripComments(src)).not.toContain('Retry');
    expect(stripComments(src)).toContain('return null;');
  });

  it('leaves real code alone, so a genuine affordance still reads RED', () => {
    const src = ['export function R({ onRetry }: any) {', '  return <Btn label="Retry" onPress={onRetry} />;', '}'].join('\n');
    expect(stripComments(src)).toContain('onRetry');
    expect(stripComments(src)).toContain('Retry');
  });

  // The one hole the strip genuinely cannot close, recorded as a test and not
  // only as prose: a decoy inside a string or template literal is over-stripped
  // and becomes invisible. Accepted on purpose -- a wired-up affordance cannot
  // live inside a string literal, and the runtime test "offers no Retry in any
  // state" is what actually catches a rendered button; it reads no source.
  it('over-strips a decoy inside a string literal (accepted limit, stated)', () => {
    expect(stripComments('const hint = "// Retry";')).not.toContain('Retry');
  });

  // The other side of the same limit, and it is the safe side: an unterminated
  // block comment keeps everything after it, so the decoy still reads RED
  // rather than disappearing. Confirmed by mutating the real component with an
  // unterminated `/*` and re-running; the vacuity guard below is the belt to
  // this braces.
  it('keeps, rather than hides, code after an UNTERMINATED block comment', () => {
    const code = stripComments('const a = 1;\n/* unterminated\nconst onRetry = 2;');
    expect(code).toContain('onRetry');
  });
});

// The control-detection helpers carry the runtime layer's third axis, and an
// unpinned detector is decoration: if RN stops emitting one of these props the
// axis silently goes blind and every affordance test goes green. So the
// detector is pinned against REAL renders, not against a hand-written object.
describe('the pressable-element detector', () => {
  const noop = () => {};

  it('finds nothing in a plain non-interactive tree', () => {
    render(<View><Text>item 2</Text></View>);
    expect(pressableHostTypes(hostTypes(screen.toJSON() as HostNode))).toEqual([]);
  });

  it('finds a Pressable, which is the shape review round 1 used to slip past', () => {
    render(<Pressable accessibilityRole="button" onPress={noop}><Text>Fetch again</Text></Pressable>);
    expect(pressableHostTypes(hostTypes(screen.toJSON() as HostNode))).not.toEqual([]);
  });

  it('finds a TouchableOpacity carrying NO role and NO accessibility label', () => {
    // The exact mutation that got through round 2's first draft: wording and
    // handler both invented, and the only honest signal is the host element.
    render(<TouchableOpacity onPress={noop}><Text>Fetch again</Text></TouchableOpacity>);
    expect(pressableHostTypes(hostTypes(screen.toJSON() as HostNode))).not.toEqual([]);
  });

  it('finds a control nested below the row, not only at the top level', () => {
    render(<View><View><View><TouchableOpacity onPress={noop}><Text>Resend</Text></TouchableOpacity></View></View></View>);
    expect(pressableHostTypes(hostTypes(screen.toJSON() as HostNode))).not.toEqual([]);
  });

  // The shape review round 3 let through, and the reason this block exists at
  // all. A Text carrying onPress is NOT a Touchable: RN does not wrap it in a
  // host View and does not rewire the handler into a responder prop, it just
  // puts onPress in the Text host node's own props. Every other case in this
  // block was found by a responder prop, so a detector built from responder
  // props alone declared a live, tappable, role-less, label-less Resend clean
  // -- while the source pin missed it too, because neither Retry nor onRetry
  // appears anywhere in that file. One of those two layers had to carry it; this
  // case is what makes the runtime layer the one that does.
  it('finds a bare Text with onPress, which carries NO responder prop and NO host View', () => {
    render(<View><Text onPress={noop}>Resend</Text></View>);
    const tree = hostTypes(screen.toJSON() as HostNode);
    // The premise, asserted rather than assumed: this shape really does emit no
    // responder prop, so the responder-only detector really would have missed it.
    const RESPONDER_ONLY = ['onStartShouldSetResponder', 'onResponderRelease', 'onClick'];
    const responderOnlyHits = tree.filter((n) => RESPONDER_ONLY.some((p) => n.props?.[p] !== undefined));
    expect(responderOnlyHits).toEqual([]);
    // And the pinned detector still catches it, off the key carried live in props.
    expect(pressableHostTypes(tree)).not.toEqual([]);
  });
});

describe('ReceivedItemRow', () => {
  // The engine only ever writes 'done' and 'quarantined' for an inbound item
  // (crates/daak-core/src/transfer/receiver.rs:326-347) and retry_item re-arms
  // it to 'pending' (engine.rs:1034), so every one of the six frozen states is
  // renderable and none of them may be silently dropped.
  it('renders every frozen item state', () => {
    const states: ItemState[] = ['pending', 'receiving', 'verifying', 'done', 'failed', 'quarantined'];
    for (const state of states) {
      const { unmount } = render(<ReceivedItemRow item={{ ...item, state }} />);
      expect(screen.getByText(state)).toBeTruthy();
      unmount();
    }
  });

  // The event carries no name (TransferItemEvent, daak-ffi/src/lib.rs:73-78),
  // so the row shows the index honestly rather than a fabricated filename.
  it('labels the row by index, not by an invented name', () => {
    render(<ReceivedItemRow item={item} />);
    expect(screen.getByText('item 2')).toBeTruthy();
  });

  // A received row NEVER offers Retry, in any state. Retry on a received item
  // would imply a receiver can ask a sender to send again; the protocol is
  // push-only, and the held bytes are the bytes that just failed the check.
  // Pinned per state so a future state cannot smuggle the button back in.
  it('offers no Retry in any state', () => {
    const states: ItemState[] = ['pending', 'receiving', 'verifying', 'done', 'failed', 'quarantined'];
    for (const state of states) {
      const { unmount } = render(<ReceivedItemRow item={{ ...item, state }} />);
      expect(screen.queryByText('Retry')).toBeNull();
      expect(screen.queryByText('Try again')).toBeNull();
      unmount();
    }
  });

  // THE LOAD-BEARING TEST, and the one round 1 of this task deleted by mistake.
  // Everything else here is about particular STRINGS; this one is about
  // AFFORDANCES, which is the property the ruling actually names: "no Retry
  // affordance is wired into this component".
  //
  // Round 1's regression, in one line: the old suite asserted
  // `queryByLabelText('retry-item 2')`, and that assertion is
  // NAME-INDEPENDENT -- it catches any control carrying that a11y id whatever
  // its visible wording or prop name. Deleting it left the source pin as the
  // only thing between a wired button and a green suite, and the pin misses
  // every affordance avoiding the exact tokens `Retry`/`onRetry`. Review round 1
  // proved it with three real buttons -- `Resend`+`resend`, `Send
  // again`+`onRedo`, `Resend`+`resend-item 2` -- all caught by the old suite
  // and all passed by the round-1 suite. NET COVERAGE REGRESSION; this test
  // reverses it.
  //
  // So this is deliberately NOT `queryByText('Retry')`. A control may be worded
  // `Resend`, `Send again`, `Try Again`, `retry`, or in another language, and
  // may name its handler `resend` or `handlePress`. FOUR independent axes are
  // checked, so renaming any single part of the affordance still trips it:
  //   - role:    a received row has no business rendering a control at all.
  //   - a11y id: the id this component's row would own if it had one, plus a
  //              case-insensitive sweep for ANY label mentioning a retry, so a
  //              new id (`resend-item 2`) cannot slip past a literal.
//   - control: NO pressable HOST NODE anywhere in the tree, at any depth. This
//              is the axis that needs no name at all, and it is the one that
//              catches the affordance when the wording, the a11y id AND the
//              handler name are all invented. "Host node", not "host View": a
//              bare Text carrying onPress is a control with no host View around
//              it and no responder prop in it, so the axis keys on the prop
//              rather than on the element type (see PRESSABLE_PROPS).
  //
// A review mutation caught an earlier version of axis 3, which asserted
// `not.toMatch(/"onPress"/)` over toJSON: JSON.stringify drops function values,
// so "onPress" is not a substring of the serialised tree for ANY of these
// shapes -- not for a Text, and not for a Touchable (which serialises to a plain
// host View) -- and that assertion could never have failed. It is replaced by
// this axis, which reads key-presence on the live props object, where the key
// really is present.
  it('offers no affordance under ANY name, in any state', () => {
    const states: ItemState[] = ['pending', 'receiving', 'verifying', 'done', 'failed', 'quarantined'];
    for (const state of states) {
      const { unmount } = render(<ReceivedItemRow item={{ ...item, state }} />);
      // Axis 3 needs the whole tree at any depth, so it reads toJSON.
      const tree = hostTypes(screen.toJSON());
      // Axis 1: no control of any role.
      expect(screen.queryByRole('button')).toBeNull();
      // Axis 2: the id this row would own, by literal AND by /retry/i.
      expect(screen.queryByLabelText(`retry-item ${item.itemIndex}`)).toBeNull();
      expect(screen.queryByLabelText(/retry/i)).toBeNull();
      // Axis 3: no pressable host element at all.
      expect(pressableHostTypes(tree)).toEqual([]);
      unmount();
    }
  });

  it('accepts no retry prop at all, so no caller can wire one back up', () => {
    // CODE, not source text. The component argues its own case in prose; the
    // pin reads only what would actually run.
    expect(rowCode).not.toContain('onRetry');
    expect(rowCode).not.toContain('Retry');
  });

  // The non-vacuity check for the two assertions above. `not.toContain` on
  // stripped source passes PERFECTLY on an empty string, so anything that made
  // the strip eat this file would turn the pin into a green test that asserts
  // nothing at all.
  //
  // It is anchored on what the component RENDERS, because that is the one thing
  // the runtime layer above has independently proven is really on screen: the
  // tests that render this component all assert `{label}` and `{item.state}` are
  // visible text. If the strip hollowed the file out, those two would vanish
  // from the stripped source AND those runtime tests would fail -- the same
  // fact, asserted once from each side, which is what makes this a real check
  // rather than a substring coincidence.
  //
  // WHAT THIS DELIBERATELY DOES NOT ANCHOR ON, after review round 1:
  //   - the component's NAME. Round 1 required `export function ReceivedItemRow(`,
  //     and a plain rename to `RxRow` failed four tests. Nothing in this package
  //     obliges that spelling, so a guard may not depend on it.
  //   - a BYTE COUNT. Round 1 also required `rowCode.length > 500`; review showed
  //     an honest extraction of the nested `<View>` into a `<Row>` primitive
  //     landed on 469 and failed, and separately showed the floor cannot catch
  //     what it was introduced for, since over-stripping HIDES a decoy while
  //     making the file GROW. A floor false-reds refactors and misses the one
  //     class it was added for. Deleted, not tuned.
  // A dead stub can still be written to satisfy any substring check; that is
  // true of every source pin and is why the RUNTIME layer, not this check, is
  // what a real affordance has to get past.
  it('strip enough real code that the absence above is not vacuous', () => {
    // The rendered output, which the runtime tests above prove is really shown.
    expect(rowCode).toContain('{label}');
    expect(rowCode).toContain('{item.state}');
    // And the JSX that carries them survived, so this is a component and not a
    // stub that happens to repeat two tokens. Anchored on the TAG, not on the
    // component name, so a rename or an arrow-const export is free.
    expect(rowCode).toMatch(/export\s+(function|const)\s/);
    expect(rowCode).toMatch(/return\s*\(/);
    expect(rowCode).toMatch(/<Text\b/);
  });
});

// R118: 'received' is NOT a transfer_items.state (spec 4.2) and the engine
// never writes it. Pinned against the SOURCE, both the shared type and this
// component, so adding it fails here rather than reaching a user's screen.
describe('item-state vocabulary', () => {
  const here = __dirname;
  const read = (p: string) => readFileSync(join(here, p), 'utf8');
  const FROZEN = ['pending', 'receiving', 'verifying', 'done', 'failed', 'quarantined'];

  it('is exactly the six frozen states in @daak/core', () => {
    const line = read('../../../core/src/engine/types.ts')
      .split('\n')
      .find((l) => l.includes('export type ItemState'));
    expect(line).toBeDefined();
    for (const s of FROZEN) expect(line).toContain(`'${s}'`);
    expect(line).not.toContain('received');
  });

  it('contains no stray item state in ReceivedItemRow', () => {
    // Same class of pin as the Retry one above, so the same rule: comments
    // cannot supply the string. This component's JSDoc discusses vocabulary at
    // length, and a `received` there is prose, not a state literal.
    expect(stripComments(read('./ReceivedItemRow.tsx'))).not.toMatch(/['"]received['"]/);
  });
});
