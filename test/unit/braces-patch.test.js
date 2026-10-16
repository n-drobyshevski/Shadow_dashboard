'use strict';
/**
 * vendor/braces: braces 3.0.3 with a nesting-depth limit (GHSA-vfj7-8cjw-p6xm, docs/SECURITY.md).
 * Needs the dev dependencies (npm ci): vendor/braces requires fill-range.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const braces = require(path.join(ROOT, 'vendor', 'braces'));

test('vendored braces: deep nesting is refused before any recursion (no stack exhaustion)', () => {
  const deep = '{'.repeat(4999) + '}'.repeat(4999); // under MAX_LENGTH (10000): the advisory's case
  for (const fn of [() => braces(deep), () => braces.expand(deep), () => braces.compile(deep)]) {
    assert.throws(fn, { name: 'SyntaxError', message: 'Brace nesting exceeds max depth (64)' });
  }
  assert.throws(() => braces.expand('{a,'.repeat(65) + 'b' + '}'.repeat(65)), SyntaxError);
  assert.doesNotThrow(() => braces.expand('{a,'.repeat(10) + 'b' + '}'.repeat(10)));
  assert.throws(() => braces.expand('{{{a,b}}}', { maxDepth: 2 }), SyntaxError);
});

test('vendored braces: unchanged results for ordinary patterns', () => {
  assert.deepEqual(braces.expand('src/{a,b}/*.{js,html}'), ['src/a/*.js', 'src/a/*.html', 'src/b/*.js', 'src/b/*.html']);
  assert.deepEqual(braces.expand('x{1..3}'), ['x1', 'x2', 'x3']);
  assert.deepEqual(braces('a/{b,c}/d'), ['a/(b|c)/d']);
});

test('the clasp toolchain resolves braces to the vendored copy (package.json override)', () => {
  const pkg = require(path.join(ROOT, 'package.json'));
  assert.equal(pkg.devDependencies.braces, 'file:vendor/braces');
  assert.deepEqual(pkg.overrides, { braces: '$braces' });
  const lock = require(path.join(ROOT, 'package-lock.json'));
  assert.deepEqual(lock.packages['node_modules/braces'], { resolved: 'vendor/braces', link: true });
  assert.equal(lock.packages['vendor/braces'].name, '@shadow-dashboard/braces');
});
