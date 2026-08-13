/**
 * DSH 审查模式 browser half：
 * - conversation.input.left：输入区工具行「审查」开关（+ 号旁边）
 * - conversation.input.dock：审查模式开启时的横幅提示
 * - settings.section「审查」：审查参数设置页（维度/阈值/扫描上限/深度/忽略）
 * - tool.call.toolview key=review_audit：审查结果卡片（程序生成多维雷达图）
 */
window.__ModuleLoader__.load({
	id: "plugin-review",
	factory: (require) => {
		var exports = { exports: {} }.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const { useState, useEffect } = React

/* ---------------- 审查模式共享状态（模块级 mini store） ---------------- */
let reviewMode = false
const modeListeners = new Set()
function getReviewMode() { return reviewMode }
function setReviewMode(v) { reviewMode = v; for (const fn of modeListeners) fn(v) }
function onReviewMode(fn) { modeListeners.add(fn); return () => { modeListeners.delete(fn) } }

const tokenBg = 'var(--dsw-alias-bg-layer-1)'
const tokenFg = 'var(--dsw-alias-label-primary)'
const tokenSec = 'var(--dsw-alias-label-secondary)'
const tokenBorder = 'var(--dsw-alias-border-l2)'
const tokenBrand = 'var(--dsw-alias-brand-primary)'
const tokenOk = 'var(--dsw-alias-state-success-primary)'
const tokenWarn = 'var(--dsw-alias-state-warn-primary)'
const tokenErr = 'var(--dsw-alias-state-error-primary)'

/* ---------------- 输入区「审查」开关按钮 ---------------- */
function ReviewModeButton() {
  const [on, setOn] = useState(getReviewMode())
  useEffect(() => onReviewMode(setOn), [])
  return React.createElement('button', {
    title: on ? '关闭审查模式' : '开启审查模式：审查项目/代码质量',
    onClick: () => setReviewMode(!on),
    style: {
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 12, lineHeight: '18px', padding: '2px 8px', borderRadius: 8,
      border: `1px solid ${on ? tokenBrand : tokenBorder}`,
      background: on ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
      color: on ? tokenBrand : tokenSec,
      cursor: 'pointer', whiteSpace: 'nowrap',
    },
  }, on ? '🔍 审查中' : '审查')
}

/* ---------------- 审查模式横幅（composer 上方） ---------------- */
function ReviewModeBanner() {
  const [on, setOn] = useState(getReviewMode())
  const [recent, setRecent] = useState(false)
  useEffect(() => onReviewMode(setOn), [])
  // 自动感知最近一次审查活动（AI 主动触发 review_audit 后，不点按钮也显示提示）
  useEffect(() => {
    let cancelled = false
    const check = () =>
      fetch('/api/review/last', { headers: { accept: 'application/json' } })
        .then((r) => r.json())
        .then((body) => {
          if (!cancelled && body.ok === true && body.result && body.result.at) {
            setRecent(Date.now() - new Date(body.result.at).getTime() < 30000)
          }
        })
        .catch(() => {})
    check()
    const t = setInterval(check, 5000)
    return () => { cancelled = true; clearInterval(t) }
  }, [])
  const show = on || recent
  if (!show) return null
  const label = on ? '🔍 审查模式' : '🔍 审查已执行'
  const desc = on
    ? '输入要审查的项目路径或粘贴代码，我会进行多维度质量审查与评分。'
    : 'AI 最近主动完成了一次质量审查，雷达图评分卡见对话中。'
  return React.createElement('div', {
    style: {
      display: 'flex', alignItems: 'center', gap: 8, width: '100%',
      padding: '6px 12px', borderRadius: 10, boxSizing: 'border-box',
      border: `1px solid ${tokenBrand}`, background: 'var(--dsw-alias-bg-layer-1)',
      fontSize: 12, color: tokenFg,
    },
  },
    React.createElement('span', null, label),
    React.createElement('span', { style: { color: tokenSec } }, desc),
    React.createElement('button', {
      onClick: () => { if (on) setReviewMode(false); else setRecent(false) },
      style: { marginLeft: 'auto', fontSize: 12, padding: '1px 8px', borderRadius: 6, border: `1px solid ${tokenBorder}`, background: 'transparent', color: tokenSec, cursor: 'pointer' },
    }, '退出'),
  )
}

/* ---------------- 设置页「审查」 ---------------- */
const ALL_DIMS = [
  { key: 'structure', label: '结构' },
  { key: 'maintainability', label: '可维护性' },
  { key: 'consistency', label: '一致性' },
  { key: 'robustness', label: '健壮性' },
  { key: 'tests', label: '测试' },
  { key: 'docs', label: '文档' },
  { key: 'performance', label: '性能' },
  { key: 'security', label: '安全' },
]
const fieldStyle = { display: 'flex', flexDirection: 'column', gap: 6 }
const fieldLabel = { fontSize: 12, lineHeight: '18px', fontWeight: 500, color: tokenSec }
const inputStyle = {
  padding: '6px 10px', borderRadius: 8, border: `1px solid ${tokenBorder}`,
  background: tokenBg, color: tokenFg, fontSize: 13, outline: 'none',
}

function ReviewSettingsPanel(props) {
  const sessionId = props.useSessions((s) => s.current)
  const [cfg, setCfg] = useState(null)
  const [msg, setMsg] = useState(null)
  const [err, setErr] = useState(null)
  const [history, setHistory] = useState([])
  const [selected, setSelected] = useState(null)
  const [sort, setSort] = useState('time')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [retentionDays, setRetentionDays] = useState(7)
  const [trash, setTrash] = useState([])
  const [trashOpen, setTrashOpen] = useState(false)
  const [trashMsg, setTrashMsg] = useState(null)
  const [stats, setStats] = useState([])
  const [statsOpen, setStatsOpen] = useState(false)
  const [actionMsg, setActionMsg] = useState(null)

  useEffect(() => {
    fetch('/api/review/config', { headers: { accept: 'application/json' } })
      .then((r) => r.json())
      .then((body) => { if (body.ok === true) setCfg(body.config) })
      .catch((e) => setErr(String(e)))
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = () =>
      fetch(`/api/review/history?sort=${sort}&page=${page}&pageSize=20`, { headers: { accept: 'application/json' } })
        .then((r) => r.json())
        .then((body) => { if (!cancelled && body.ok === true) { setHistory(body.items ?? []); setTotalPages(body.totalPages ?? 1); setTotal(body.total ?? 0) } })
        .catch(() => {})
    load()
    const t = setInterval(load, 10000) // 审查发生后自动刷新当前页
    return () => { cancelled = true; clearInterval(t) }
  }, [sort, page])

  const loadTrash = () =>
    fetch('/api/review/trash', { headers: { accept: 'application/json' } })
      .then((r) => r.json())
      .then((body) => { if (body.ok === true) { setTrash(body.trash ?? []); if (typeof body.retentionDays === 'number') setRetentionDays(body.retentionDays) } })
      .catch(() => {})

  const refreshCurrent = () => {
    fetch(`/api/review/history?sort=${sort}&page=${page}&pageSize=20`, { headers: { accept: 'application/json' } })
      .then((r) => r.json())
      .then((body) => { if (body.ok === true) { setHistory(body.items ?? []); setTotalPages(body.totalPages ?? 1); setTotal(body.total ?? 0) } })
      .catch(() => {})
  }
  const delHistory = (id) => {
    fetch('/api/review/history/' + encodeURIComponent(id), { method: 'DELETE' })
      .then((r) => r.json())
      .then((body) => { if (body.ok === true) { loadTrash(); refreshCurrent() } })
      .catch(() => {})
  }
  const restoreTrash = (id) => {
    fetch('/api/review/trash/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) })
      .then((r) => r.json())
      .then((body) => { if (body.ok === true) { loadTrash(); refreshCurrent() } })
      .catch(() => {})
  }
  const delTrash = (id) => {
    fetch('/api/review/trash/' + encodeURIComponent(id), { method: 'DELETE' })
      .then((r) => r.json())
      .then((body) => { if (body.ok === true) loadTrash() })
      .catch(() => {})
  }
  const emptyTrash = () => {
    fetch('/api/review/trash/empty', { method: 'POST' })
      .then((r) => r.json())
      .then((body) => { if (body.ok === true) { loadTrash(); setTrashMsg('回收站已清空') } })
      .catch(() => {})
  }

  const rerun = (target) => {
    setActionMsg(`正在重新审查 ${target} …`)
    fetch('/api/review/rerun', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target, sessionId }) })
      .then((r) => r.json())
      .then((body) => {
        if (body.ok === true) { setActionMsg('重审完成（已追加到历史）'); refreshCurrent(); loadTrash() }
        else setActionMsg(body.message ?? '重审失败')
      })
      .catch(() => setActionMsg('重审失败'))
  }

  const loadStats = () =>
    fetch('/api/review/stats', { headers: { accept: 'application/json' } })
      .then((r) => r.json())
      .then((body) => { if (body.ok === true) setStats(body.stats ?? []) })
      .catch(() => {})

  const exportCsv = () => {
    fetch('/api/review/export', { headers: { accept: 'application/json' } })
      .then((r) => r.json())
      .then((body) => {
        if (body.ok !== true) { setActionMsg('导出失败'); return }
        const rows = body.rows ?? []
        const header = ['目标', '综合分', '通过', '结构', '可维护性', '一致性', '健壮性', '测试', '文档', '性能', '安全', '审查时间', '会话ID']
        const dimKey = (r, key) => { const d = (r.dims ?? []).find((x) => x.key === key); return d ? d.score : '' }
        const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"'
        const lines = [header.join(',')]
        for (const r of rows) {
          lines.push([r.target, r.overall, r.passed ? '是' : '否', dimKey(r, 'structure'), dimKey(r, 'maintainability'), dimKey(r, 'consistency'), dimKey(r, 'robustness'), dimKey(r, 'tests'), dimKey(r, 'docs'), dimKey(r, 'performance'), dimKey(r, 'security'), r.at, r.sessionId ?? ''].map(esc).join(','))
        }
        const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = 'review-history-' + new Date().toISOString().slice(0, 10) + '.csv'
        a.click()
        URL.revokeObjectURL(a.href)
        setActionMsg(`已导出 ${rows.length} 条记录`)
      })
      .catch(() => setActionMsg('导出失败'))
  }

  if (cfg === null) return React.createElement('p', { style: { color: tokenSec, fontSize: 13 } }, err !== null ? `加载失败：${err}` : '加载中…')

  const toggleDim = (key) => {
    const dims = cfg.dims.includes(key) ? cfg.dims.filter((d) => d !== key) : [...cfg.dims, key]
    setCfg({ ...cfg, dims })
  }
  const num = (key, v) => { const n = Number(v); setCfg({ ...cfg, [key]: Number.isFinite(n) ? n : 0 }) }
  const save = () => {
    setMsg(null); setErr(null)
    fetch('/api/review/config', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: cfg }),
    })
      .then((r) => r.json())
      .then((body) => { if (body.ok === true) { setMsg('已保存'); setCfg(body.config) } else { setErr(body.message ?? '保存失败') } })
      .catch((e) => setErr(String(e)))
  }

  return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 620, color: tokenFg } },
    React.createElement('p', { style: { margin: 0, fontSize: 13, color: tokenSec } },
      '审查模式的参数配置：选择参与评分的维度、综合及格线、扫描上限与深度、忽略目录。'),
    React.createElement('div', { style: fieldStyle },
      React.createElement('span', { style: fieldLabel }, '评分维度'),
      React.createElement('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
        ALL_DIMS.map((d) => {
          const active = cfg.dims.includes(d.key)
          return React.createElement('label', {
            key: d.key,
            style: {
              display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13,
              padding: '3px 10px', borderRadius: 999, cursor: 'pointer',
              border: `1px solid ${active ? tokenBrand : tokenBorder}`,
              background: active ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
              color: active ? tokenBrand : tokenSec,
            },
          },
            React.createElement('input', { type: 'checkbox', checked: active, onChange: () => toggleDim(d.key), style: { display: 'none' } }),
            d.label,
          )
        }),
      ),
    ),
    React.createElement('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 } },
      React.createElement('div', { style: fieldStyle },
        React.createElement('span', { style: fieldLabel }, '及格线（overall ≥ 此值视为通过）'),
        React.createElement('input', { style: inputStyle, type: 'number', min: 0, max: 100, value: String(cfg.threshold), onChange: (e) => num('threshold', e.target.value) }),
      ),
      React.createElement('div', { style: fieldStyle },
        React.createElement('span', { style: fieldLabel }, '扫描文件上限'),
        React.createElement('input', { style: inputStyle, type: 'number', min: 1, max: 5000, value: String(cfg.maxFiles), onChange: (e) => num('maxFiles', e.target.value) }),
      ),
      React.createElement('div', { style: fieldStyle },
        React.createElement('span', { style: fieldLabel }, '目录深度上限'),
        React.createElement('input', { style: inputStyle, type: 'number', min: 1, max: 10, value: String(cfg.depth), onChange: (e) => num('depth', e.target.value) }),
      ),
      React.createElement('div', { style: fieldStyle },
        React.createElement('span', { style: fieldLabel }, '忽略目录（逗号分隔）'),
        React.createElement('input', {
          style: inputStyle,
          value: (cfg.ignore ?? []).join(','),
          onChange: (e) => setCfg({ ...cfg, ignore: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) }),
        }),
      ),
      React.createElement('div', { style: fieldStyle },
        React.createElement('span', { style: fieldLabel }, '回收站保留天数（0 = 立即删除）'),
        React.createElement('input', {
          style: inputStyle,
          type: 'number', min: 0, max: 365,
          value: String(cfg.trashRetentionDays ?? 7),
          onChange: (e) => num('trashRetentionDays', e.target.value),
        }),
      ),
    ),
    err !== null ? React.createElement('p', { style: { margin: 0, fontSize: 12, color: tokenErr } }, String(err)) : null,
    msg !== null ? React.createElement('p', { style: { margin: 0, fontSize: 12, color: tokenOk } }, String(msg)) : null,
    React.createElement('div', null,
      React.createElement('button', {
        onClick: save,
        style: { fontSize: 13, padding: '6px 16px', borderRadius: 8, border: 'none', background: tokenBrand, color: 'var(--dsw-alias-bg-layer-1)', cursor: 'pointer' },
      }, '保存设置'),
    ),
    React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 } },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
        React.createElement('span', { style: { ...fieldLabel, fontWeight: 600, marginRight: 4 } }, '审查历史'),
        [['time', '时间'], ['project', '项目'], ['score', '成绩']].map(([k, label]) =>
          React.createElement('button', {
            key: k,
            onClick: () => { setSort(k); setPage(1) },
            style: { fontSize: 12, padding: '2px 10px', borderRadius: 999, border: `1px solid ${sort === k ? tokenBrand : tokenBorder}`, background: sort === k ? 'var(--dsw-alias-bg-layer-2)' : 'transparent', color: sort === k ? tokenBrand : tokenSec, cursor: 'pointer' },
          }, label),
        ),
        React.createElement('button', {
          onClick: exportCsv,
          style: { fontSize: 12, padding: '2px 10px', borderRadius: 8, border: `1px solid ${tokenBorder}`, background: 'transparent', color: tokenSec, cursor: 'pointer' },
        }, '导出 CSV'),
        React.createElement('button', {
          onClick: () => { setStatsOpen(!statsOpen); if (!statsOpen) loadStats() },
          style: { fontSize: 12, padding: '2px 10px', borderRadius: 8, border: `1px solid ${tokenBorder}`, background: 'transparent', color: tokenSec, cursor: 'pointer' },
        }, statsOpen ? '收起统计' : '📊 项目统计'),
        React.createElement('button', {
          onClick: () => { setTrashOpen(!trashOpen); if (!trashOpen) loadTrash() },
          style: { marginLeft: 'auto', fontSize: 12, padding: '2px 10px', borderRadius: 8, border: `1px solid ${tokenBorder}`, background: 'transparent', color: tokenSec, cursor: 'pointer' },
        }, trashOpen ? '收起回收站' : '🗑 回收站'),
      ),
      actionMsg !== null ? React.createElement('span', { style: { fontSize: 12, color: tokenBrand } }, String(actionMsg)) : null,
      history.length === 0
        ? React.createElement('span', { style: { fontSize: 12, color: tokenSec } }, '暂无审查记录。完成一次审查后会自动记录：项目、时间、对话链接与雷达图。')
        : history.map((h, idx) => {
            const fmt = (at) => { try { return new Date(at).toLocaleString('zh-CN', { hour12: false }) } catch { return at || '' } }
            const base = (p) => { const parts = String(p).split(/[\\/]/); return parts[parts.length - 1] || p }
            const showGroupHead = sort === 'project' && (idx === 0 || history[idx - 1].target !== h.target)
            return React.createElement(React.Fragment, { key: h.id },
              showGroupHead ? React.createElement('div', { style: { fontSize: 11, color: tokenSec, fontWeight: 600, marginTop: idx === 0 ? 0 : 6 } }, '📁 ' + h.target) : null,
              React.createElement('div', {
                style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '6px 10px', borderRadius: 8, border: `1px solid ${tokenBorder}` },
              },
                React.createElement('span', { title: h.target, style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, sort === 'project' ? base(h.target) : h.target),
                React.createElement('span', { style: { color: tokenSec, fontSize: 12, whiteSpace: 'nowrap' } }, `综合 ${h.overall ?? '?'}`),
                React.createElement('span', { style: { color: tokenSec, fontSize: 12, whiteSpace: 'nowrap' } }, fmt(h.at)),
                h.sessionId
                  ? React.createElement('a', {
                      href: location.origin + '/?session=' + encodeURIComponent(h.sessionId),
                      target: '_blank', rel: 'noreferrer',
                      style: { fontSize: 12, color: tokenBrand, whiteSpace: 'nowrap' },
                    }, '对话 ↗')
                  : null,
                React.createElement('button', {
                  onClick: () => setSelected(h),
                  style: { fontSize: 12, padding: '2px 8px', borderRadius: 8, border: `1px solid ${tokenBorder}`, background: 'transparent', color: tokenBrand, cursor: 'pointer', whiteSpace: 'nowrap' },
                }, '审查图'),
                React.createElement('button', {
                  onClick: () => rerun(h.target),
                  style: { fontSize: 12, padding: '2px 8px', borderRadius: 8, border: `1px solid ${tokenBorder}`, background: 'transparent', color: tokenBrand, cursor: 'pointer', whiteSpace: 'nowrap' },
                }, '重审'),
                React.createElement('button', {
                  onClick: () => delHistory(h.id),
                  style: { fontSize: 12, padding: '2px 8px', borderRadius: 8, border: `1px solid ${tokenBorder}`, background: 'transparent', color: tokenSec, cursor: 'pointer', whiteSpace: 'nowrap' },
                }, '删除'),
              ),
            )
          }),
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        React.createElement('button', {
          onClick: () => setPage((p) => Math.max(1, p - 1)),
          disabled: page <= 1,
          style: { fontSize: 12, padding: '2px 10px', borderRadius: 8, border: `1px solid ${tokenBorder}`, background: 'transparent', color: page <= 1 ? tokenBorder : tokenSec, cursor: page <= 1 ? 'default' : 'pointer' },
        }, '‹ 上一页'),
        React.createElement('span', { style: { fontSize: 12, color: tokenSec } }, `第 ${page} / ${totalPages} 页 · 共 ${total} 条`),
        React.createElement('button', {
          onClick: () => setPage((p) => Math.min(totalPages, p + 1)),
          disabled: page >= totalPages,
          style: { fontSize: 12, padding: '2px 10px', borderRadius: 8, border: `1px solid ${tokenBorder}`, background: 'transparent', color: page >= totalPages ? tokenBorder : tokenSec, cursor: page >= totalPages ? 'default' : 'pointer' },
        }, '下一页 ›'),
      ),
      trashOpen
        ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: 10, borderRadius: 8, border: `1px dashed ${tokenBorder}` } },
            React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
              React.createElement('span', { style: { ...fieldLabel, fontWeight: 600 } }, '回收站（保留期内可恢复）'),
              React.createElement('button', {
                onClick: emptyTrash,
                style: { marginLeft: 'auto', fontSize: 12, padding: '1px 8px', borderRadius: 6, border: `1px solid ${tokenBorder}`, background: 'transparent', color: tokenErr, cursor: 'pointer' },
              }, '清空回收站'),
            ),
            trashMsg !== null ? React.createElement('span', { style: { fontSize: 12, color: tokenOk } }, String(trashMsg)) : null,
            trash.length === 0
              ? React.createElement('span', { style: { fontSize: 12, color: tokenSec } }, '回收站为空。')
              : trash.map((t) => {
                  const remain = Math.max(0, Math.ceil((new Date(t.deletedAt).getTime() + retentionDays * 86400000 - Date.now()) / 86400000))
                  const base = (p) => { const parts = String(p).split(/[\\/]/); return parts[parts.length - 1] || p }
                  return React.createElement('div', { key: t.id, style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '5px 8px', borderRadius: 6, border: `1px solid ${tokenBorder}` } },
                    React.createElement('span', { title: t.target, style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, base(t.target)),
                    React.createElement('span', { style: { color: tokenSec, fontSize: 12, whiteSpace: 'nowrap' } }, remain > 0 ? `可恢复 ${remain} 天` : '即将过期'),
                    React.createElement('button', {
                      onClick: () => restoreTrash(t.id),
                      style: { fontSize: 12, padding: '1px 8px', borderRadius: 6, border: `1px solid ${tokenBorder}`, background: 'transparent', color: tokenBrand, cursor: 'pointer' },
                    }, '恢复'),
                    React.createElement('button', {
                      onClick: () => delTrash(t.id),
                      style: { fontSize: 12, padding: '1px 8px', borderRadius: 6, border: `1px solid ${tokenBorder}`, background: 'transparent', color: tokenErr, cursor: 'pointer' },
                    }, '彻底删除'),
                  )
                }),
          )
        : null,
      statsOpen
        ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: 10, borderRadius: 8, border: `1px dashed ${tokenBorder}` } },
            React.createElement('span', { style: { ...fieldLabel, fontWeight: 600 } }, '项目统计（平均分）'),
            stats.length === 0
              ? React.createElement('span', { style: { fontSize: 12, color: tokenSec } }, '暂无统计数据。完成审查后自动汇总。')
              : stats.map((s) =>
                  React.createElement('div', { key: s.target, style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '5px 8px', borderRadius: 6, border: `1px solid ${tokenBorder}` } },
                    React.createElement('span', { title: s.target, style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.target),
                    React.createElement('span', { style: { color: tokenSec, fontSize: 12, whiteSpace: 'nowrap' } }, `${s.count} 次`),
                    React.createElement('span', { style: { color: tokenBrand, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' } }, `平均 ${s.avg}`),
                    React.createElement('span', { style: { color: tokenSec, fontSize: 12, whiteSpace: 'nowrap' } }, `(${s.min}~${s.max})`),
                  ),
                ),
          )
        : null,
    ),
    selected !== null ? React.createElement(ReviewChartModal, { item: selected, onClose: () => setSelected(null) }) : null,
  )
}

