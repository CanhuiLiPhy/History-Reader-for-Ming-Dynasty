import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/reader-pagination.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } });
const { renderedPageDelta } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

test('single-page jumps use the rendered page count, in both directions', () => {
  assert.equal(renderedPageDelta(2, 12, 12), 10);
  assert.equal(renderedPageDelta(12, 1, 12), -11);
});

test('double-page jumps align to a visible spread without leaving the chapter', () => {
  assert.equal(renderedPageDelta(1, 12, 12, 2), 10);
  assert.equal(renderedPageDelta(7, 2, 12, 2), -6);
  assert.equal(renderedPageDelta(11, 12, 12, 2), 0);
  assert.equal(renderedPageDelta(1, 13, 13, 2), 12);
});

test('out-of-range targets stay within chapter boundaries', () => {
  assert.equal(renderedPageDelta(3, 999, 12), 9);
  assert.equal(renderedPageDelta(3, -1, 12), -2);
  assert.equal(renderedPageDelta(1, 99, 1), 0);
});
