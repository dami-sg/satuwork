import { Confirm, html, icon, ICONS, NavItem, useEffect, useHost, useState, t } from '@satu/shell'
import { stripTopDir, toPayload, unzip } from './unzip.js'

/**
 * Skill 与 MCP。
 *
 * 三段东西的真实程度不一样，这一屏**逐段说清楚**：内置工具是此刻真能调的；Skill
 * 与 MCP 服务器的定义是真的（建了就落库）；而 Skill 的执行与 MCP 的连接还没接上，
 * 所以「调用了多少次」「提供几个工具」这两栏没有数字可填——不编。
 */

const ICON = [
  'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
]
const EDIT = ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z']
const FILE = ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6']
const UPLOAD = ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 9 5-5 5 5', 'M12 4v12']
const CHECK = ['m5 13 4 4L19 7']
const TRASH = ['M3 6h18', 'M8 6V4h8v2', 'M6 6l1 14h10l1-14']

const SOURCES = () => [
  { key: '手动编写', label: t('手动编写', 'Write it here') },
  { key: '单文件 Skill', label: t('单文件 Skill', 'Single file') },
  { key: 'ZIP 包', label: t('ZIP 包', 'ZIP package') },
]
const KINDS = ['stdio', 'SSE', 'HTTP']
const PERMS = () => [
  { key: '只读', label: t('只读', 'Read only'), tag: 'tag-neutral' },
  { key: '可写', label: t('可写', 'Read/write'), tag: 'tag-accent' },
  { key: '需审批', label: t('需审批', 'Ask first'), tag: 'tag-accent-2' },
]
const PERM_TAG = (perm) => PERMS().find((p) => p.key === perm)?.tag ?? 'tag-neutral'

const day = (ts) => new Date(ts).toISOString().slice(0, 10)
const kb = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
/** 和服务端同一条规则：列表项就是步骤。两边算得不一样的话，卡片会和正文对不上。 */
const stepsOf = (body) => body.split('\n').filter((l) => /^\s*(?:\d+[.)]|[-*+])\s+/.test(l)).length

function SkillsNav({ ctx, path }) {
  return html`<${NavItem} ctx=${ctx} path=${path} href="/skills" icon=${icon(ICON)} label=${t('Skill 与 MCP', 'Skills & MCP')} />`
}

function Notice({ text }) {
  return html`<div style="flex: 1; display: flex; align-items: center; justify-content: center; color: var(--muted-foreground);">${text}</div>`
}

/** 空态。说清楚是「还没建」，不是「坏了」，并且把下一步指出来。 */
function Empty({ title, note }) {
  return html`
    <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: var(--space-8) var(--space-4); border: 1px dashed var(--input-border); border-radius: var(--radius-lg); background: var(--card);">
      <div style="font-size: 14px; font-weight: 600;">${title}</div>
      <div style="font-size: 12.5px; color: var(--muted-foreground);">${note}</div>
    </div>
  `
}

function Field({ label, hint, children, htmlFor }) {
  return html`
    <div class="field">
      ${label && html`<label for=${htmlFor}>${label}</label>`}
      ${children}
      ${hint && html`<span style="font-size: 12px; color: var(--muted-foreground);">${hint}</span>`}
    </div>
  `
}

/** 一排单选块。稿子里创建方式、传输、权限用的是同一个件。 */
function Picks({ label, options, value, onPick, hint }) {
  return html`
    <${Field} label=${label} hint=${hint}>
      <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">
        ${options.map(
          (o) => html`
            <button
              key=${o.key}
              type="button"
              class="satu-assignee"
              style="padding: 5px 12px;"
              aria-pressed=${String(value === o.key)}
              onClick=${() => onPick(o.key)}
            >${o.label}</button>
          `,
        )}
      </div>
    <//>
  `
}

/**
 * 标签：选、新建、删除。
 *
 * 稿子上是固定的八个，但归类这种东西没法预先列全——所以那八个只是**初值**，可以
 * 现场加。删除是另一回事：标签删掉之后，挂着它的 Skill 上那一个也会跟着没，所以
 * 删除单独一档「管理」模式，不和选择混在一排里点。
 */
