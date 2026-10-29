import * as assert from 'assert';
import * as constants from '../shared/constants';

suite('Constants and Branding Validation', () => {
    test('all command IDs must begin with ag-wormhole.', () => {
        const commandValues = [
            constants.CMD_SETUP,
            constants.CMD_ROLLBACK,
            constants.CMD_ENABLE_FORWARDING,
            constants.CMD_DISABLE_FORWARDING,
            constants.CMD_TUNNEL_STATUS,
            constants.CMD_CHECK_PROXY,
            constants.CMD_SHOW_OUTPUT,
            constants.CMD_SHOW_STATUS_PANEL,
            constants.CMD_REFRESH_STATUS,
            constants.CMD_DIAGNOSE,
            constants.CMD_SHOW_TRAFFIC
        ];

        for (const cmd of commandValues) {
            assert.ok(
                cmd.startsWith('ag-wormhole.'),
                `Command identifier ${cmd} should strictly start with 'ag-wormhole.'`
            );
        }
    });

    test('config section must be ag-wormhole', () => {
        assert.strictEqual(constants.CONFIG_SECTION, 'ag-wormhole');
    });

    test('SSH config constants must follow wormhole naming', () => {
        assert.strictEqual(constants.WORMHOLE_SSH_CONFIG_FILENAME, 'config.wormhole');
        assert.strictEqual(constants.WORMHOLE_SSH_INCLUDE_LINE, 'Include config.wormhole');
    });

    test('default ports should be standard 7890', () => {
        assert.strictEqual(constants.DEFAULT_PROXY_PORT, 7890);
    });
});