/* ---------------- 审查历史弹窗（雷达图） ---------------- */
function ReviewChartModal({ item, onClose }) {
  return React.createElement('div', {
    style: { position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
    onClick: onClose,
  },
    React.createElement('div', {
      style: { background: 'var(--dsw-alias-bg-layer-1)', border: `1px solid ${tokenBorder}`, borderRadius: 12, padding: 18, maxWidth: 360, width: '90%', color: tokenFg },
      onClick: (e) => { e.stopPropagation() },
    },
      React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
        React.createElement('span', { style: { fontWeight: 600, fontSize: 14 } }, '审查雷达图'),
        React.createElement('span', { style: { fontSize: 12, color: tokenSec } }, `综合 ${item.overall ?? '?'}/100 ${item.passed ? '· 通过' : '· 未达阈值'}`),
        React.createElement('button', {
          onClick: onClose,
          style: { marginLeft: 'auto', fontSize: 12, padding: '1px 8px', borderRadius: 6, border: 'none', background: 'transparent', color: tokenSec, cursor: 'pointer' },
        }, '✕'),
      ),
      (item.dims && item.dims.length > 0)
        ? React.createElement(RadarChart, { dims: item.dims })
        : React.createElement('p', { style: { fontSize: 12, color: tokenSec, textAlign: 'center', padding: 12 } }, '（无维度评分数据）'),
      React.createElement('div', { style: { fontSize: 12, color: tokenSec, marginTop: 8, wordBreak: 'break-all' } }, '目标：' + (item.target ?? '')),
    ),
  )
}