function TagPicker({ known, picked, onPick, onCreate, onDelete }) {
  const [manage, setManage] = useState(false)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')

  const create = () => {
    const tag = draft.trim()
    if (!tag) return setAdding(false)
    if (!known.includes(tag)) onCreate(tag)
    if (!picked.includes(tag)) onPick(tag)
    setDraft('')
    setAdding(false)
  }

  return html`
    <div class="field">
      <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);">
        <label style="margin: 0;">${t('标签', 'Tags')}</label>
        <button type="button" class="satu-linkbtn" style="font-size: 12px;" onClick=${() => setManage(!manage)}>
          ${manage ? t('完成', 'Done') : t('管理', 'Manage')}
        </button>
      </div>
      <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">
        ${known.map((tag) =>
          manage
            ? html`
                <button
                  key=${tag}
                  type="button"
                  class="satu-assignee"
                  style="padding: 5px 10px 5px 12px; gap: 6px; color: var(--color-accent-800);"
                  aria-label=${t(`删除标签 ${tag}`, `Delete tag ${tag}`)}
                  onClick=${() => onDelete(tag)}
                >${tag} ${icon(ICONS.close, 12)}</button>
              `
            : html`
                <button
                  key=${tag}
                  type="button"
                  class="satu-assignee"
                  style="padding: 5px 12px;"
                  aria-pressed=${String(picked.includes(tag))}
                  onClick=${() => onPick(tag)}
                >${tag}</button>
              `,
        )}
        ${!manage &&
        (adding
          ? html`
              <input
                class="input"
                style="width: 120px; padding: 4px 10px; font-size: 13px;"
                autofocus
                value=${draft}
                onInput=${(e) => setDraft(e.target.value)}
                onBlur=${create}
                onKeyDown=${(e) => {
                  if (e.key === 'Enter') {
                    // 这颗回车是给标签的，不是给整个表单的——不拦住它，新建标签会
                    // 顺手把 Skill 也提交了。
                    e.preventDefault()
                    create()
                  }
                  if (e.key === 'Escape') setAdding(false)
                }}
                placeholder=${t('新标签', 'New tag')}
              />
            `
          : html`
              <button type="button" class="satu-assignee" style="padding: 5px 12px;" onClick=${() => setAdding(true)}>
                ${icon(ICONS.plus, 12)} ${t('新建标签', 'New tag')}
              </button>
            `)}
      </div>
      <span style="font-size: 12px; color: var(--muted-foreground);">
        ${manage
          ? t('点一个标签把它删掉——用到它的 Skill 上那一个也会一起去掉。', 'Click a tag to delete it — it is removed from every skill that uses it.')
          : t('可多选，用于筛选与归类', 'Multi-select, used for filtering')}
      </span>
    </div>
  `
}

/**
 * ZIP 包 Skill 的包内文件：左边一棵树，右边编辑。
 *
 * 文件是**当场存盘**的：点开一个改完，切走就写回去。这里不做「整包暂存、保存时一
 * 起提交」——那需要在浏览器里维护一份完整副本，而包里可能有二进制。改哪个存哪个，
 * 代价是多几次请求，换来的是不会有一份和磁盘不一致的中间态。
 */
function PackageFiles({ ctx, skill, onError }) {
  const [files, setFiles] = useState([])
  const [current, setCurrent] = useState(null)
  const [text, setText] = useState('')
  const [dirty, setDirty] = useState(false)
  const [confirm, setConfirm] = useState(null)

  const load = async () => {
    try {
      const { files: list } = await ctx.host.get(`/api/skills/${skill.id}/files`)
      setFiles(list)
      return list
    } catch (e) {
      onError(e.message)
      return []
    }
  }

  useEffect(() => {
    load().then((list) => {
      const first = list.find((f) => f.path.toLowerCase() === 'skill.md') ?? list.find((f) => !f.binary)
      if (first) open(first)
    })
  }, [skill.id])

  const open = async (file) => {
    if (dirty && current) await save()
    setCurrent(file)
    setText('')
    if (file.binary) return
    try {
      const { text: body } = await ctx.host.get(`/api/skills/${skill.id}/files/${encodeURIComponent(file.path)}`)
      setText(body)
      setDirty(false)
    } catch (e) {
      onError(e.message)
    }
  }

  const save = async () => {
    if (!current || current.binary) return
    try {
      const { files: list } = await ctx.host.put(`/api/skills/${skill.id}/files/${encodeURIComponent(current.path)}`, { text })
      setFiles(list)
      setDirty(false)
    } catch (e) {
      onError(e.message)
    }
  }

  /** 添加文件走同一条写入路径：新路径 PUT 一次就是新增。 */
  const add = async (e) => {
    const picked = [...(e.target.files ?? [])]
    e.target.value = ''
    for (const file of picked) {
      try {
        await ctx.host.put(`/api/skills/${skill.id}/files/${encodeURIComponent(file.name)}`, { text: await file.text() })
      } catch (err) {
        onError(err.message)
      }
    }
    const list = await load()
    const added = list.find((f) => f.path === picked[0]?.name)
    if (added) open(added)
  }

  const remove = async (file) => {
    try {
      const { files: list } = await ctx.host.delete(`/api/skills/${skill.id}/files/${encodeURIComponent(file.path)}`)
      setFiles(list)
      if (current?.path === file.path) {
        setCurrent(null)
        setText('')
        setDirty(false)
      }
    } catch (e) {
      onError(e.message)
    }
  }

  const bytes = files.reduce((n, f) => n + f.size, 0)

  return html`
    <div class="field">
      <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);">
        <label style="margin: 0;">${t('包内文件', 'Files in the package')}</label>
        <span style="font-size: 12px; color: var(--muted-foreground);">${t(`${files.length} 个文件 · ${kb(bytes)}`, `${files.length} files · ${kb(bytes)}`)}</span>
      </div>
      <div class="satu-filesplit">
        <div class="satu-filetree">
          ${files.map(
            (file) => html`
              <button
                key=${file.path}
                type="button"
                class="satu-fileitem"
                aria-current=${String(current?.path === file.path)}
                style=${`padding-left: ${8 + file.path.split('/').length * 8}px;`}
                onClick=${() => open(file)}
              >
                <span class="satu-fileicon">${icon(FILE, 13)}</span>
                <span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${file.path.split('/').pop()}</span>
                ${dirty && current?.path === file.path &&
                html`<span style="margin-left: auto; width: 6px; height: 6px; flex: none; border-radius: 999px; background: var(--color-accent);"></span>`}
              </button>
            `,
          )}
          <label class="satu-fileadd">
            <input type="file" multiple style="position: absolute; inset: 0; opacity: 0; cursor: pointer;" onChange=${add} />
            ${icon(ICONS.plus, 13)} ${t('添加文件', 'Add files')}
          </label>
        </div>

        <div class="satu-fileeditor">
          ${current
            ? html`
                <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding-bottom: var(--space-2); border-bottom: 1px solid var(--border);">
                  <span style="font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${current.path}</span>
                  <div style="display: flex; align-items: center; gap: var(--space-2); flex: none;">
                    <span style="font-size: 12px; color: var(--muted-foreground);">${kb(current.size)}${dirty ? t(' · 未保存', ' · unsaved') : ''}</span>
                    <button type="button" class="btn btn-ghost btn-icon" aria-label=${t('删除文件', 'Delete file')} onClick=${() => setConfirm(current)}>${icon(TRASH, 15)}</button>
                  </div>
                </div>
                ${current.binary
                  ? html`
                      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: var(--space-8) var(--space-4); border: 1px dashed var(--input-border); border-radius: var(--radius-md); background: var(--card);">
                        <span style="font-size: 13.5px; font-weight: 600;">${t('二进制文件不能在线编辑', 'Binary files cannot be edited here')}</span>
                        <span style="font-size: 12px; color: var(--muted-foreground);">${t('可以下载后替换，或直接删掉它', 'Download and replace it, or delete it')}</span>
                        <a
                          class="btn btn-secondary"
                          style="margin-top: var(--space-2);"
                          href=${`/api/skills/${skill.id}/files/${encodeURIComponent(current.path)}`}
                          download=${current.path.split('/').pop()}
                        >${t('下载', 'Download')}</a>
                      </div>
                    `
                  : html`
                      <textarea
                        class="input satu-code"
                        rows="14"
                        value=${text}
                        onInput=${(e) => {
                          setText(e.target.value)
                          setDirty(true)
                        }}
                        onBlur=${save}
                      ></textarea>
                    `}
              `
            : html`
                <div style="display: flex; align-items: center; justify-content: center; padding: var(--space-8) var(--space-4); font-size: 13px; color: var(--muted-foreground);">
                  ${files.length ? t('左边选一个文件', 'Pick a file on the left') : t('这个包里还没有文件', 'This package has no files')}
                </div>
              `}
        </div>
      </div>
      <span style="font-size: 12px; color: var(--muted-foreground);">
        ${t('改完切走或失焦即存盘；SKILL.md 同时也是这个 Skill 的正文。', 'Edits save on blur; SKILL.md doubles as the skill definition.')}
      </span>

      ${confirm &&
      html`
        <${Confirm}
          title=${t('删除这个文件？', 'Delete this file?')}
          body=${t(`「${confirm.path}」会从包里删掉，磁盘上那份也一起没。`, `${confirm.path} is removed from the package and from disk.`)}
          confirmLabel=${t('删除', 'Delete')}
          onCancel=${() => setConfirm(null)}
          onConfirm=${() => {
            const file = confirm
            setConfirm(null)
            remove(file)
          }}
        />
      `}
    </div>
  `
}

