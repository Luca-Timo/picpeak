'use strict';

/**
 * PicTransfer storage is never statically served (#1544).
 *
 * Accepting arbitrary file types — the "accept all" toggle — is only defensible
 * because a stored transfer file is bytes PicPeak hands back, never content it
 * hosts. Every download goes through a route that sets an attachment
 * disposition, nosniff and a sandboxing CSP.
 *
 * That guarantee is one `app.use(express.static(...))` away from being lost, and
 * the loss would be silent: the feature would keep working while every uploaded
 * .html and .svg quietly became a live page on the PicPeak origin. So this pins
 * the absence rather than trusting review to catch it.
 *
 * The stored keys are opaque `.bin` names (see transferUploadPolicy), which is
 * the second, independent layer — this is the first.
 */

const fs = require('fs');
const path = require('path');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');

// Where transfer bytes live, relative to the storage root.
// Mirrors transferService.uploadDirKey / extraFilesDirKey.
const TRANSFER_PREFIXES = ['uploads/transfers', 'transfers'];

/**
 * Every storage-relative path server.js hands to a static middleware.
 * Matches `secureStatic(path.join(storagePath, 'x/y')` and
 * `express.static(path.join(storagePath, 'x/y')`.
 */
function staticallyServedPrefixes(src) {
  const re = /(?:secureStatic|express\.static)\(\s*path\.join\(\s*storagePath\s*,\s*['"]([^'"]+)['"]/g;
  const found = [];
  let m;
  while ((m = re.exec(src)) !== null) found.push(m[1].replace(/^\/+|\/+$/g, ''));
  return found;
}

/** Is `served` the same directory as, or an ancestor of, `target`? */
function covers(served, target) {
  return target === served || target.startsWith(`${served}/`) || served.startsWith(`${target}/`);
}

describe('transfer storage is not statically served', () => {
  const served = staticallyServedPrefixes(SERVER_SRC);

  it('finds the static mounts it is meant to be checking', () => {
    // A guard on the guard: if the mounts are ever written a different way,
    // this test would otherwise pass by matching nothing at all.
    expect(served.length).toBeGreaterThan(0);
    expect(served).toEqual(expect.arrayContaining(['uploads/logos']));
  });

  it.each(TRANSFER_PREFIXES)('no static mount covers %s', (prefix) => {
    const offenders = served.filter((s) => covers(s, prefix));
    expect(offenders).toEqual([]);
  });

  it('serves nothing from the storage root itself', () => {
    // A bare mount on the root would expose every prefix at once.
    expect(served.filter((s) => s === '' || s === '.')).toEqual([]);
  });
});

describe('nginx does not proxy transfer storage either', () => {
  const NGINX_CONF = path.join(__dirname, '../../../frontend/nginx.conf');

  it('has no location block rooted at a transfer prefix', () => {
    if (!fs.existsSync(NGINX_CONF)) return; // not present in every build context
    const conf = fs.readFileSync(NGINX_CONF, 'utf8');
    const locations = [...conf.matchAll(/location\s+[~^=*\s]*\s*([^\s{]+)\s*\{/g)].map((m) => m[1]);
    const offenders = locations.filter((loc) => /\/(uploads\/)?transfers\b/.test(loc));
    expect(offenders).toEqual([]);
  });
});