/* ---------------- 审查结果卡片（多维雷达图，程序生成 SVG） ---------------- */
function RadarChart({ dims }) {
  const n = dims.length
  const cx = 130, cy = 112, r = 76
  const angle = (i) => (-90 + (360 / n) * i) * Math.PI / 180
  const pt = (i, frac) => [cx + r * frac * Math.cos(angle(i)), cy + r * frac * Math.sin(angle(i))]
  const ring = (frac) => Array.from({ length: n }, (_, i) => pt(i, frac).map((v) => v.toFixed(1)).join(',')).join(' ')
  const axisEnds = Array.from({ length: n }, (_, i) => pt(i, 1.16))
  const scorePts = dims.map((d, i) => pt(i, Math.max(0, Math.min(100, d.score)) / 100).map((v) => v.toFixed(1)).join(',')).join(' ')
  const nodes = [
    React.createElement('svg', { key: 'svg', viewBox: '0 0 260 236', width: '100%', style: { maxWidth: 280 } },
      [0.25, 0.5, 0.75, 1].map((f) =>
        React.createElement('polygon', { key: 'ring' + f, points: ring(f), fill: 'none', stroke: tokenBorder, strokeWidth: 1, opacity: 0.5 })),
      Array.from({ length: n }, (_, i) =>
        React.createElement('line', { key: 'axis' + i, x1: cx, y1: cy, x2: pt(i, 1)[0], y2: pt(i, 1)[1], stroke: tokenBorder, strokeWidth: 1, opacity: 0.4 })),
      React.createElement('polygon', { key: 'score', points: scorePts, fill: tokenBrand, fillOpacity: 0.22, stroke: tokenBrand, strokeWidth: 2 }),
      dims.map((d, i) =>
        React.createElement('text', {
          key: 'lab' + i,
          x: axisEnds[i][0], y: axisEnds[i][1],
          textAnchor: axisEnds[i][0] < cx - 8 ? 'end' : (axisEnds[i][0] > cx + 8 ? 'start' : 'middle'),
          dominantBaseline: 'middle',
          fontSize: 10, fill: tokenSec,
        }, d.label + ' ' + d.score),
      ),
    ),
  ]
  return React.createElement('div', { style: { display: 'flex', justifyContent: 'center' } }, nodes)
}

