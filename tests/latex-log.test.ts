import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLatexErrors } from '../src/main/latex-log'

test('parses file-line-error format (pdflatex/latexmk)', () => {
  const log = [
    'This is pdfTeX',
    './chapters/intro.tex:23: Undefined control sequence.',
    'l.23 \\badmacro'
  ].join('\n')
  const errors = parseLatexErrors(log)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].file, 'chapters/intro.tex')
  assert.equal(errors[0].line, 23)
  assert.equal(errors[0].severity, 'error')
  assert.match(errors[0].message, /Undefined control sequence/)
})

test('parses tectonic error format', () => {
  const errors = parseLatexErrors('error: main.tex:5: Missing $ inserted.')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].file, 'main.tex')
  assert.equal(errors[0].line, 5)
})

test('parses bang errors and recovers line from l.<num>', () => {
  const log = ['! Missing \\begin{document}.', 'some context', 'l.42 hello'].join('\n')
  const errors = parseLatexErrors(log)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].file, null)
  assert.equal(errors[0].line, 42)
})

test('parses warnings', () => {
  const log = [
    "LaTeX Warning: Reference `fig:x' on page 3 undefined on input line 10.",
    'Package hyperref Warning: Token not allowed.'
  ].join('\n')
  const errors = parseLatexErrors(log)
  assert.equal(errors.length, 2)
  assert.ok(errors.every((e) => e.severity === 'warning'))
})

test('dedupes repeated errors and caps at 100', () => {
  const line = './a.tex:1: Boom.'
  const many = Array.from({ length: 300 }, (_, i) => `./f.tex:${i}: e${i}.`).join('\n')
  assert.equal(parseLatexErrors(`${line}\n${line}\n${line}`).length, 1)
  assert.equal(parseLatexErrors(many).length, 100)
})

test('ignores unrelated lines', () => {
  assert.equal(parseLatexErrors('Output written on main.pdf (4 pages).').length, 0)
})
