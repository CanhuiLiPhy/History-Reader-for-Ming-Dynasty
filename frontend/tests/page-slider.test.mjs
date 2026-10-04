import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/page-slider.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } });
const { sliderTotal, pageToSliderProgress, sliderProgressToPage } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

test('Home and End map to chapter boundaries, with an exact page round-trip', () => {
  for (const total of [2, 6, 12, 301]) {
    assert.equal(pageToSliderProgress(1, total), 0);
    assert.equal(pageToSliderProgress(total, total), 1);
    for (let page = 1; page <= total; page++) {
      assert.equal(sliderProgressToPage(pageToSliderProgress(page, total), total), page);
    }
  }
});

test('a drag keeps chapter position when one-page and two-page totals change', () => {
  const progress = pageToSliderProgress(7, 13);
  assert.equal(progress, 0.5);
  assert.equal(sliderProgressToPage(progress, 7), 4);
  assert.equal(sliderProgressToPage(progress, 13), 7);
  assert.equal(sliderProgressToPage(1, 7), 7);
});

test('out-of-bounds and unavailable values never yield NaN or leave the chapter', () => {
  assert.equal(sliderTotal(Infinity), 1);
  assert.equal(sliderTotal(0), 1);
  assert.equal(pageToSliderProgress(-8, 10), 0);
  assert.equal(pageToSliderProgress(999, 10), 1);
  assert.equal(pageToSliderProgress(NaN, 10), 0);
  assert.equal(sliderProgressToPage(-2, 10), 1);
  assert.equal(sliderProgressToPage(3, 10), 10);
  assert.equal(sliderProgressToPage(NaN, 10), 1);
  assert.equal(pageToSliderProgress(1, 1), 0);
  assert.equal(sliderProgressToPage(1, 1), 1);
});