function ReviewToolCard(props) {
  const [result, setResult] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => {
    let cancelled = false
    const load = () =>
      fetch('/api/review/last', { headers: { accept: 'application/json' } })
        .then((r) => r.json())
        .then((body) => { if (!cancelled) { if (body.ok === true && body.result) setResult(body.result); else setErr(body.message ?? '暂无审查结果') } })
        .catch((e) => { if (!cancelled) setErr(String(e)) })
    load()
    // 工具可能仍在运行中（卡片提前渲染）：稍后重取一次覆盖 running→settled
    const t = setTimeout(load, 1500)
    return () => { cancelled = true; clearTimeout(t) }
  }, [])
  const dims = result?.dims ?? []
  return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 10, padding: '12px 14px', borderRadius: 12, border: `1px solid ${tokenBorder}`, background: 'var(--dsw-alias-bg-layer-1)', fontSize: 13, color: tokenFg } },
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      React.createElement('span', { style: { fontWeight: 600 } }, '🔍 审查结果'),
      result !== null ? React.createElement('span', {
        style: {
          fontSize: 12, padding: '1px 8px', borderRadius: 999,
          border: `1px solid ${result.passed ? tokenOk : tokenWarn}`,
          color: result.passed ? tokenOk : tokenWarn,
        },
      }, result.passed ? `综合 ${result.overall}/100 · 通过` : `综合 ${result.overall}/100 · 未达阈值`) : null,
    ),
    result !== null ? React.createElement('div', { style: { fontSize: 12, color: tokenSec } }, `目标：${result.target}`) : null,
    err !== null ? React.createElement('p', { style: { margin: 0, fontSize: 12, color: tokenErr } }, String(err)) : null,
    dims.length > 0 ? React.createElement(RadarChart, { dims }) : null,
    (result?.issues ?? []).length > 0 ? React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
      React.createElement('span', { style: { fontSize: 12, fontWeight: 600, color: tokenSec } }, '问题清单'),
      result.issues.map((i, idx) => {
        const color = i.severity === 'error' ? tokenErr : (i.severity === 'warn' ? tokenWarn : tokenSec)
        return React.createElement('div', { key: idx, style: { fontSize: 12, color } }, `• [${i.severity}] ${i.msg}`)
      }),
    ) : null,
  )
}

/* ---------------- 注册 ---------------- */
/** Cordis 插件名。 */
const name = 'plugin-review-client'

/** 需要 slots（input.left / input.dock / settings.section / tool.call.toolview）。 */
const inject = ['slots']

function apply(ctx) {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  slots.inject('conversation.input.left', () =>
    slots.register({ name: 'conversation.input.left', id: 'review-mode', order: 5 }, ReviewModeButton))
  slots.inject('conversation.input.dock', () =>
    slots.register({ name: 'conversation.input.dock', id: 'review-banner', order: 30 }, ReviewModeBanner))
  slots.inject('settings.section', () =>
    slots.register({
      name: 'settings.section', id: 'review', order: 62, label: () => '审查',
      inject: () => ({}),
    }, ReviewSettingsPanel))
  slots.inject('tool.call.toolview', () =>
    slots.register({ name: 'tool.call.toolview', key: 'review_audit' }, ReviewToolCard))
}
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return exports;
	}
});
