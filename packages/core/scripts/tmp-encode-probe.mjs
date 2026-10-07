// Throwaway probe behind crates/daak-ipc/tests/fixtures/ts_start_frame.hex.
// The fixture is the EXACT bytes cbor-x (configured as transport.ts configures
// it) emits for a Start request, so the cross-language pin is never
// hand-transcribed. Run: node packages/core/scripts/tmp-encode-probe.mjs
import { Encoder } from 'cbor-x';

const enc = new Encoder({ mapsAsObjects: true, useRecords: false, variableMapSize: true });
// Kept in lockstep with IPC_VERSION in packages/core/src/ipc/transport.ts.
const IPC_MAJOR = 1;
const IPC_MINOR = 4;
const v = (IPC_MAJOR << 8) | IPC_MINOR;

const snake = { data_dir: '/tmp/x', display_name: 'daak', listen_port: 0 };
const camel = { dataDir: '/tmp/x', displayName: 'daak', listenPort: 0 };
const out = [
  `# Exact bytes cbor-x (as configured in packages/core/src/ipc/transport.ts) emits`,
  `# for {"v":${v},"msg":{"Request":{"Start":{data_dir,display_name,listen_port}}}}.`,
  `snake_case = ${Buffer.from(enc.encode({ v, msg: { Request: { Start: snake } } })).toString('hex')}`,
  ``,
  `# The same frame with the camelCase keys DaemonClient.start() used to send.`,
  `camelCase = ${Buffer.from(enc.encode({ v, msg: { Request: { Start: camel } } })).toString('hex')}`,
  ``,
];
process.stdout.write(out.join('\n'));
