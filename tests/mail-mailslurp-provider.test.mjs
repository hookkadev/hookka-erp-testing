// ---------------------------------------------------------------------------
// mail-mailslurp-provider.test.mjs — sendMail's MailSlurp fallback
// (src/api/lib/email.ts). Staging has no Brevo/Resend key and sends from a
// MailSlurp inbox instead. Pins: provider order (Brevo > Resend > MailSlurp),
// the MailSlurp request shape, attachment upload-then-reference, and that
// hasMailProvider needs BOTH MailSlurp vars. fetch is stubbed; no network.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

try {
  register('tsx/esm', pathToFileURL('./'));
} catch {
  // Native type-stripping handles it on newer Node.
}

const { sendMail, hasMailProvider } = await import('../src/api/lib/email.ts');

function stubFetch(responder) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init, body: init?.body ? JSON.parse(init.body) : undefined });
    return responder(String(url));
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

const MS = { MAILSLURP_API_KEY: 'k', MAILSLURP_INBOX_ID: 'inbox-1' };
const ARGS = { to: 'a@x.test', subject: 'S', html: '<p>hi</p>' };

test('hasMailProvider needs both MailSlurp vars', () => {
  assert.equal(hasMailProvider({}), false);
  assert.equal(hasMailProvider({ MAILSLURP_API_KEY: 'k' }), false);
  assert.equal(hasMailProvider({ MAILSLURP_INBOX_ID: 'i' }), false);
  assert.equal(hasMailProvider(MS), true);
  assert.equal(hasMailProvider({ BREVO_API_KEY: 'b' }), true);
});

test('MailSlurp sends from the inbox with HTML body', async () => {
  const f = stubFetch(() => new Response('', { status: 201 }));
  try {
    const r = await sendMail(MS, 'X <noreply@hookka.com>', ARGS);
    assert.equal(r.ok, true);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, 'https://api.mailslurp.com/inboxes/inbox-1');
    assert.equal(f.calls[0].init.headers['x-api-key'], 'k');
    assert.deepEqual(f.calls[0].body, { to: ['a@x.test'], subject: 'S', body: '<p>hi</p>', isHTML: true });
  } finally { f.restore(); }
});

test('MailSlurp uploads attachments first and references their ids', async () => {
  const f = stubFetch((url) =>
    url.endsWith('/attachments')
      ? new Response(JSON.stringify(['att-1']), { status: 200 })
      : new Response('', { status: 201 }));
  try {
    const r = await sendMail(MS, 'x@y', { ...ARGS, attachments: [{ filename: 'n.pdf', contentBase64: 'QUJD' }] });
    assert.equal(r.ok, true);
    assert.equal(f.calls[0].url, 'https://api.mailslurp.com/attachments');
    assert.deepEqual(f.calls[0].body, { base64Contents: 'QUJD', contentType: 'application/pdf', filename: 'n.pdf' });
    assert.deepEqual(f.calls[1].body.attachments, ['att-1']);
  } finally { f.restore(); }
});

test('MailSlurp error surfaces status + body', async () => {
  const f = stubFetch(() => new Response('bad inbox', { status: 404 }));
  try {
    const r = await sendMail(MS, 'x@y', ARGS);
    assert.equal(r.ok, false);
    assert.match(r.error, /MailSlurp 404: bad inbox/);
  } finally { f.restore(); }
});

test('Brevo still wins when both are configured', async () => {
  const f = stubFetch(() => new Response('{"messageId":"m"}', { status: 201 }));
  try {
    await sendMail({ ...MS, BREVO_API_KEY: 'b' }, 'x@y', ARGS);
    assert.equal(f.calls[0].url, 'https://api.brevo.com/v3/smtp/email');
  } finally { f.restore(); }
});
