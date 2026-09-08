import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');

test('closet page keeps model view as the default entry state', () => {
  assert.match(appSource, /get\('preview'\) === 'latest' \? 'outfit' : 'model'/);
  assert.doesNotMatch(appSource, /latestOutfitPreviewOpenedRef/);
});

test('closet page surfaces non-empty wardrobe sections before empty categories', () => {
  assert.match(appSource, /const orderedWardrobeSections = \[\.\.\.wardrobeSections\]\.sort/);
  assert.match(appSource, /Number\(b\.items\.length > 0\) - Number\(a\.items\.length > 0\)/);
  assert.match(appSource, /orderedWardrobeSections\.map/);
});

test('closet recommendations handle a wardrobe with only partial pieces', () => {
  assert.match(appSource, /const singlePieceRecommendations = sortedClosetItems\.slice\(0, 6\)\.map/);
  assert.match(appSource, /card\.partial/);
  assert.match(appSource, /Add a top, bottom, shoe, or accessory before generating a full look/);
});
