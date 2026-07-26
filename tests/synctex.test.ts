import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { join } from 'path'
import { parseSyncTex, forwardSearch, inverseSearch } from '../src/main/synctex'

const ROOT = '/some/project'
const data = parseSyncTex(readFileSync(join(__dirname, 'fixtures/sample-rel.synctex.gz')))

test('parses inputs and records', () => {
  assert.equal(data.inputs.get(1), './main.tex')
  assert.equal(data.inputs.get(19), './chapters/intro.tex')
  assert.equal(data.inputs.get(20), './chapters/method.tex')
  assert.ok(data.records.length > 100, `expected >100 records, got ${data.records.length}`)
})

test('forward search finds a chapter line on the right page', () => {
  const res = forwardSearch(data, ROOT, 'chapters/intro.tex', 3)
  assert.ok(res, 'no forward result')
  assert.equal(res.page, 3) // title page, ToC, then the introduction chapter
  assert.ok(res.y > 0 && res.y < 792, `y=${res.y} should be inside a letter page`)
  assert.ok(res.x > 0 && res.x < 612, `x=${res.x} should be inside a letter page`)
})

test('forward search on the other chapter lands on a later page', () => {
  const intro = forwardSearch(data, ROOT, 'chapters/intro.tex', 1)!
  const method = forwardSearch(data, ROOT, 'chapters/method.tex', 1)!
  assert.ok(method.page > intro.page, 'method chapter should come after intro')
})

test('inverse search roundtrips forward search', () => {
  const fwd = forwardSearch(data, ROOT, 'chapters/intro.tex', 3)!
  const inv = inverseSearch(data, ROOT, fwd.page, fwd.x, fwd.y)
  assert.ok(inv, 'no inverse result')
  assert.equal(inv.file, 'chapters/intro.tex')
  assert.equal(inv.line, 3)
})

test('forward search for an unknown file returns null', () => {
  assert.equal(forwardSearch(data, ROOT, 'nope.tex', 1), null)
})

test('inverse search ignores pages with no records', () => {
  assert.equal(inverseSearch(data, ROOT, 99, 100, 100), null)
})

test('parser accepts non-gzipped content', () => {
  const plain = Buffer.from('Input:1:./a.tex\nContent:\n{1\nh1,5:100,200:1,1,1\n}1\n')
  const d = parseSyncTex(plain)
  assert.equal(d.records.length, 1)
  assert.deepEqual(d.records[0], { page: 1, tag: 1, line: 5, x: 100, y: 200 })
})
