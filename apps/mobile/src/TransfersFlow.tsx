/**
 * Nothing to render. The Transfers tab used to pick the newest transfer and
 * hand its id to TransferProgressScreen, so two concurrent transfers left one
 * invisible with no way to stop it. packages/ui now owns the tab as
 * TransfersScreen, which lists every transfer and calls engine.cancel /
 * engine.retry itself -- there is no app-side half left to inject.
 *
 * ponytail: delete this file with the shell's next rename.
 */
export {};
