import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getClerkProxyHost } from './clerkProxyMiddleware.js';

test('uses the forwarded browser host only for the CI preview router', () => {
  const previous = process.env.PASTE_BROWSER_CI_ROUTER;
  try {
    process.env.PASTE_BROWSER_CI_ROUTER = '1';
    assert.equal(getClerkProxyHost({
      headers: {
        host: '127.0.0.1:8080',
        'x-little-nest-browser-host': '127.0.0.1:24429',
      },
    }), '127.0.0.1:24429');

    delete process.env.PASTE_BROWSER_CI_ROUTER;
    assert.equal(getClerkProxyHost({
      headers: {
        host: 'api.internal:8080',
        'x-little-nest-browser-host': 'evil.example',
      },
    }), 'api.internal:8080');
  } finally {
    if (previous === undefined) delete process.env.PASTE_BROWSER_CI_ROUTER;
    else process.env.PASTE_BROWSER_CI_ROUTER = previous;
  }
});

test('continues to prefer the standard forwarded host outside the CI router', () => {
  const previous = process.env.PASTE_BROWSER_CI_ROUTER;
  try {
    delete process.env.PASTE_BROWSER_CI_ROUTER;
    assert.equal(getClerkProxyHost({
      headers: {
        host: 'api.internal:8080',
        'x-forwarded-host': 'app.example, proxy.internal',
      },
    }), 'app.example');
  } finally {
    if (previous === undefined) delete process.env.PASTE_BROWSER_CI_ROUTER;
    else process.env.PASTE_BROWSER_CI_ROUTER = previous;
  }
});