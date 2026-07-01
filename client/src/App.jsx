import { useState, useCallback } from 'react'
import { Tldraw, createTLStore } from '@tldraw/tldraw'
import '@tldraw/tldraw/tldraw.css'

const STYLES = {
  container: {
    position: 'fixed',
    inset: 0,
    overflow: 'hidden',
  },
}

export default function App() {
  const [store] = useState(() => createTLStore())
  const [mounted, setMounted] = useState(false)

  const handleMount = useCallback((editor) => {
    console.log('[InfCanvas] Editor mounted', editor)
    setMounted(true)

    let saveTimer = null
    const unsub = editor.store.listen(() => {
      clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        try {
          const snap = editor.getSnapshot()
          const ourData = convertFromTldraw(snap, editor)
          fetch('/api/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(ourData),
          }).catch(e => console.error('保存请求失败:', e))
        } catch (e) {
          console.error('保存失败:', e)
        }
      }, 1000)
    })

    const handleBeforeUnload = () => clearTimeout(saveTimer)
    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      unsub()
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [])

  return (
    <div style={STYLES.container}>
      {!mounted && (
        <div style={{ padding: 20, color: '#666' }}>加载画布编辑器中...</div>
      )}
      <Tldraw store={store} onMount={handleMount} />
    </div>
  )
}

function convertFromTldraw(snapshot, editor) {
  const records = Object.values(snapshot?.store || snapshot)
  const pageRecords = records.filter(r => r?.typeName === 'page')
  const shapeRecords = records.filter(r => r?.typeName === 'shape')
  const assetRecords = records.filter(r => r?.typeName === 'asset')

  const pages = pageRecords.map((p, i) => ({
    id: p.id,
    name: p.name,
    index: i,
  }))

  const shapes = shapeRecords.map(s => {
    if (!s) return null
    return {
      id: s.id,
      z: s.index,
      x: s.x,
      y: s.y,
      rotation: s.rotation || 0,
      pageId: s.parentId || 'page:default',
      type: s.type === 'image' ? 'image' : 'ai-image-holder',
      props: { w: s.props?.w || 512, h: s.props?.h || 512 },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
  }).filter(Boolean)

  const assets = assetRecords.filter(Boolean).map(a => ({
    id: a.id,
    type: 'image',
    src: a.props?.src || '',
    w: a.props?.w,
    h: a.props?.h,
  }))

  let viewState = {}
  try {
    const camera = editor.getCamera()
    viewState = {
      currentPageId: editor.getCurrentPageId() || 'page:default',
      cameraX: camera?.x || 0,
      cameraY: camera?.y || 0,
      cameraZ: camera?.z || 1,
    }
  } catch {
    viewState = {
      currentPageId: 'page:default',
      cameraX: 0, cameraY: 0, cameraZ: 1,
    }
  }

  return { snapshot: { pages, shapes, assets }, viewState }
}
