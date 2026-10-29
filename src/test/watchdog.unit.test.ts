import * as assert from 'assert';
import { TunnelWatchdog } from '../core/watchdog';

suite('TunnelWatchdog Unit Tests', () => {
    test('getInstance returns singleton instance', () => {
        const instance1 = TunnelWatchdog.getInstance();
        const instance2 = TunnelWatchdog.getInstance();
        assert.strictEqual(instance1, instance2);
    });

    test('watchdog emits state change events and maintains metrics', async () => {
        const watchdog = TunnelWatchdog.getInstance();
        let receivedUpdate = false;

        const disposable = watchdog.onStateChange((metrics) => {
            receivedUpdate = true;
            assert.ok(metrics.lastChecked instanceof Date);
        });

        const metrics = await watchdog.probe();
        assert.ok(metrics !== undefined);
        assert.strictEqual(receivedUpdate, true);

        disposable.dispose();
    });
});

