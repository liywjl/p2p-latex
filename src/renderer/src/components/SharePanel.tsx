import { useState } from 'react'
import type { SwarmStatus } from '../../../shared/types'

export interface Collaborator {
  name: string
  color: string
}

interface Props {
  swarm: SwarmStatus
  syncing: boolean
  collaborators: Collaborator[]
  userName: string
  hasSavedSession: boolean
  onUserNameChange: (name: string) => void
  onShare: () => Promise<void>
  onReconnect: () => Promise<void>
  onForget: () => Promise<void>
  onLeave: () => Promise<void>
}

export function SharePanel({
  swarm,
  syncing,
  collaborators,
  userName,
  hasSavedSession,
  onUserNameChange,
  onShare,
  onReconnect,
  onForget,
  onLeave
}: Props): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const [starting, setStarting] = useState(false)

  const copyKey = (): void => {
    if (swarm.mode === 'none') return
    navigator.clipboard.writeText(swarm.inviteKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="sidebar-section share-section">
      <div className="sidebar-title">Collaboration</div>
      <div className="share-body">
        <label className="name-row">
          <span>Your name</span>
          <input
            value={userName}
            onChange={(e) => onUserNameChange(e.target.value)}
            maxLength={24}
          />
        </label>

        {swarm.mode === 'none' && (
          <>
            <button
              className="primary wide"
              disabled={starting}
              onClick={async () => {
                setStarting(true)
                try {
                  await (hasSavedSession ? onReconnect() : onShare())
                } finally {
                  setStarting(false)
                }
              }}
            >
              {starting
                ? 'Connecting…'
                : hasSavedSession
                  ? 'Reconnect to shared session'
                  : 'Share this project'}
            </button>
            {hasSavedSession && (
              <button className="link-button" onClick={onForget}>
                forget this session
              </button>
            )}
          </>
        )}

        {swarm.mode !== 'none' && (
          <>
            <div className="invite-block">
              <div className="invite-label">
                {swarm.mode === 'hosting' ? 'Invite key — send to colleagues:' : 'Connected with key:'}
              </div>
              <code className="invite-key" onClick={copyKey} title="Click to copy">
                {swarm.inviteKey}
              </code>
              <button className="wide" onClick={copyKey}>
                {copied ? 'Copied ✓' : 'Copy invite key'}
              </button>
            </div>
            {syncing && <div className="sync-note">syncing project…</div>}
            <div className="peer-list">
              {collaborators.length === 0 ? (
                <div className="peer-row muted">
                  {swarm.peers.length === 0 ? 'waiting for peers…' : 'peer connected, handshaking…'}
                </div>
              ) : (
                collaborators.map((c, i) => (
                  <div key={i} className="peer-row">
                    <span className="peer-dot" style={{ background: c.color }} />
                    {c.name}
                  </div>
                ))
              )}
            </div>
            <button className="wide danger" onClick={onLeave}>
              {swarm.mode === 'hosting' ? 'Stop sharing' : 'Leave session'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
