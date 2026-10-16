'use strict';
/**
 * Deploy toolchain overrides (package.json, docs/SECURITY.md): no deprecated package left in the tree.
 * - gaxios pinned to 7.3.1 everywhere: 7.1.3 (exact pin of gcp-metadata / googleapis-common) listed rimraf
 *   -> glob@10 (deprecated) without ever loading it;
 * - node-domexception (deprecated) replaced by vendor/node-domexception, the native DOMException.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const pkg = require(path.join(ROOT, 'package.json'));
const lock = require(path.join(ROOT, 'package-lock.json'));
const installed = (name) => Object.keys(lock.packages).filter((k) => k === 'node_modules/' + name ||
  k.endsWith('/node_modules/' + name));

test('overrides: gaxios 7.3.1 only, no rimraf / glob, node-domexception from vendor/', () => {
  assert.deepEqual(pkg.overrides, { braces: '$braces', 'node-domexception': '$node-domexception', gaxios: '7.3.1' });
  assert.deepEqual(installed('gaxios').map((k) => lock.packages[k].version), ['7.3.1']);
  assert.deepEqual(installed('rimraf'), []);
  assert.deepEqual(installed('glob'), []);
  assert.deepEqual(lock.packages['node_modules/node-domexception'], { resolved: 'vendor/node-domexception', link: true });
  assert.equal(lock.packages['vendor/node-domexception'].name, '@shadow-dashboard/node-domexception');
  const deprecated = Object.entries(lock.packages).filter(([, v]) => v.deprecated).map(([k]) => k);
  assert.deepEqual(deprecated, [], 'no deprecated package in package-lock.json');
});

test('vendor/node-domexception is the native DOMException', () => {
  const DOMException = require(path.join(ROOT, 'vendor', 'node-domexception'));
  assert.equal(DOMException, globalThis.DOMException);
  const e = new DOMException('x', 'NotReadableError');
  assert.equal(e.name, 'NotReadableError');
});