/** 保存后立即启用。稿子上两个框底部都有这一行。 */
function EnableRow({ enabled, onToggle }) {
  return html`
    <div class="satu-toggleRow" style="border-top: 0; padding: 0;">
      <div>
        <div style="font-size: 13.5px; font-weight: 600;">${t('保存后立即启用', 'Enable on save')}</div>
        <div style="font-size: 12px; color: var(--muted-foreground);">${t('关闭则仅保存，不对 Agent 开放', 'Off means saved but not offered to agents')}</div>
      </div>
      <button type="button" class="satu-switch" aria-pressed=${String(enabled)} aria-label=${t('立即启用', 'Enable')} onClick=${onToggle}><span></span></button>
    </div>
  `
}

/**
 * 两个框共用的壳。
 *
 * z-index 压在 `Confirm` 的 25 之下：删除确认是**从这个框里**弹出来的，盖在它底下
 * 就等于点了没反应。
 */
function Dialog({ width = '560px', title, sub, onClose, onSubmit, children, error, busy, submitLabel, onDelete, deleteLabel }) {
  return html`
    <div
      style="position: fixed; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center; padding: var(--space-6); background: color-mix(in srgb, var(--color-neutral-900) 42%, transparent);"
      onClick=${(e) => e.target === e.currentTarget && onClose()}
    >
      <form
        onSubmit=${onSubmit}
        style=${`width: 100%; max-width: ${width}; max-height: 88vh; overflow-y: auto; box-sizing: border-box; background: var(--popover); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); padding: var(--space-6); display: flex; flex-direction: column; gap: var(--space-4);`}
      >
        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h2 style="font-size: 20px; margin: 0 0 4px;">${title}</h2>
            <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${sub}</p>
          </div>
          <button type="button" class="btn btn-ghost btn-icon" aria-label=${t('关闭', 'Close')} onClick=${onClose}>${icon(ICONS.close, 16)}</button>
        </div>

        ${children}

        ${error &&
        html`<div style="font-size: 13px; color: var(--color-accent-800); background: var(--color-accent-100); border-radius: var(--radius-sm); padding: 10px var(--space-3);">${error}</div>`}

        <div style="display: flex; align-items: center; justify-content: flex-end; gap: var(--space-2);">
          ${onDelete &&
          html`<button type="button" class="satu-linkbtn" style="margin-right: auto; color: var(--color-accent-800);" onClick=${onDelete}>${deleteLabel}</button>`}
          <button type="button" class="btn btn-secondary" onClick=${onClose}>${t('取消', 'Cancel')}</button>
          <button type="submit" class="btn btn-primary" disabled=${busy}>${busy ? t('保存中…', 'Saving…') : submitLabel}</button>
        </div>
      </form>
    </div>
  `
}

