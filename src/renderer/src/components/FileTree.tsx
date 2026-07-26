import { useEffect, useState } from 'react'
import type { TreeNode } from '../../../shared/types'
import { isTextPath } from '../../../shared/types'

export interface TreeActions {
  onOpen: (path: string) => void
  onRename: (node: TreeNode) => void
  onDelete: (node: TreeNode) => void
  onNewFile: (dirPath: string) => void
}

interface Props extends TreeActions {
  tree: TreeNode[]
  active: string | null
}

interface MenuState {
  node: TreeNode
  x: number
  y: number
}

function Node({
  node,
  active,
  depth,
  onOpen,
  onMenu
}: {
  node: TreeNode
  active: string | null
  depth: number
  onOpen: (path: string) => void
  onMenu: (node: TreeNode, x: number, y: number) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(depth < 2)
  const pad = { paddingLeft: `${depth * 14 + 8}px` }
  const ctx = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    onMenu(node, e.clientX, e.clientY)
  }

  if (node.type === 'dir') {
    return (
      <div>
        <div className="tree-row dir" style={pad} onClick={() => setOpen((o) => !o)} onContextMenu={ctx}>
          <span className="tree-arrow">{open ? '▾' : '▸'}</span> {node.name}
        </div>
        {open &&
          (node.children ?? []).map((c) => (
            <Node key={c.path} node={c} active={active} depth={depth + 1} onOpen={onOpen} onMenu={onMenu} />
          ))}
      </div>
    )
  }

  const editable = isTextPath(node.path)
  return (
    <div
      className={`tree-row file ${node.path === active ? 'active' : ''} ${editable ? '' : 'binary'}`}
      style={pad}
      onClick={() => editable && onOpen(node.path)}
      onContextMenu={ctx}
      title={editable ? node.path : `${node.path} (binary — synced but not editable)`}
    >
      {node.name}
    </div>
  )
}

export function FileTree({
  tree,
  active,
  onOpen,
  onRename,
  onDelete,
  onNewFile
}: Props): React.JSX.Element {
  const [menu, setMenu] = useState<MenuState | null>(null)

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close, { capture: true })
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close, { capture: true })
    }
  }, [menu])

  if (tree.length === 0) return <div className="tree-empty">empty folder</div>

  return (
    <div className="file-tree">
      {tree.map((n) => (
        <Node
          key={n.path}
          node={n}
          active={active}
          depth={0}
          onOpen={onOpen}
          onMenu={(node, x, y) => setMenu({ node, x, y })}
        />
      ))}
      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
          {menu.node.type === 'dir' && (
            <div className="menu-item" onClick={() => onNewFile(menu.node.path)}>
              New file here…
            </div>
          )}
          <div className="menu-item" onClick={() => onRename(menu.node)}>Rename…</div>
          <div className="menu-item danger" onClick={() => onDelete(menu.node)}>Delete</div>
        </div>
      )}
    </div>
  )
}
