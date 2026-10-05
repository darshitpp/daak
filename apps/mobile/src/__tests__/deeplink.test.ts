import { Linking } from 'react-native';
import { onDeepLink, parseDeepLink, type DeepLink } from '../deeplink';

describe('parseDeepLink', () => {
  it('parses send/pair links and ignores everything else', () => {
    expect(parseDeepLink('daak://send?deviceId=abc&text=hi')).toEqual({ kind: 'send', deviceId: 'abc', text: 'hi' });
    expect(parseDeepLink('daak://pair?bundle=beef')).toEqual({ kind: 'pair', bundle: 'beef' });
    expect(parseDeepLink('https://example.com')).toEqual({ kind: 'none' });
    expect(parseDeepLink(null)).toEqual({ kind: 'none' });
  });

  it('percent-decodes values', () => {
    expect(parseDeepLink('daak://send?deviceId=a%2Fb&text=hello%20world')).toEqual(
      { kind: 'send', deviceId: 'a/b', text: 'hello world' },
    );
  });

  // A missing required param used to fall through as '' , which downstream
  // happily handed to engine.send({ peerDeviceId: '' }).
  it('fails closed when a required param is missing or empty', () => {
    expect(parseDeepLink('daak://send')).toEqual({ kind: 'none' });
    expect(parseDeepLink('daak://send?deviceId=')).toEqual({ kind: 'none' });
    expect(parseDeepLink('daak://send?text=hi')).toEqual({ kind: 'none' });
    expect(parseDeepLink('daak://pair')).toEqual({ kind: 'none' });
    expect(parseDeepLink('daak://pair?bundle=')).toEqual({ kind: 'none' });
  });

  it('never throws on a malformed URL', () => {
    for (const bad of ['', 'daak:', 'daak:/', 'daak://', 'daak://send?deviceId=%%', '://x']) {
      expect(() => parseDeepLink(bad)).not.toThrow();
    }
  });

  // A fragment is legal and must not swallow the query.
  it('ignores a trailing fragment', () => {
    expect(parseDeepLink('daak://send?deviceId=a#frag')).toEqual({ kind: 'send', deviceId: 'a' });
  });

  it('omits an empty text param rather than sending an empty string', () => {
    expect(parseDeepLink('daak://send?deviceId=AA&text=')).toEqual({ kind: 'send', deviceId: 'AA' });
  });

  // Hermes has no URL. React Native polyfills the global with
  // Libraries/Blob/URL, which is Blob-only: it parses fine and then throws
  // 'URL.hostname is not implemented' on the first accessor. Node's full URL
  // is present under Jest, which is exactly why the URL-based version of this
  // parser passed here and would have thrown on every daak:// link on device.
  it('works under a URL global that throws on hostname, like the RN polyfill', () => {
    class ThrowingURL {
      constructor(public href: string) {}
      get hostname(): string { throw new Error('URL.hostname is not implemented'); }
      get searchParams(): never { throw new Error('URL.searchParams is not implemented'); }
    }
    // defineProperty, not an assignment cast: the RN types do not declare a
    // URL global at all, and `as unknown as` is exactly the kind of cast that
    // hides a real mismatch.
    const real = Object.getOwnPropertyDescriptor(globalThis, 'URL');
    Object.defineProperty(globalThis, 'URL', { value: ThrowingURL, configurable: true, writable: true });
    try {
      expect(parseDeepLink('daak://send?deviceId=abc&text=hi')).toEqual({ kind: 'send', deviceId: 'abc', text: 'hi' });
    } finally {
      if (real) Object.defineProperty(globalThis, 'URL', real);
      else Reflect.deleteProperty(globalThis, 'URL');
    }
  });
});

describe('onDeepLink', () => {
  const listeners: ((e: { url: string }) => void)[] = [];
  let initial: Promise<string | null>;

  beforeEach(() => {
    listeners.length = 0;
    initial = Promise.resolve(null);
    jest.spyOn(Linking, 'getInitialURL').mockImplementation(() => initial);
    jest.spyOn(Linking, 'addEventListener').mockImplementation(((_t: string, cb: (e: { url: string }) => void) => {
      listeners.push(cb);
      return { remove: () => { const i = listeners.indexOf(cb); if (i !== -1) listeners.splice(i, 1); } };
    }) as never);
  });

  afterEach(() => jest.restoreAllMocks());

  it('reports the launch URL on the happy path', async () => {
    initial = Promise.resolve('daak://pair?bundle=beef');
    const seen: DeepLink[] = [];
    onDeepLink((l) => seen.push(l));
    await initial;
    await Promise.resolve();
    expect(seen).toEqual([{ kind: 'pair', bundle: 'beef' }]);
  });

  it('reports none and does not throw an unhandled rejection when getInitialURL rejects', async () => {
    initial = Promise.reject(new Error('no handler'));
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    const seen: DeepLink[] = [];
    try {
      onDeepLink((l) => seen.push(l));
      // Two microtask turns: the rejection must be handled inside onDeepLink's
      // own .then, and a turn for any resulting job to be reported.
      await new Promise((r) => setTimeout(r, 0));
      expect(seen).toEqual([{ kind: 'none' }]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('delivers later url events and stops after the disposer', () => {
    const seen: DeepLink[] = [];
    const off = onDeepLink((l) => seen.push(l));
    for (const emit of listeners) emit({ url: 'daak://send?deviceId=x' });
    off();
    for (const emit of listeners) emit({ url: 'daak://send?deviceId=y' });
    expect(seen).toEqual([{ kind: 'send', deviceId: 'x' }]);
    expect(listeners).toHaveLength(0);
  });

  // REGRESSION, and a silent one. getInitialURL() and the 'url' event are NOT
  // ordered: on a warm start the event arrives first and the initial read
  // settles a tick later with no URL. Last-writer-wins therefore replaced a
  // real pairing link with `none` -- the app opened the pair route with no
  // bundle and the join did nothing at all, with no error to show for it.
  it('does not let a late empty initial read discard a link already delivered', async () => {
    // Never settles until the test releases it, which is the shape of the race:
    // the event lands first, the read lands second.
    let release!: (u: string | null) => void;
    initial = new Promise<string | null>((r) => {
      release = r;
    });
    const seen: DeepLink[] = [];
    onDeepLink((l) => seen.push(l));
    for (const emit of listeners) emit({ url: 'daak://pair?bundle=beef' });
    release(null);
    await initial;
    await Promise.resolve();
    expect(seen).toEqual([{ kind: 'pair', bundle: 'beef' }]);
  });

  // The empty answer is still delivered when NOTHING real ever arrived -- the
  // guard is against an overwrite, not against reporting the ordinary state.
  it('still reports none when no link ever arrives', async () => {
    initial = Promise.resolve(null);
    const seen: DeepLink[] = [];
    onDeepLink((l) => seen.push(l));
    await initial;
    await Promise.resolve();
    expect(seen).toEqual([{ kind: 'none' }]);
  });
});