/**
 * 新建 / 编辑 Skill。
 *
 * 三种来源存下来是**同一样东西**：一份正文，外加（ZIP 包才有的）一堆文件。所以编辑
 * 时手动写的和单文件导入的共用一个编辑框，ZIP 包多一棵文件树，而正文那一份始终是
 * 包里的 SKILL.md。
 */
function SkillDialog({ ctx, skill, knownTags, onTags, onClose, onSaved, onDeleted }) {
  const [name, setName] = useState(skill?.name ?? '')
  const [source, setSource] = useState(skill?.source ?? '手动编写')
  const [body, setBody] = useState(skill?.body ?? '')
  const [tags, setTags] = useState(skill?.tags ?? [])
  const [enabled, setEnabled] = useState(skill ? skill.enabled : true)
  const [file, setFile] = useState(null)
  /** ZIP 解出来的清单，保存时随创建请求一起发上去。 */
  const [entries, setEntries] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [tagPendingDelete, setTagPendingDelete] = useState(null)

  const zip = source === 'ZIP 包'
  const upload = source !== '手动编写' && !skill
  const isPackage = skill?.source === 'ZIP 包'

  /** 单文件：在浏览器里读成文本。这份东西本来就是文本，没必要为它开一条上传通道。 */
  const takeFile = async (e) => {
    const picked = e.target.files?.[0]
    if (!picked) return
    const text = await picked.text()
    setBody(text)
    setFile({ name: picked.name, size: picked.size })
    if (!name) setName(picked.name.replace(/\.(md|markdown|ya?ml|json)$/i, ''))
    setError(null)
  }

  /**
   * ZIP：**先在浏览器里解开**，把清单摆出来，确认了再传。
   *
   * 传上去的是一份已经看明白的文件列表，不是一个待拆的黑盒；名称与正文也就能在
   * 保存之前先从 SKILL.md 读出来给人看。
   */
  const takeZip = async (e) => {
    const picked = e.target.files?.[0]
    if (!picked) return
    setError(null)
    try {
      const list = stripTopDir(await unzip(picked))
      const readme = list.find((f) => f.path.toLowerCase() === 'skill.md')
      if (!readme) throw new Error('包的根目录里没有 SKILL.md')
      setEntries(list)
      setFile({ name: picked.name, size: picked.size })
      setBody(new TextDecoder().decode(readme.bytes))
      if (!name) setName(picked.name.replace(/[-_]?skill\.zip$|\.zip$/i, ''))
    } catch (err) {
      setEntries(null)
      setFile(null)
      setError(err.message)
    }
  }

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const payload = { name, body, tags, enabled, source, fileName: file?.name ?? skill?.fileName }
      if (zip && entries) payload.files = toPayload(entries)
      if (skill) await ctx.host.patch(`/api/skills/${skill.id}`, payload)
      else await ctx.host.post('/api/skills', payload)
      onSaved()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return html`
    <${Dialog}
      width=${isPackage ? '860px' : '560px'}
      title=${skill ? t('编辑 Skill', 'Edit skill') : t('新建 Skill', 'New skill')}
      sub=${t('Skill 把一组步骤和 MCP 工具打包成可复用的工作方法。', 'A skill packages steps and tools into a reusable method.')}
      onClose=${onClose}
      onSubmit=${submit}
      error=${error}
      busy=${busy}
      submitLabel=${skill ? t('保存修改', 'Save changes') : t('保存', 'Save')}
      onDelete=${skill && (() => setConfirm(true))}
      deleteLabel=${t('删除这个 Skill', 'Delete this skill')}
    >
      <${Field} label=${t('名称', 'Name')} htmlFor="sk-name">
        <input class="input" id="sk-name" type="text" required value=${name} onInput=${(e) => setName(e.target.value)} placeholder=${t('例如：工单归类与摘要', 'e.g. Triage and summarise tickets')} />
      <//>

      ${!skill &&
      html`
        <${Picks}
          label=${t('创建方式', 'How to create it')}
          options=${SOURCES()}
          value=${source}
          onPick=${(key) => {
            setSource(key)
            setFile(null)
          }}
        />
      `}

      ${upload &&
      html`
        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <label class="satu-drop">
            <input
              type="file"
              accept=${zip ? '.zip' : '.md,.markdown,.yaml,.yml,.json,.txt'}
              style="position: absolute; inset: 0; opacity: 0; cursor: pointer;"
              onChange=${zip ? takeZip : takeFile}
            />
            <span class="satu-dropicon">${icon(UPLOAD, 20)}</span>
            <span style="font-size: 14px; font-weight: 600;">
              ${zip ? t('选择 .zip 技能包', 'Pick a .zip package') : t('选择 SKILL.md / .yaml / .json', 'Pick a SKILL.md / .yaml / .json')}
            </span>
            <span style="font-size: 12px; color: var(--muted-foreground); text-align: center;">
              ${zip
                ? t('就在这台浏览器里解开，看清楚了再保存。', 'It is unpacked right here in the browser — you see it before it is saved.')
                : t('文件内容就是这个 Skill 的定义，导入后可以直接在下面改。', 'The file content becomes the definition; you can edit it below.')}
            </span>
          </label>

          ${zip &&
          html`
            <div style="display: flex; flex-direction: column; gap: 6px; padding: var(--space-3) var(--space-4); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md);">
              <span class="satu-panel-title">${t('ZIP 包结构要求', 'What the ZIP must contain')}</span>
              ${[
                t('根目录含 SKILL.md（名称、说明、步骤）', 'SKILL.md at the root (name, description, steps)'),
                t('可选 scripts/、templates/、assets/ 子目录', 'Optional scripts/, templates/, assets/ subdirectories'),
                t('单包不超过 5 MB、200 个文件', 'At most 5 MB and 200 files per package'),
              ].map(
                (line) => html`
                  <div key=${line} class="satu-step" style="color: var(--muted-foreground);">${icon(CHECK, 13)} ${line}</div>
                `,
              )}
            </div>
          `}

          ${file &&
          html`
            <div class="satu-uploadrow">
              <span class="satu-dropicon" style="width: 32px; height: 32px;">${icon(FILE, 16)}</span>
              <div style="min-width: 0; flex: 1;">
                <div style="font-size: 13.5px; font-weight: 600;">${file.name}</div>
                <div style="font-size: 12px; color: var(--muted-foreground);">
                  ${kb(file.size)}${entries ? t(` · 解出 ${entries.length} 个文件`, ` · ${entries.length} files`) : ''}${t(` · 读到 ${stepsOf(body)} 个步骤`, ` · ${stepsOf(body)} steps found`)}
                </div>
              </div>
              <span class="tag tag-accent-2">${zip ? t('已解开', 'Unpacked') : t('已读取', 'Loaded')}</span>
            </div>
          `}

          ${zip && entries &&
          html`
            <div class="satu-filetree" style="max-height: 168px;">
              ${entries.map(
                (entry) => html`
                  <div key=${entry.path} class="satu-fileitem" style="cursor: default;">
                    <span class="satu-fileicon">${icon(FILE, 13)}</span>
                    <span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${entry.path}</span>
                    <span style="margin-left: auto; font-size: 11.5px; color: var(--muted-foreground);">${kb(entry.bytes.length)}</span>
                  </div>
                `,
              )}
            </div>
          `}
        </div>
      `}

      ${isPackage && html`<${PackageFiles} ctx=${ctx} skill=${skill} onError=${setError} />`}

      ${!isPackage && (!upload || file) &&
      html`
        <${Field}
          label=${skill?.fileName ?? t('Skill 说明', 'Definition')}
          htmlFor="sk-body"
          hint=${t(`按步骤写：每一条列表项算一个步骤，现在是 ${stepsOf(body)} 个。`, `Write it as steps — each list item counts as one; ${stepsOf(body)} so far.`)}
        >
          <textarea
            class=${`input${skill || file ? ' satu-code' : ''}`}
            id="sk-body"
            rows=${skill || file ? 14 : 6}
            style="border-radius: var(--radius-md); resize: vertical;"
            value=${body}
            onInput=${(e) => setBody(e.target.value)}
            placeholder=${t('描述这个 Skill 解决什么问题、按什么步骤执行', 'What it solves, and the steps to follow')}
          ></textarea>
        <//>
      `}

      <${TagPicker}
        known=${knownTags}
        picked=${tags}
        onPick=${(tag) => setTags((l) => (l.includes(tag) ? l.filter((x) => x !== tag) : [...l, tag]))}
        onCreate=${async (tag) => {
          try {
            await onTags.create(tag)
          } catch (err) {
            setError(err.message)
          }
        }}
        onDelete=${(tag) => setTagPendingDelete(tag)}
      />

      <${EnableRow} enabled=${enabled} onToggle=${() => setEnabled(!enabled)} />

      ${tagPendingDelete &&
      html`
        <${Confirm}
          title=${t(`删除标签「${tagPendingDelete}」？`, `Delete the tag "${tagPendingDelete}"?`)}
          body=${t(
            `${onTags.usedBy(tagPendingDelete)} 个 Skill 正在用它，它们身上这个标签会一起去掉。`,
            `${onTags.usedBy(tagPendingDelete)} skill(s) use it; the tag is removed from them too.`,
          )}
          confirmLabel=${t('删除标签', 'Delete tag')}
          onCancel=${() => setTagPendingDelete(null)}
          onConfirm=${async () => {
            const tag = tagPendingDelete
            setTagPendingDelete(null)
            setTags((l) => l.filter((x) => x !== tag))
            try {
              await onTags.remove(tag)
            } catch (err) {
              setError(err.message)
            }
          }}
        />
      `}

      ${confirm &&
      html`
        <${Confirm}
          title=${t('删除这个 Skill？', 'Delete this skill?')}
          body=${t(`「${skill.name}」的定义会被删除，用到它的 Agent 将不再有这项方法。`, `The definition of ${skill.name} is removed; agents using it lose the method.`)}
          confirmLabel=${t('删除', 'Delete')}
          onCancel=${() => setConfirm(false)}
          onConfirm=${async () => {
            setConfirm(false)
            try {
              await ctx.host.delete(`/api/skills/${skill.id}`)
              onDeleted()
            } catch (err) {
              setError(err.message)
            }
          }}
        />
      `}
    <//>
  `
}

