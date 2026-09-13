import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config.js';
import {
  DEFAULT_MAIL_SETTINGS, DEFAULT_PORTS, mailFingerprint, mailIsConfigured, mailStatus, normalizeMailSettings,
  resolvePort,
} from './settings.js';

/**
 * The SMTP settings are read from a hand-editable JSON file and written by a
 * form, so the coercion rules are the contract: a half-filled record must never
 * reach a transport, and the password must never reach the browser.
 */

test('coerces an absent or empty record into usable defaults', () => {
  const settings = normalizeMailSettings(undefined);
  assert.equal(settings.enabled, false);
  assert.equal(settings.host, '');
  assert.equal(settings.security, 'starttls');
  assert.equal(settings.port, DEFAULT_PORTS.starttls);
  assert.equal(settings.fromName, 'Agents OS');
  assert.equal(settings.verifyCertificate, true);
  assert.equal(settings.updatedAt, null);
  assert.equal(settings.password, '');
});

test('takes a port that can be dialed and ignores one that cannot', () => {
  assert.equal(resolvePort('starttls', 2525), 2525);
  assert.equal(resolvePort('starttls', '587'), 587);
  assert.equal(resolvePort('tls', 0), DEFAULT_PORTS.tls);
  assert.equal(resolvePort('tls', 70000), DEFAULT_PORTS.tls);
  assert.equal(resolvePort('none', undefined), DEFAULT_PORTS.none);
  assert.equal(resolvePort('none', 'nonsense'), DEFAULT_PORTS.none);
});

test('keeps an unknown security mode out of the transport', () => {
  const settings = normalizeMailSettings({ security: 'plaintext-ish' as never });
  assert.equal(settings.security, 'starttls');
});

test('never trims a password on the right', () => {
  const settings = normalizeMailSettings({ password: '  hunter2  ' });
  assert.equal(settings.password, '  hunter2  ');
});

test('requires a host and a sender before it counts as configured', () => {
  const base = { enabled: true, host: 'smtp.example.com', fromEmail: 'agents@example.com' };
  assert.equal(mailIsConfigured(normalizeMailSettings(base)), true);
  assert.equal(mailIsConfigured(normalizeMailSettings({ ...base, enabled: false })), false);
  assert.equal(mailIsConfigured(normalizeMailSettings({ ...base, host: '' })), false);
  assert.equal(mailIsConfigured(normalizeMailSettings({ ...base, fromEmail: '' })), false);
});

test('the console view carries never the password, only whether one is on file', () => {
  const settings = normalizeMailSettings({
    enabled: true,
    host: 'smtp.example.com',
    username: 'agents',
    password: 'super-secret',
    fromEmail: 'agents@example.com',
    updatedAt: '2026-09-11T09:00:00.000Z',
  });
  const status = mailStatus(settings);

  assert.equal(status.hasPassword, true);
  assert.equal(status.configured, true);
  assert.equal(JSON.stringify(status).includes('super-secret'), false);
  assert.equal('password' in status, false);
});

test('.env seeds an unsaved record but never overrides a saved one', () => {
  const original = config.mailEnv;
  try {
    config.mailEnv = {
      host: 'relay.internal',
      port: 2525,
      security: 'none',
      fromEmail: 'agents@internal.example',
      enabled: true,
    };

    // Nothing saved yet: the seed is adopted wholesale.
    const seeded = normalizeMailSettings(undefined);
    assert.equal(seeded.host, 'relay.internal');
    assert.equal(seeded.port, 2525);
    assert.equal(seeded.security, 'none');
    assert.equal(mailIsConfigured(seeded), true);

    // Saved from the console: the stored record is authoritative, even where it
    // deliberately clears a value the seed still carries.
    const saved = normalizeMailSettings({
      enabled: true,
      host: 'smtp.example.com',
      port: 587,
      security: 'starttls',
      fromEmail: 'agents@example.com',
      updatedAt: '2026-09-11T09:00:00.000Z',
    });
    assert.equal(saved.host, 'smtp.example.com');
    assert.equal(saved.port, 587);
    assert.equal(saved.security, 'starttls');

    const cleared = normalizeMailSettings({ updatedAt: '2026-09-11T09:00:00.000Z' });
    assert.equal(cleared.host, '');
    assert.equal(mailIsConfigured(cleared), false);
  } finally {
    config.mailEnv = original;
  }
});

test('the fingerprint changes exactly when the connection would', () => {
  const base = normalizeMailSettings({
    enabled: true,
    host: 'smtp.example.com',
    port: 587,
    security: 'starttls',
    username: 'agents',
    password: 'secret',
    fromEmail: 'agents@example.com',
  });
  const same = normalizeMailSettings({ ...base });
  assert.equal(mailFingerprint(base), mailFingerprint(same));

  for (const patch of [
    { host: 'other.example.com' },
    { port: 2525 },
    { security: 'tls' as const },
    { username: 'someone-else' },
    { password: 'secret2' },
    { verifyCertificate: false },
  ]) {
    assert.notEqual(
      mailFingerprint(base),
      mailFingerprint(normalizeMailSettings({ ...base, ...patch })),
      `changing ${Object.keys(patch)[0]} must rebuild the transport`,
    );
  }

  // The sender address is not part of the connection, so editing it must not
  // throw away a working transport.
  assert.equal(
    mailFingerprint(base),
    mailFingerprint(normalizeMailSettings({ ...base, fromEmail: 'other@example.com' })),
  );
});

test('a switch to another security mode without a port is not left behind', () => {
  // The API layer moves the port when the mode changes and the port was still
  // the conventional one; this pins the table that decision reads.
  assert.deepEqual(DEFAULT_PORTS, { starttls: 587, tls: 465, none: 25 });
  assert.equal(DEFAULT_MAIL_SETTINGS.enabled, false);
});
