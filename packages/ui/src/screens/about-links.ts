// Decision D9. The Twitter URL uses x.com. To use twitter.com, change one string.
export const ABOUT_LINKS = [
  { id: 'twitter', label: 'Twitter', handle: '@darshitpp', url: 'https://x.com/darshitpp' },
  { id: 'linkedin', label: 'LinkedIn', handle: 'in/darshitpp', url: 'https://www.linkedin.com/in/darshitpp' },
  { id: 'github', label: 'GitHub', handle: '@darshitpp', url: 'https://github.com/darshitpp' },
  { id: 'repo', label: 'Repository', handle: 'github.com/darshitpp/daak', url: 'https://github.com/darshitpp/daak' },
] as const;

// Decision D2. Daak makes no request. "Check for updates" opens this page.
export const RELEASES_URL = 'https://github.com/darshitpp/daak/releases/latest';