/**
 * 接入 / 编辑 MCP 服务器。
 *
 * 这里存的是**连接配置**，不是连接本身——MCP 客户端还没接上，所以保存之后不会去
 * 握手，也就不知道它提供几个工具。token 存在另一处（settings 的 mcp-tokens），
 * 界面只被告知「有没有」，从服务端出来的响应里永远没有它。
 */
function ServerDialog({ ctx, server, onClose, onSaved, onDeleted }) {
  const [name, setName] = useState(server?.name ?? '')
  const [kind, setKind] = useState(server?.kind ?? 'SSE')
  const [endpoint, setEndpoint] = useState(server?.endpoint ?? '')
  const [token, setToken] = useState('')
  const [env, setEnv] = useState(server && Object.keys(server.env ?? {}).length ? JSON.stringify(server.env, null, 2) : '')
  const [perm, setPerm] = useState(server?.perm ?? '只读')
  const [enabled, setEnabled] = useState(server ? server.enabled : true)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)

  const stdio = kind === 'stdio'

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const payload = { name, kind, endpoint, env, perm, enabled }
      // token 只在真填了东西时才发：不发等于不动，那把已经存着的钥匙留在原处。
      if (token) payload.token = token
      if (server) await ctx.host.patch(`/api/mcp-servers/${server.id}`, payload)
      else await ctx.host.post('/api/mcp-servers', payload)
      onSaved()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return html`
    <${Dialog}
      width="520px"
      title=${server ? t('编辑 MCP 服务器', 'Edit MCP server') : t('接入 MCP 服务器', 'Add MCP server')}
      sub=${t('接入之后，它提供的工具即可被 Agent 调用。', 'Once connected, its tools become callable by agents.')}
      onClose=${onClose}
      onSubmit=${submit}
      error=${error}
      busy=${busy}
      submitLabel=${server ? t('保存修改', 'Save changes') : t('保存', 'Save')}
      onDelete=${server && (() => setConfirm(true))}
      deleteLabel=${t('移除这台服务器', 'Remove this server')}
    >
      <${Field} label=${t('名称', 'Name')} htmlFor="tl-name">
        <input class="input" id="tl-name" type="text" required value=${name} onInput=${(e) => setName(e.target.value)} placeholder=${t('例如：zendesk-mcp', 'e.g. zendesk-mcp')} />
      <//>

      <${Picks} label=${t('传输方式', 'Transport')} options=${KINDS.map((k) => ({ key: k, label: k }))} value=${kind} onPick=${setKind} />

      <${Field}
        label=${stdio ? t('启动命令', 'Command') : t('服务器地址', 'Server address')}
        htmlFor="tl-endpoint"
        hint=${stdio ? t('本机启动的进程，按 stdio 通信', 'A local process spoken to over stdio') : ''}
      >
        <input
          class="input"
          id="tl-endpoint"
          type="text"
          required
          value=${endpoint}
          onInput=${(e) => setEndpoint(e.target.value)}
          placeholder=${stdio ? 'npx -y @acme/mcp-server' : 'https://mcp.example.com/sse'}
          style=${stdio ? 'font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;' : ''}
        />
      <//>

      <${Field}
        label=${t('鉴权 Token（可选）', 'Auth token (optional)')}
        htmlFor="tl-token"
        hint=${server?.hasToken
          ? t('已存了一把。留空表示不动它，填了就换成新的。', 'One is stored. Leave empty to keep it, type to replace it.')
          : t('存在本机库里，不会再从服务端发回浏览器。', 'Kept in the local database and never sent back to the browser.')}
      >
        <input class="input" id="tl-token" type="password" value=${token} onInput=${(e) => setToken(e.target.value)} placeholder=${server?.hasToken ? '••••••••' : 'Bearer …'} />
      <//>

      <${Field} label=${t('环境变量（JSON，可选）', 'Environment (JSON, optional)')} htmlFor="tl-env">
        <textarea
          class="input"
          id="tl-env"
          rows="3"
          style="border-radius: var(--radius-md); resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;"
          value=${env}
          onInput=${(e) => setEnv(e.target.value)}
          placeholder=${'{"WORKSPACE_ID":"acme"}'}
        ></textarea>
      <//>

      <${Picks}
        label=${t('权限', 'Access')}
        options=${PERMS()}
        value=${perm}
        onPick=${setPerm}
        hint=${t('这一档现在只是登记，真正的拦截要等工具管线接上 MCP。', 'Recorded for now — enforcement lands when the tool pipeline speaks MCP.')}
      />

      <${EnableRow} enabled=${enabled} onToggle=${() => setEnabled(!enabled)} />

      ${confirm &&
      html`
        <${Confirm}
          title=${t('移除这台 MCP 服务器？', 'Remove this MCP server?')}
          body=${t(`「${server.name}」的连接配置与鉴权 token 一并删除。`, `The connection config and auth token for ${server.name} are both deleted.`)}
          confirmLabel=${t('移除', 'Remove')}
          onCancel=${() => setConfirm(false)}
          onConfirm=${async () => {
            setConfirm(false)
            try {
              await ctx.host.delete(`/api/mcp-servers/${server.id}`)
              onDeleted()
            } catch (err) {
              setError(err.message)
            }
          }}
        />
      `}
    <//>
  `
}

