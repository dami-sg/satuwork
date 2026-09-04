;(function () {
  'use strict'

  const page = document.body
  const kind = page.dataset.kind || 'unknown'
  const name = page.dataset.name || '文档'
  const rawUrl = page.dataset.rawUrl || ''
  const host = document.getElementById('preview-body')
  const tabs = document.getElementById('preview-tabs')
  const sizeNode = document.getElementById('preview-size')
  const downloadButton = document.getElementById('preview-download')
  const closeButton = document.getElementById('preview-close')
  const modes = Array.from(document.querySelectorAll('[data-mode]'))
  const TEXT_MAX = 2 * 1024 * 1024
  const BINARY_MAX = 25 * 1024 * 1024
  let mode = 'view'
  let source = ''
  let fileBlob = null
  let frameUrl = ''

  function fileSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return ''
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0) + ' MB'
  }

  function revokeFrame() {
    if (!frameUrl) return
    URL.revokeObjectURL(frameUrl)
    frameUrl = ''
  }

  function clear(flow) {
    revokeFrame()
    host.replaceChildren()
    host.dataset.flow = flow
  }

  function note(text, error) {
    clear('center')
    const p = document.createElement('p')
    p.className = 'sw-preview-note' + (error ? ' sw-preview-err' : '')
    p.textContent = text
    host.appendChild(p)
  }

  function frame(blob, sandboxed) {
    clear('top')
    frameUrl = URL.createObjectURL(blob)
    const box = document.createElement('div')
    box.className = 'sw-preview-load'
    box.dataset.busy = '1'
    const spin = document.createElement('span')
    spin.className = 'sw-preview-spin'
    spin.setAttribute('aria-hidden', 'true')
    const iframe = document.createElement('iframe')
    iframe.className = 'sw-preview-frame'
    iframe.src = frameUrl
    iframe.title = name
    iframe.referrerPolicy = 'no-referrer'
    if (sandboxed) iframe.setAttribute('sandbox', '')
    iframe.addEventListener('load', () => box.removeAttribute('data-busy'))
    iframe.addEventListener('error', () => box.removeAttribute('data-busy'))
    box.append(spin, iframe)
    host.appendChild(box)
  }

  function render() {
    for (const button of modes) button.toggleAttribute('data-on', button.dataset.mode === mode)
    if (kind === 'pdf') {
      frame(new Blob([fileBlob], { type: 'application/pdf' }), false)
      return
    }
    if (kind === 'html' && mode === 'view') {
      frame(new Blob([source], { type: 'text/html; charset=utf-8' }), true)
      return
    }
    if (kind === 'markdown' && mode === 'view') {
      clear('top')
      const markdown = document.createElement('div')
      markdown.className = 'sw-preview-md sw-md'
      if (window.satuMd) {
        markdown.innerHTML = window.satuMd.render(source)
        window.satuMd.enhance(markdown)
      } else markdown.textContent = source
      host.appendChild(markdown)
      return
    }
    clear('top')
    const pre = document.createElement('pre')
    pre.className = 'sw-preview-src'
    pre.textContent = source
    host.appendChild(pre)
  }

  async function load() {
    if (!['html', 'markdown', 'pdf', 'text'].includes(kind)) {
      tabs.hidden = true
      note('这个文件暂不支持在线预览，请下载后查看。')
      return
    }
    try {
      const response = await fetch(rawUrl, { headers: { accept: 'application/octet-stream' } })
      if (!response.ok) throw new Error(response.status === 404 ? '预览链接不存在或已过期' : '文件读取失败（HTTP ' + response.status + '）')
      const announced = Number(response.headers.get('content-length') || 0)
      const limit = kind === 'pdf' ? BINARY_MAX : TEXT_MAX
      if (announced && announced > limit) throw new Error('文件太大，不能在线预览，请下载后查看。')
      fileBlob = await response.blob()
      if (fileBlob.size > limit) throw new Error('文件太大，不能在线预览，请下载后查看。')
      sizeNode.textContent = fileBlob.size ? ' · ' + fileSize(fileBlob.size) : ''
      if (kind !== 'pdf') source = await fileBlob.text()
      render()
    } catch (error) {
      note(error && error.message ? error.message : '文件读取失败', true)
    }
  }

  for (const button of modes) {
    button.addEventListener('click', () => {
      const next = button.dataset.mode === 'source' ? 'source' : 'view'
      if (next === mode || !fileBlob) return
      mode = next
      render()
    })
  }

  downloadButton.addEventListener('click', async () => {
    downloadButton.disabled = true
    try {
      const blob = fileBlob || await fetch(rawUrl).then((response) => {
        if (!response.ok) throw new Error('HTTP ' + response.status)
        return response.blob()
      })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) {
      note('下载失败：' + (error && error.message ? error.message : '未知错误'), true)
    } finally {
      downloadButton.disabled = false
    }
  })

  closeButton.addEventListener('click', () => {
    window.close()
    if (!window.closed && history.length > 1) history.back()
  })
  window.addEventListener('pagehide', revokeFrame)
  void load()
})()
