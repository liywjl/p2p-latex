import { useState } from 'react'

interface Props {
  onOpenFolder: () => Promise<void>
  onJoin: (inviteKey: string, destFolder: string) => Promise<void>
  onOpenRecent: (root: string) => Promise<void>
}

export function WelcomeScreen({ onOpenFolder, onJoin, onOpenRecent }: Props): React.JSX.Element {
  const [inviteKey, setInviteKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [joining, setJoining] = useState(false)
  const recents: string[] = JSON.parse(localStorage.getItem('recentProjects') ?? '[]')

  const join = async (): Promise<void> => {
    setError(null)
    if (!inviteKey.trim()) {
      setError('Paste an invite key first')
      return
    }
    const dest = await window.api.openFolderDialog()
    if (!dest) return
    setJoining(true)
    try {
      await onJoin(inviteKey.trim(), dest)
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^.*Error: /, '') : 'Failed to join')
      setJoining(false)
    }
  }

  return (
    <div className="welcome">
      <div className="welcome-card">
        <h1>P2P LaTeX</h1>
        <p className="tagline">
          Edit LaTeX locally. Share and co-write over an encrypted peer-to-peer connection —
          no server, no account, no fees.
        </p>

        <div className="welcome-actions">
          <button className="primary big" onClick={onOpenFolder}>
            Open a project folder
          </button>

          <div className="join-box">
            <div className="join-title">Join a colleague’s project</div>
            <input
              placeholder="paste invite key…"
              value={inviteKey}
              onChange={(e) => setInviteKey(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && join()}
              spellCheck={false}
            />
            <button onClick={join} disabled={joining}>
              {joining ? 'Connecting…' : 'Choose folder & join'}
            </button>
            {error && <div className="join-error">{error}</div>}
            <div className="join-hint">
              You’ll pick an empty folder to hold your copy; the project syncs into it and stays
              in sync while you both edit.
            </div>
          </div>
        </div>

        {recents.length > 0 && (
          <div className="recents">
            <div className="recents-title">Recent projects</div>
            {recents.map((r) => (
              <div key={r} className="recent-row" onClick={() => onOpenRecent(r)} title={r}>
                {r}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