function SkillCard({ skill, onToggle, onEdit }) {
  return html`
    <div class="satu-card">
      <div style="display: flex; align-items: flex-start; gap: var(--space-3);">
        <span class="satu-providermark" style="background: var(--color-accent-100); color: var(--color-accent-800);">${icon(ICON, 16)}</span>
        <div style="flex: 1; min-width: 0;">
          <div class="satu-name">${skill.name}</div>
          <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px;">
            ${skill.tags.map((tag) => html`<span key=${tag} class="tag tag-neutral" style="font-size: 11px; padding: 2px 8px;">${tag}</span>`)}
          </div>
        </div>
        <button type="button" class="satu-switch" aria-pressed=${String(skill.enabled)} aria-label=${t('启用', 'Enable')} onClick=${onToggle}><span></span></button>
      </div>
      <p class="satu-desc">${skill.summary || t('（还没写正文）', '(no definition yet)')}</p>
      <div style="height: 1px; background: var(--color-divider);"></div>
      <div class="satu-meta">
        ${!!skill.steps && html`<span>${t(`${skill.steps} 个步骤`, `${skill.steps} steps`)}</span>`}
        <span>${skill.source}</span>
        <span>${t(`更新于 ${day(skill.updatedAt)}`, `updated ${day(skill.updatedAt)}`)}</span>
      </div>
      <div style="display: flex; gap: var(--space-2); margin-top: auto;">
        <button type="button" class="btn btn-secondary" style="flex: 1; justify-content: center;" onClick=${onEdit}>${t('编辑', 'Edit')}</button>
        <button
          type="button"
          class="btn btn-secondary"
          style="flex: none;"
          disabled
          title=${t('试运行要等 Skill 接进 Agent 循环', 'Dry runs need skills wired into the agent loop')}
        >${t('试运行', 'Dry run')}</button>
      </div>
    </div>
  `
}

