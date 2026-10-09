import { readFileSync } from 'fs';
import { join } from 'path';

// SOURCE PIN. No Android test source set exists on this host. An app that
// targets Android 12 or higher cannot start an activity from a broadcast
// receiver that a notification tap triggers. The body tap must launch an
// activity directly.
const dir = '../../../../modules/rn-notify/android/src/main/java/dev/darshit/daak/notify/';
const read = (f: string) => readFileSync(join(__dirname, dir + f), 'utf8');

describe('Android notification body tap', () => {
  const module = read('DaakNotifyModule.kt');
  const activity = read('ShareTrampolineActivity.kt');
  const post = module.slice(module.indexOf('override fun post('), module.indexOf('override fun cancel('));

  it('sets an activity PendingIntent as the content intent', () => {
    expect(post).toContain('.setContentIntent(openPending(id, payloadJson))');
    expect(post).not.toContain('actionPending(');
  });

  it('builds openPending with getActivity at the trampoline activity', () => {
    const start = module.indexOf('private fun openPending(');
    expect(start).toBeGreaterThan(-1);
    const body = module.slice(start, module.indexOf('}', module.indexOf('return', start)));
    expect(body).toContain('ShareTrampolineActivity::class.java');
    expect(body).toContain('PendingIntent.getActivity(');
    expect(body).not.toContain('getBroadcast');
  });

  it('delivers the open event from the activity, or stashes it', () => {
    expect(activity).toContain('DaakNotifyModule.emitToJs(action, payload)');
    expect(activity).toContain('NotifyStash.put(this, action, payload)');
  });
});
