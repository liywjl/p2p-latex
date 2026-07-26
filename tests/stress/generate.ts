/**
 * Generates a synthetic thesis-scale LaTeX project for stress testing:
 * N chapters pulled in with \include (so the app's quick-compile
 * \includeonly path applies), maths, tables, figures, cross-references and
 * a large bibliography. Deterministic: same options → byte-identical output.
 */
import { promises as fs } from 'fs'
import * as path from 'path'

export interface ThesisOptions {
  chapters: number
  sectionsPerChapter: number
  paragraphsPerSection: number
  bibEntries: number
}

export const DEFAULT_OPTIONS: ThesisOptions = {
  chapters: 100,
  sectionsPerChapter: 6,
  paragraphsPerSection: 7,
  bibEntries: 1500
}

/** mulberry32 — tiny deterministic PRNG. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = (
  'the a of research thesis chapter method results model data analysis system ' +
  'approach experiment measurement theory framework structure process function ' +
  'value parameter distribution equation solution algorithm performance ' +
  'evaluation comparison significant observed proposed novel existing standard ' +
  'furthermore however therefore consequently moreover empirical theoretical ' +
  'numerical linear dynamic optimal robust efficient scalable distributed'
).split(' ')

function sentence(rand: () => number): string {
  const n = 8 + Math.floor(rand() * 12)
  const words = Array.from({ length: n }, () => WORDS[Math.floor(rand() * WORDS.length)])
  const s = words.join(' ')
  return s.charAt(0).toUpperCase() + s.slice(1) + '.'
}

function paragraph(rand: () => number): string {
  return Array.from({ length: 4 + Math.floor(rand() * 4) }, () => sentence(rand)).join(' ')
}

function equation(rand: () => number, tag: string): string {
  const forms = [
    `\\begin{equation}\\label{eq:${tag}}\n  f(x) = \\sum_{i=1}^{n} \\alpha_i x^i + \\int_0^\\infty e^{-\\lambda t}\\,\\mathrm{d}t\n\\end{equation}`,
    `\\begin{align}\n  \\mathbf{y} &= \\mathbf{A}\\mathbf{x} + \\boldsymbol{\\epsilon} \\label{eq:${tag}} \\\\\n  \\hat{\\theta} &= \\arg\\min_\\theta \\|\\mathbf{y} - g_\\theta(\\mathbf{x})\\|_2^2\n\\end{align}`,
    `\\begin{equation}\\label{eq:${tag}}\n  P(A \\mid B) = \\frac{P(B \\mid A)\\,P(A)}{P(B)}\n\\end{equation}`
  ]
  return forms[Math.floor(rand() * forms.length)]
}

function table(tag: string): string {
  return [
    '\\begin{table}[htbp]',
    '  \\centering',
    `  \\caption{Synthetic results for configuration ${tag}.}`,
    `  \\label{tab:${tag}}`,
    '  \\begin{tabular}{lrrr}',
    '    \\hline',
    '    Method & Accuracy & Time (s) & Memory (MB) \\\\',
    '    \\hline',
    '    Baseline & 0.812 & 12.4 & 342 \\\\',
    '    Proposed & 0.907 & 9.1 & 291 \\\\',
    '    Ablation & 0.874 & 10.2 & 305 \\\\',
    '    \\hline',
    '  \\end{tabular}',
    '\\end{table}'
  ].join('\n')
}

function figure(tag: string): string {
  return [
    '\\begin{figure}[htbp]',
    '  \\centering',
    '  \\includegraphics[width=0.55\\textwidth]{figures/plot}',
    `  \\caption{Illustrative plot for experiment ${tag}.}`,
    `  \\label{fig:${tag}}`,
    '\\end{figure}'
  ].join('\n')
}

function chapterTex(idx: number, opts: ThesisOptions, rand: () => number): string {
  const c = String(idx).padStart(3, '0')
  const parts: string[] = [`\\chapter{Study ${idx}: ${sentence(rand).slice(0, -1)}}`]
  for (let s = 1; s <= opts.sectionsPerChapter; s++) {
    const tag = `c${c}s${s}`
    parts.push(`\\section{${sentence(rand).slice(0, -1)}}\\label{sec:${tag}}`)
    for (let p = 0; p < opts.paragraphsPerSection; p++) {
      parts.push(paragraph(rand))
      if (p === 1) {
        const cites = Array.from(
          { length: 3 },
          () => `ref${1 + Math.floor(rand() * opts.bibEntries)}`
        )
        parts.push(`As shown in prior work~\\citep{${cites.join(',')}}, ` + sentence(rand))
      }
    }
    parts.push(equation(rand, tag))
    if (s % 2 === 0) parts.push(table(tag))
    if (s % 3 === 0) parts.push(figure(tag))
    // cross-reference an earlier chapter's material
    const backRef = Math.max(1, Math.floor(rand() * idx))
    parts.push(
      `See also Section~\\ref{sec:c${String(backRef).padStart(3, '0')}s1} and ` +
        `Equation~\\eqref{eq:c${String(backRef).padStart(3, '0')}s1}. ` +
        paragraph(rand)
    )
  }
  return parts.join('\n\n') + '\n'
}

const SURNAMES = (
  'Aldrin Baker Chen Dubois Ekwueme Fischer Garcia Haddad Ivanov Jensen ' +
  'Kimura Larsen Mendes Nakamura Okafor Petrov Quinn Rossi Singh Tanaka ' +
  'Ueda Varga Wang Xu Yilmaz Zhang'
).split(' ')

function bib(opts: ThesisOptions, rand: () => number): string {
  const entries: string[] = []
  // Authors must vary: natbib's year-suffix disambiguation (1982a, 1982b, …)
  // only goes to 'z', so >26 entries with the same first author and year
  // produce a corrupt .bbl.
  const author = (): string =>
    `${SURNAMES[Math.floor(rand() * SURNAMES.length)]}, ${String.fromCharCode(
      65 + Math.floor(rand() * 26)
    )}.`
  for (let i = 1; i <= opts.bibEntries; i++) {
    entries.push(
      [
        `@article{ref${i},`,
        `  author  = {${author()} and ${author()} and ${author()}},`,
        `  title   = {${sentence(rand).slice(0, -1)}},`,
        `  journal = {Journal of Synthetic Results},`,
        `  year    = {${1980 + (i % 45)}},`,
        `  volume  = {${1 + (i % 90)}},`,
        `  pages   = {${i}--${i + 12}}`,
        `}`
      ].join('\n')
    )
  }
  return entries.join('\n\n') + '\n'
}

/** 1×1 white PNG (valid, tiny) — scaled up by \includegraphics. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

export async function generateThesis(
  dir: string,
  opts: ThesisOptions = DEFAULT_OPTIONS
): Promise<{ files: number; bytes: number }> {
  const rand = rng(0xc0ffee)
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(path.join(dir, 'chapters'), { recursive: true })
  await fs.mkdir(path.join(dir, 'figures'), { recursive: true })

  const includes: string[] = []
  let bytes = 0
  for (let i = 1; i <= opts.chapters; i++) {
    const name = `chapters/chapter${String(i).padStart(3, '0')}`
    const tex = chapterTex(i, opts, rand)
    await fs.writeFile(path.join(dir, `${name}.tex`), tex)
    bytes += tex.length
    includes.push(`\\include{${name}}`)
  }

  const main = [
    '\\documentclass[11pt]{book}',
    '\\usepackage[T1]{fontenc}',
    '\\usepackage{amsmath,amssymb}',
    '\\usepackage{graphicx}',
    '\\usepackage{natbib}',
    '\\usepackage{hyperref}',
    '\\title{A Synthetic Thesis at Scale}',
    '\\author{Stress Test}',
    '\\begin{document}',
    '\\maketitle',
    '\\tableofcontents',
    ...includes,
    '\\bibliographystyle{plainnat}',
    '\\bibliography{refs}',
    '\\end{document}',
    ''
  ].join('\n')
  await fs.writeFile(path.join(dir, 'main.tex'), main)
  const bibTex = bib(opts, rand)
  await fs.writeFile(path.join(dir, 'refs.bib'), bibTex)
  await fs.writeFile(path.join(dir, 'figures/plot.png'), PNG_1X1)
  bytes += main.length + bibTex.length + PNG_1X1.length
  return { files: opts.chapters + 3, bytes }
}