function SkillsPage({ ctx }) {
  const { data, error, loading, reload } = useHost(ctx, '/api/skills')
  const builtin = useHost(ctx, '/api/tools')
  const [tab, setTab] = useState('Skill')
  const [dialog, setDialog] = useState(null)
  const [failure, setFailure] = useState(null)
  const [pendingTags, setPendingTags] = useState(null)

  if (loading || builtin.loading) return html`<${Notice} text=${t('载入中…', 'Loading…')} />`
  if (error) return html`<${Notice} text=${error.message} />`

  const { skills, servers, tags } = data
  const tools = builtin.data?.tools ?? []
  const isSkill = tab === 'Skill'

  /**
   * 标签表是**全局**的，不属于哪一个 Skill，所以增删走这一层。
   *
   * 但**不能就地 reload**：`useHost` 一刷新就先进 loading，这一屏会早退成「载入中」，
   * 把还开着的框连同没保存的编辑一起卸载掉。所以拿服务端回的新表就地更新，整屏
   * 的刷新推迟到框关掉那一刻。
   */
  const known = pendingTags ?? tags
  const onTags = {
    create: async (tag) => setPendingTags((await ctx.host.post('/api/skills/tags', { name: tag })).tags),
    remove: async (tag) => setPendingTags((await ctx.host.delete(`/api/skills/tags/${encodeURIComponent(tag)}`)).tags),
    usedBy: (tag) => skills.filter((s) => s.tags.includes(tag)).length,
  }

  /** 关框：这时候才刷新，标签删除对卡片的影响也在这一刻显示出来。 */
  const close = () => {
    setDialog(null)
    setPendingTags(null)
    reload()
  }

  /** 开关是**当场落库**的，不是界面上的一个本地状态——刷新之后还是它。 */
  const toggle = async (path, id, enabled) => {
    try {
      await ctx.host.patch(`${path}/${id}`, { enabled })
      reload()
    } catch (e) {
      setFailure(e.message)
    }
  }


  return html`
    <div style="flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-6);">
      <div style="max-width: 980px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-6);">

        <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">${t('Skill 与 MCP', 'Skills & MCP')}</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('Skill 是可复用的工作方法，MCP 服务器提供 AI 员工实际可调用的工具。', 'Skills are reusable methods; MCP servers provide the tools an AI employee can actually call.')}</p>
          </div>
          <button type="button" class="btn btn-primary" style="flex: none;" onClick=${() => setDialog({ kind: isSkill ? 'skill' : 'server' })}>
            ${icon(ICONS.plus, 15)} ${isSkill ? t('新建 Skill', 'New skill') : t('接入 MCP', 'Add MCP')}
          </button>
        </div>

        <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
          <span style="font-size: 12px; color: var(--muted-foreground);">${t('分类', 'Section')}</span>
          ${['Skill', t('MCP 与工具', 'MCP & tools')].map(
            (name) => html`
              <button key=${name} type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed=${String(tab === name)} onClick=${() => setTab(name)}>${name}</button>
            `,
          )}
        </div>

        ${failure &&
        html`
          <div style="font-size: 13px; color: var(--color-accent-800); background: var(--color-accent-100); border-radius: var(--radius-md); padding: 10px var(--space-4); display: flex; justify-content: space-between; gap: var(--space-3);">
            <span>${failure}</span>
            <button type="button" class="satu-linkbtn" onClick=${() => setFailure(null)}>${t('知道了', 'Dismiss')}</button>
          </div>
        `}

        ${isSkill
          ? html`
              ${skills.length
                ? html`
                    <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: var(--space-4);">
                      ${skills.map(
                        (s) => html`
                          <${SkillCard}
                            key=${s.id}
                            skill=${s}
                            onToggle=${() => toggle('/api/skills', s.id, !s.enabled)}
                            onEdit=${() => setDialog({ kind: 'skill', item: s })}
                          />
                        `,
                      )}
                    </div>
                  `
                : html`
                    <${Empty}
                      title=${t('还没有 Skill', 'No skills yet')}
                      note=${t('点右上角新建一个：手动写，或导入一份 SKILL.md。', 'Create one from the top right — write it here or import a SKILL.md.')}
                    />
                  `}
            `
          : html`
              <div style="display: flex; flex-direction: column; gap: var(--space-6);">
                <div style="display: flex; flex-direction: column; gap: var(--space-3);">
                  <div style="display: flex; align-items: baseline; justify-content: space-between;">
                    <h2 style="font-size: 18px; margin: 0;">${t('内置工具', 'Built-in tools')}</h2>
                    <span style="font-size: 12px; color: var(--muted-foreground);">${t(`真实注册表 · 共 ${tools.length} 个`, `Live registry · ${tools.length} tools`)}</span>
                  </div>
                  <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
                    ${tools.map(
                      (tool) => html`
                        <div key=${tool.name} style="display: flex; align-items: baseline; gap: var(--space-3); padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border);">
                          <span style="flex: none; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; font-weight: 600;">${tool.name}</span>
                          <span style="min-width: 0; font-size: 13px; color: var(--muted-foreground);">${tool.description}</span>
                        </div>
                      `,
                    )}
                    ${!tools.length && html`<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('没有注册任何工具', 'No tools registered')}</div>`}
                  </div>
                  <span style="font-size: 12px; color: var(--muted-foreground);">${t('这一段是真的：Agent 此刻能调的就是这些。', 'This part is real — it is exactly what an agent can call right now.')}</span>
                </div>

                <div style="display: flex; flex-direction: column; gap: var(--space-3);">
                  <div style="display: flex; align-items: baseline; justify-content: space-between;">
                    <h2 style="font-size: 18px; margin: 0;">${t('已接入 MCP 服务器', 'Connected MCP servers')}</h2>
                    <span style="font-size: 12px; color: var(--muted-foreground);">${t(`共 ${servers.length} 个`, `${servers.length} servers`)}</span>
                  </div>
                  ${servers.length
                    ? html`
                        <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
                          <div class="satu-toolhead">
                            <span>${t('MCP 服务器', 'MCP server')}</span><span>${t('传输', 'Transport')}</span><span>${t('工具数', 'Tools')}</span><span>${t('权限', 'Access')}</span><span>${t('更新时间', 'Updated')}</span><span></span>
                          </div>
                          ${servers.map(
                            (s) => html`
                              <div class="satu-toolrow" key=${s.id}>
                                <div style="min-width: 0; display: flex; flex-direction: column; gap: 2px;">
                                  <span style="font-weight: 600; font-size: 14px;">${s.name}</span>
                                  <span style="font-size: 12px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${s.endpoint}</span>
                                </div>
                                <span style="font-size: 13px;">${s.kind}</span>
                                <span style="font-size: 13px; color: var(--muted-foreground);" title=${t('接上之后才知道', 'Known once it is connected')}>—</span>
                                <span class=${`tag ${PERM_TAG(s.perm)}`}>${s.perm}</span>
                                <span style="font-size: 13px; color: var(--muted-foreground);">${day(s.updatedAt)}</span>
                                <div class="satu-rowactions" style="display: flex; align-items: center; gap: var(--space-1); justify-content: flex-end;">
                                  <button type="button" class="satu-switch" aria-pressed=${String(s.enabled)} aria-label=${t('启用', 'Enable')} onClick=${() => toggle('/api/mcp-servers', s.id, !s.enabled)}><span></span></button>
                                  <button type="button" class="btn btn-ghost btn-icon" aria-label=${t('编辑 MCP 服务器', 'Edit MCP server')} onClick=${() => setDialog({ kind: 'server', item: s })}>${icon(EDIT, 15)}</button>
                                </div>
                              </div>
                            `,
                          )}
                        </div>
                      `
                    : html`
                        <${Empty}
                          title=${t('还没接入 MCP 服务器', 'No MCP servers yet')}
                          note=${t('点右上角接入一台：填地址与权限，先把配置登记下来。', 'Add one from the top right — address and access level get recorded first.')}
                        />
                      `}
                  <span style="font-size: 12px; color: var(--muted-foreground);">
                    ${t('这里存的是连接配置。MCP 客户端还没接上，所以「工具数」要等真握上手才知道，先空着。', 'These are connection settings. The MCP client is not wired up yet, so the tool count stays blank until a real handshake happens.')}
                  </span>
                </div>
              </div>
            `}
      </div>
    </div>

    ${dialog?.kind === 'skill' &&
    html`
      <${SkillDialog}
        ctx=${ctx}
        skill=${dialog.item}
        knownTags=${known}
        onTags=${onTags}
        onClose=${close}
        onSaved=${close}
        onDeleted=${close}
      />
    `}

    ${dialog?.kind === 'server' &&
    html`<${ServerDialog} ctx=${ctx} server=${dialog.item} onClose=${close} onSaved=${close} onDeleted=${close} />`}
  `
}

export default {
  name: 'satu-view-skills',
  inject: ['slots', 'host', 'router'],
  apply(ctx) {
    ctx.slots.inject(['sidebar.nav.admin', 'main'], function* () {
      yield ctx.slots.register({ name: 'sidebar.nav.admin', id: 'skills.nav', priority: 30 }, SkillsNav)
      yield ctx.slots.register(
        { name: 'main', id: 'skills', select: (path) => (path === '/skills' ? { title: t('Skill 与 MCP', 'Skills & MCP') } : null) },
        SkillsPage,
      )
    })
  },
}
