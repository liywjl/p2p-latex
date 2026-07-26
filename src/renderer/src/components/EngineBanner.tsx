interface Props {
  onRedetect: () => void
}

const LINKS = [
  { label: 'Tectonic (small, self-contained)', url: 'https://tectonic-typesetting.github.io/en-US/install.html' },
  { label: 'MacTeX', url: 'https://tug.org/mactex/' },
  { label: 'TeX Live', url: 'https://tug.org/texlive/' }
]

export function EngineBanner({ onRedetect }: Props): React.JSX.Element {
  return (
    <div className="engine-banner">
      <span>
        No LaTeX engine found. Install one (it stays yours — this app never bundles TeX):
        {LINKS.map((l) => (
          <a key={l.url} onClick={() => window.api.openExternal(l.url)}>
            {l.label}
          </a>
        ))}
        <code>brew install tectonic</code> is the quickest.
      </span>
      <button onClick={onRedetect}>Re-detect</button>
    </div>
  )
}
