import { test } from 'node:test'
import * as assert from 'node:assert'
import * as path from 'path'
import { safeJoin } from '../src/main/safepath'

const root = path.resolve('/tmp/project')

test('allows normal relative paths', () => {
  assert.strictEqual(safeJoin(root, 'main.tex'), path.join(root, 'main.tex'))
  assert.strictEqual(
    safeJoin(root, 'chapters/intro.tex'),
    path.join(root, 'chapters', 'intro.tex')
  )
  assert.strictEqual(safeJoin(root, ''), root)
})

test('allows the app state directory', () => {
  assert.strictEqual(
    safeJoin(root, '.p2platex/session.json'),
    path.join(root, '.p2platex', 'session.json')
  )
  assert.strictEqual(
    safeJoin(root, '.p2platex/build/main.pdf'),
    path.join(root, '.p2platex', 'build', 'main.pdf')
  )
})

test('refuses traversal outside the root', () => {
  assert.throws(() => safeJoin(root, '../evil.tex'))
  assert.throws(() => safeJoin(root, 'chapters/../../evil.tex'))
  assert.throws(() => safeJoin(root, '/etc/passwd'))
})

test('refuses sibling roots sharing a prefix', () => {
  assert.throws(() => safeJoin(root, '../project-evil/x.tex'))
})

test('refuses hidden paths a malicious peer could sync', () => {
  assert.throws(() => safeJoin(root, '.git'))
  assert.throws(() => safeJoin(root, '.git/hooks/pre-commit'))
  assert.throws(() => safeJoin(root, 'chapters/.git/config'))
  assert.throws(() => safeJoin(root, '.bashrc'))
  assert.throws(() => safeJoin(root, '.p2platex/../.git/config'))
})
