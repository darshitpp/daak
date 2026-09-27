import { parseDeepLink } from '../deeplink';

describe('parseDeepLink', () => {
  it('parses send/pair links and ignores everything else', () => {
    expect(parseDeepLink('daak://send?deviceId=abc&text=hi')).toEqual({ kind: 'send', deviceId: 'abc', text: 'hi' });
    expect(parseDeepLink('daak://pair?bundle=beef')).toEqual({ kind: 'pair', bundle: 'beef' });
    expect(parseDeepLink('https://example.com')).toEqual({ kind: 'none' });
    expect(parseDeepLink(null)).toEqual({ kind: 'none' });
  });
});
