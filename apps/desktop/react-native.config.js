// The desktop app is macOS + Windows only. Declaring only those two stops the
// community CLI from looking for an ios/ or android/ project that does not
// exist here (apps/mobile declares ios+android; apps/desktop is the mirror).
module.exports = {
  project: { macos: {}, windows: {} },
  dependencies: {},
};
