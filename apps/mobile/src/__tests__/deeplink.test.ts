import { parseDeepLink } from '../deeplink';

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
    for (const bad of ['', 'daak:', 'daak:/', 'daak://', 'daak://send?deviceId=%%', '://x', 'daak://send?deviceId=a#frag']) {
      expect(() => parseDeepLink(bad)).not.toThrow();
    }
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
