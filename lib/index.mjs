/**
 * DSH 审查模式 Node half：
 * - review_audit 工具（模型面）：扫描目标项目/代码，程序化收集指标并
 *   输出 8 维度健康评分（结构/可维护性/一致性/健壮性/测试/文档/性能/安全）
 *   + 问题清单；评分结果缓存供 client 雷达图拉取（/api/review/last）。
 * - 审查配置：$DSH_HOME/review-config.json（维度开关/及格线/扫描上限/深度/
 *   忽略目录），经 /api/review/config 由设置页读写。
 * - 模型可基于评分 + 代码阅读输出完整审查报告。
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, extname } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Cordis 插件名。 */
const name = 'plugin-review'

/** 需要宿主 web server + tools（review_audit）+ systemPrompt（注入主动审查守则）。 */
const inject = ['webServer', 'tools', 'systemPrompt']

/** 注入给模型的代码质量审查守则：让 AI 在模块/任务完成时主动触发审查。 */
const REVIEW_DISCIPLINE = `## 代码质量审查守则
- 当一个开发任务、模块或较大改动完成时（例如完成一组文件编辑、实现完一个功能、修复完一轮问题），你应当主动调用 review_audit 工具审查相关代码/项目，而不是等用户要求。
- review_audit 返回的是**客观指标基线**（规模/遗留标记/文档/测试/依赖/静态检查等），不等同于完整审查。拿到指标后，你必须**抽样阅读代表性文件**做语义审查：至少覆盖入口/核心模块、指标最低的维度相关文件、以及改动涉及的文件；关注真实缺陷（空指针、资源泄漏、并发、边界条件、逻辑错误）、架构与模块边界、命名与可维护性。
- 审查报告分两部分：① 客观指标（引用 review_audit 的维度分与问题清单）；② 代码阅读结论（发现的具体问题，定位到文件/行，附改进建议）。
- 若存在 error 级问题、测试失败、或综合分低于及格线，应主动修复，并在修复后再次调用 review_audit 复查，直到通过或明确告知用户剩余风险。
- 用户开启审查模式（输入框「审查」按钮）后输入的内容即审查请求，同样使用 review_audit。`

/* ---------------- 配置 ---------------- */

const DEFAULT_CONFIG = {
  dims: ['structure', 'maintainability', 'consistency', 'robustness', 'tests', 'docs', 'performance', 'security'],
  threshold: 60,
  maxFiles: 300,
  depth: 4,
  ignore: ['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__', '.next', '.cache', 'vendor', '.dsh'],
  trashRetentionDays: 7,
  runTests: true,
  runLint: true,
  auditDeps: false,
}

function resolveDshHome() {
  // Windows 上无 HOME 环境变量，且 DSH_* 在子进程里会被 scrub——逐级回退：
  // DSH_HOME → USERPROFILE\.dsh → HOME/.dsh → /tmp/.dsh
  const direct = process.env.DSH_HOME
  if (typeof direct === 'string' && direct.trim() !== '') return direct
  const user = process.env.USERPROFILE
  if (typeof user === 'string' && user.trim() !== '') return join(user, '.dsh')
  const home = process.env.HOME
  if (typeof home === 'string' && home.trim() !== '') return join(home, '.dsh')
  return join('/tmp', '.dsh')
}
function configPath() {
  return join(resolveDshHome(), 'review-config.json')
}
function loadConfig() {
  try {
    const raw = JSON.parse(readFileSync(configPath(), 'utf8'))
    return { ...DEFAULT_CONFIG, ...raw }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}
function saveConfig(cfg) {
  writeFileSync(configPath(), `${JSON.stringify(cfg, null, 2)}\n`)
}

/** 最近一次审查结果（供 client 雷达图）。 */
let lastReview = null

/* ---------------- 审查历史与回收站（持久化） ---------------- */
const HISTORY_FILE = join(resolveDshHome(), 'review-history.json')
const TRASH_FILE = join(resolveDshHome(), 'review-trash.json')
const HISTORY_LIMIT = 50
function loadJsonFile(file) {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}
function saveJsonFile(file, data) {
  try {
    writeFileSync(file, `${JSON.stringify(data, null, 1)}\n`)
  } catch (e) {
    console.log(`[plugin-review] ${file} 保存失败：${e instanceof Error ? e.message : String(e)}`)
  }
}
let reviewHistory = loadJsonFile(HISTORY_FILE)
let reviewTrash = loadJsonFile(TRASH_FILE)

/** 清理过期回收站记录：deletedAt + trashRetentionDays 之后彻底删除（惰性执行）。 */
function purgeExpiredTrash() {
  const cfg = loadConfig()
  const days = Number(cfg.trashRetentionDays)
  const retentionMs = Number.isFinite(days) && days > 0 ? days * 86400000 : 0
  if (retentionMs <= 0) {
    if (reviewTrash.length > 0) { reviewTrash = []; saveJsonFile(TRASH_FILE, reviewTrash) }
    return
  }
  const cutoff = Date.now() - retentionMs
  const next = reviewTrash.filter((t) => !t.deletedAt || new Date(t.deletedAt).getTime() > cutoff)
  if (next.length !== reviewTrash.length) {
    reviewTrash = next
    saveJsonFile(TRASH_FILE, reviewTrash)
  }
}

/** 按分类排序：time（时间倒序）/ project（按项目，同项目按时间）/ score（成绩倒序）。 */
function sortHistory(items, sort) {
  const arr = [...items]
  const byAt = (a, b) => (b.at < a.at ? -1 : b.at > a.at ? 1 : 0)
  if (sort === 'project') {
    arr.sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0) || byAt(a, b))
  } else if (sort === 'score') {
    arr.sort((a, b) => ((b.overall ?? 0) - (a.overall ?? 0)) || byAt(a, b))
  } else {
    arr.sort(byAt)
  }
  return arr
}

/* ---------------- 扫描与评分 ---------------- */

const DIM_LABELS = {
  structure: '结构',
  maintainability: '可维护性',
  consistency: '一致性',
  robustness: '健壮性',
  tests: '测试',
  docs: '文档',
  performance: '性能',
  security: '安全',
}

const TEXT_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.go', '.rs', '.c', '.cpp',
  '.h', '.cs', '.php', '.rb', '.swift', '.kt', '.m', '.sh', '.html', '.css', '.scss', '.vue',
  '.svelte', '.json', '.md', '.yml', '.yaml', '.toml', '.ini', '.xml', '.sql', '.lua', '.r',
])

function scanProject(root, cfg) {
  const s = {
    files: 0, dirs: 0, lines: 0, byExt: {},
    todo: 0, debug: 0, emptyCatch: 0, bigFiles: 0, testFiles: 0,
    readme: false, license: false, gitignore: false, hasPackage: false, deps: 0,
    tabs: 0, spaces: 0, mixedIndentFiles: 0, longLines: 0,
  }
  const walk = (dir, depth) => {
    if (depth > cfg.depth || s.files >= cfg.maxFiles) return
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (s.files >= cfg.maxFiles) return
      if (cfg.ignore.includes(e.name)) continue
      if (e.isSymbolicLink()) continue // 不跟随符号链接，避免越界
      const full = join(dir, e.name)
      if (e.isDirectory()) { s.dirs += 1; walk(full, depth + 1); continue }
      s.files += 1
      const ext = extname(e.name).toLowerCase()
      s.byExt[ext] = (s.byExt[ext] ?? 0) + 1
      if (/\.(test|spec)\./.test(e.name)) s.testFiles += 1
      if (/^readme/i.test(e.name)) s.readme = true
      if (/^license/i.test(e.name)) s.license = true
      if (e.name === '.gitignore') s.gitignore = true
      if (e.name === 'package.json') {
        s.hasPackage = true
        try {
          const p = JSON.parse(readFileSync(full, 'utf8'))
          s.deps = Object.keys(p.dependencies ?? {}).length + Object.keys(p.devDependencies ?? {}).length
        } catch {}
      }
      if (!TEXT_EXTS.has(ext)) continue
      // 只读文件前 40KB 做统计，避免超大文件全量读入内存
      let content = ''
      try {
        const fd = openSync(full, 'r')
        try {
          const buf = Buffer.alloc(40000)
          const n = readSync(fd, buf, 0, 40000, 0)
          content = buf.toString('utf8', 0, Math.max(0, n))
        } finally { closeSync(fd) }
      } catch { continue }
      const lineCount = content.split('\n').length
      s.lines += lineCount
      if (lineCount > 500) s.bigFiles += 1
      for (const l of content.split('\n')) if (l.length > 120) s.longLines += 1
      if (/TODO|FIXME|HACK|XXX/.test(content)) s.todo += 1
      if (/console\.(log|debug)|debugger\b/.test(content)) s.debug += 1
      if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(content)) s.emptyCatch += 1
      const t = (content.match(/^\t/m) ?? []).length
      const sp = (content.match(/^ {2,4}/m) ?? []).length
      if (t > 0 && sp > 0) s.mixedIndentFiles += 1
      if (t > sp) s.tabs += lineCount
      else if (sp > 0) s.spaces += lineCount
    }
  }
  walk(root, 0)
  return s
}

/* ---------------- 真实工具检查（测试 / lint / 依赖审计） ---------------- */

function runCheck(command, args, cwd, timeoutMs) {
  try {
    const r = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] })
    if (r.error) return { ok: false, error: r.error.message }
    const output = ((r.stdout ?? '') + (r.stderr ?? '')).slice(-600)
    return { ok: true, exitCode: r.status, output }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 顶层是否有 .py 测试文件迹象（tests/ 目录或 test_*.py）。 */
function hasPyTests(root) {
  try {
    if (existsSync(join(root, 'tests'))) return true
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.isFile() && /^(test_.*|.*_test)\.py$/.test(e.name)) return true
    }
  } catch {}
  return false
}

/** 顶层是否有 JS/TS 测试文件迹象（*.test.* / *.spec.*）。 */
function hasJsTests(root) {
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.isFile() && /\.(test|spec)\.(js|mjs|cjs|ts|tsx|jsx)$/.test(e.name)) return true
    }
  } catch {}
  return false
}

/** 执行测试 / 静态检查 / 依赖审计（配置可关；失败/不可用降级为空，不抛）。 */
async function runToolChecks(root, cfg) {
  const checks = { test: null, lint: null, audit: null }
  const nm = join(root, 'node_modules')
  const hasNm = existsSync(nm)
  try {
    if (cfg.runTests !== false && existsSync(root)) {
      if (hasNm && existsSync(join(nm, 'vitest', 'vitest.mjs'))) {
        checks.test = runCheck('node', [join(nm, 'vitest', 'vitest.mjs'), 'run', '--reporter=basic'], root, 60000)
      } else if (hasNm && existsSync(join(nm, 'jest'))) {
        checks.test = runCheck('node', [join(nm, 'jest', 'bin', 'jest.js'), '--silent'], root, 60000)
      } else if (hasNm && existsSync(join(nm, 'mocha'))) {
        checks.test = runCheck('node', [join(nm, 'mocha', 'bin', 'mocha.js'), '--reporter=dot'], root, 60000)
      } else if (hasPyTests(root)) {
        checks.test = runCheck('python', ['-m', 'pytest', '-q', '--no-header', '-x'], root, 60000)
      } else if (hasJsTests(root)) {
        checks.test = runCheck('node', ['--test'], root, 60000)
      }
    }
    if (cfg.runLint !== false && hasNm) {
      if (existsSync(join(nm, 'typescript')) && existsSync(join(root, 'tsconfig.json'))) {
        checks.lint = runCheck('node', [join(nm, 'typescript', 'bin', 'tsc'), '--noEmit'], root, 60000)
      } else if (existsSync(join(nm, 'eslint'))) {
        checks.lint = runCheck('node', [join(nm, 'eslint', 'bin', 'eslint.js'), '.'], root, 60000)
      }
    }
    if (cfg.auditDeps === true && existsSync(join(root, 'package.json'))) {
      const a = runCheck('npm', ['audit', '--json'], root, 45000)
      if (a.ok && a.exitCode === 0) {
        try {
          const j = JSON.parse(a.output)
          const v = j.metadata?.vulnerabilities ?? {}
          checks.audit = { low: v.low ?? 0, moderate: v.moderate ?? 0, high: v.high ?? 0, critical: v.critical ?? 0 }
        } catch {
          checks.audit = { error: 'audit 输出解析失败' }
        }
      } else if (a.ok) {
        checks.audit = { error: `npm audit 退出码 ${a.exitCode}` }
      } else {
        checks.audit = { error: a.error ?? 'npm audit 不可用' }
      }
    }
  } catch {
    // 工具检查整体失败不影响主审查
  }
  return checks
}

/** 指标 + 工具检查 → 8 维度启发式评分（0-100）。 */
function scoreProject(s, cfg, checks) {
  const clamp = (v) => Math.max(0, Math.min(100, Math.round(v)))
  const dims = []
  const active = new Set(cfg.dims)

  if (active.has('structure')) {
    const score = s.files === 0 ? 0 : clamp(88 - s.bigFiles * 6 - (s.dirs === 0 ? 15 : 0))
    dims.push({ key: 'structure', label: DIM_LABELS.structure, score, hint: s.files === 0 ? '未发现代码文件' : `共 ${s.files} 文件 / ${s.dirs} 目录，超大文件 ${s.bigFiles} 个` })
  }
  if (active.has('maintainability')) {
    const score = s.files === 0 ? 0 : clamp(90 - s.todo * 2 - s.bigFiles * 4 - Math.min(30, Math.floor(s.longLines / 40)))
    dims.push({ key: 'maintainability', label: DIM_LABELS.maintainability, score, hint: `遗留标记(TODO/FIXME) ${s.todo} 处，超大文件 ${s.bigFiles} 个，超长行 ${s.longLines} 行` })
  }
  if (active.has('consistency')) {
    const score = s.files === 0 ? 0 : clamp(90 - s.mixedIndentFiles * 8 - ((s.tabs > 0 && s.spaces > 0) ? 15 : 0))
    dims.push({ key: 'consistency', label: DIM_LABELS.consistency, score, hint: s.mixedIndentFiles > 0 ? `${s.mixedIndentFiles} 个文件混用 Tab/空格缩进` : '缩进风格一致' })
  }
  if (active.has('robustness')) {
    const score = s.files === 0 ? 0 : clamp(85 - s.emptyCatch * 5 - s.debug * 2)
    dims.push({ key: 'robustness', label: DIM_LABELS.robustness, score, hint: `空 catch ${s.emptyCatch} 处，调试残留(console.log/debugger) ${s.debug} 处` })
  }
  if (active.has('tests')) {
    const ran = checks?.test
    let score
    let hint
    if (ran?.ok === true && ran.exitCode === 0) {
      score = clamp(60 + Math.min(40, s.testFiles * 10))
      hint = `测试运行通过（${s.testFiles} 个测试文件）`
    } else if (ran?.ok === true && ran.exitCode !== 0) {
      score = 20
      hint = '测试存在但运行失败'
    } else if (ran?.ok === false) {
      score = s.testFiles > 0 ? 40 : 18
      hint = `测试框架不可用（${ran.error ?? '未知'}）`
    } else {
      score = s.files === 0 ? 0 : clamp(s.testFiles > 0 ? 45 + Math.min(55, s.testFiles * 12) : 18)
      hint = s.testFiles > 0 ? `发现 ${s.testFiles} 个测试文件（未运行）` : '未发现测试文件'
    }
    dims.push({ key: 'tests', label: DIM_LABELS.tests, score, hint })
  }
  if (active.has('docs')) {
    const score = (s.readme ? 40 : 0) + (s.license ? 25 : 0) + (s.gitignore ? 20 : 0) + (s.readme ? 15 : 0)
    dims.push({ key: 'docs', label: DIM_LABELS.docs, score: clamp(score), hint: `README ${s.readme ? '✓' : '✗'} · LICENSE ${s.license ? '✓' : '✗'} · .gitignore ${s.gitignore ? '✓' : '✗'}` })
  }
  if (active.has('performance')) {
    const score = s.files === 0 ? 0 : clamp(85 - s.bigFiles * 3 - (s.lines > 20000 ? 15 : 0) - Math.min(20, s.deps * 0.4))
    dims.push({ key: 'performance', label: DIM_LABELS.performance, score, hint: `代码约 ${s.lines} 行，依赖 ${s.deps} 个，超大文件 ${s.bigFiles} 个` })
  }
  if (active.has('security')) {
    const audit = checks?.audit
    const vulnPenalty = audit && typeof audit.high === 'number' ? audit.high * 6 + (audit.critical ?? 0) * 12 : 0
    const score = s.files === 0 ? 0 : clamp(90 - Math.min(25, s.deps) - s.debug - (s.emptyCatch > 0 ? 5 : 0) - vulnPenalty)
    const auditHint = audit && typeof audit.high === 'number' ? `，npm audit：高危 ${audit.high} / 严重 ${audit.critical ?? 0}` : ''
    dims.push({ key: 'security', label: DIM_LABELS.security, score, hint: `依赖 ${s.deps} 个（外部依赖越多攻击面越大），调试残留 ${s.debug} 处${auditHint}` })
  }
  return dims
}

/** 评分的同时收集问题清单。 */
function collectIssues(s, dims, checks) {
  const issues = []
  if (s.files === 0) issues.push({ severity: 'error', msg: '目标目录未发现可审查的代码文件（检查路径或忽略规则）' })
  if (s.bigFiles > 0) issues.push({ severity: 'warn', msg: `${s.bigFiles} 个文件超过 500 行，建议拆分` })
  if (s.longLines > 0) issues.push({ severity: 'info', msg: `${s.longLines} 行超过 120 字符，建议换行` })
  if (s.todo > 0) issues.push({ severity: 'warn', msg: `存在 ${s.todo} 处 TODO/FIXME/HACK 遗留标记` })
  if (s.emptyCatch > 0) issues.push({ severity: 'error', msg: `${s.emptyCatch} 处空 catch，异常被静默吞掉` })
  if (s.debug > 0) issues.push({ severity: 'warn', msg: `${s.debug} 处 console.log/debugger 调试残留` })
  if (s.testFiles === 0 && s.files > 0) issues.push({ severity: 'warn', msg: '未发现测试文件，建议补充自动化测试' })
  if (!s.readme) issues.push({ severity: 'info', msg: '缺少 README 文档' })
  if (!s.license) issues.push({ severity: 'info', msg: '缺少 LICENSE' })
  if (!s.gitignore) issues.push({ severity: 'info', msg: '缺少 .gitignore' })
  if (s.mixedIndentFiles > 0) issues.push({ severity: 'warn', msg: `${s.mixedIndentFiles} 个文件混用 Tab/空格缩进` })
  const test = checks?.test
  if (test?.ok === true && test.exitCode !== 0) issues.push({ severity: 'error', msg: `测试存在但运行失败（退出码 ${test.exitCode}）` })
  const lint = checks?.lint
  if (lint?.ok === true && lint.exitCode !== 0) issues.push({ severity: 'warn', msg: `类型检查 / lint 失败（退出码 ${lint.exitCode}）` })
  const audit = checks?.audit
  if (audit && typeof audit.critical === 'number' && (audit.critical > 0 || audit.high > 0)) {
    issues.push({ severity: 'error', msg: `依赖存在安全漏洞：高危 ${audit.high} 个 / 严重 ${audit.critical} 个（建议 npm audit fix）` })
  }
  if (dims.some((d) => d.score < 40)) issues.push({ severity: 'error', msg: '存在低于 40 分的维度，建议优先整改' })
  return issues
}

/** 对粘贴的文本片段做简化统计（单文件模式）。 */
function scoreText(text) {
  const lines = text.split('\n')
  const s = {
    files: 1, dirs: 0, lines: lines.length, byExt: { '(text)': 1 },
    todo: (/TODO|FIXME|HACK|XXX/.test(text) ? 1 : 0),
    debug: (/console\.(log|debug)|debugger\b/.test(text) ? 1 : 0),
    emptyCatch: (/catch\s*\([^)]*\)\s*\{\s*\}/.test(text) ? 1 : 0),
    bigFiles: 0, testFiles: 0, readme: false, license: false, gitignore: false, hasPackage: false,
    deps: 0, tabs: 0, spaces: 0, mixedIndentFiles: 0,
    longLines: lines.filter((l) => l.length > 120).length,
  }
  return s
}

/** 审查一个目标：路径或文本。返回评分结果（缓存供雷达图 + 写入历史）。 */
async function runReview(target, cfg, sessionId) {
  const stats = target.isPath ? scanProject(target.path, cfg) : scoreText(target.text)
  const checks = target.isPath ? await runToolChecks(target.path, cfg) : { test: null, lint: null, audit: null }
  const dims = scoreProject(stats, cfg, checks)
  const issues = collectIssues(stats, dims, checks)
  const overall = dims.length > 0 ? Math.round(dims.reduce((n, d) => n + d.score, 0) / dims.length) : 0
  const result = {
    ok: true,
    id: Date.now().toString(36),
    target: target.isPath ? target.path : '(内联文本)',
    sessionId,
    at: new Date().toISOString(),
    stats: {
      files: stats.files, dirs: stats.dirs, lines: stats.lines,
      byExt: Object.fromEntries(Object.entries(stats.byExt).sort((a, b) => b[1] - a[1]).slice(0, 8)),
    },
    checks,
    dims,
    issues,
    overall,
    threshold: cfg.threshold,
    passed: overall >= cfg.threshold,
  }
  lastReview = result
  reviewHistory.unshift(result)
  reviewHistory = reviewHistory.slice(0, HISTORY_LIMIT)
  saveJsonFile(HISTORY_FILE, reviewHistory)
  return result
}

/* ---------------- 工具定义 ---------------- */

const reviewAuditTool = defineTool({
  name: 'review_audit',
  description: '审查项目或代码质量：对指定路径（或粘贴代码）做多维度健康评分（结构/可维护性/一致性/健壮性/测试/文档/性能/安全），返回 0-100 评分与问题清单。当完成一个开发任务、模块或较大改动后，应主动调用本工具进行质量审查（不要等用户要求）；发现 error 级问题或综合分低于阈值时主动修复并复查。',
  parameters: {
    path: { type: 'string', description: '要审查的项目目录绝对路径（与 text 二选一）' },
    text: { type: 'string', description: '要审查的代码片段文本（与 path 二选一）' },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', required: true },
        error: { type: 'string' },
        id: { type: 'string' },
        sessionId: { type: 'string' },
        target: { type: 'string' },
        at: { type: 'string' },
        overall: { type: 'integer' },
        passed: { type: 'boolean' },
        threshold: { type: 'integer' },
        dims: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { key: { type: 'string' }, label: { type: 'string' }, score: { type: 'integer' }, hint: { type: 'string' } } } },
        issues: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { severity: { type: 'string' }, msg: { type: 'string' } } } },
        stats: { type: 'object', additionalProperties: true },
        checks: { type: 'object', additionalProperties: true },
      },
    },
    render(_args, value) {
      const v = value
      const lines = []
      lines.push(`审查目标：${v?.target ?? ''}`)
      lines.push(`综合健康度：${v?.overall ?? '?'}/100 ${v?.passed ? '✅ 通过' : '⚠️ 未达阈值'}`)
      for (const d of v?.dims ?? []) lines.push(`- ${d.label}：${d.score}/100（${d.hint ?? ''}）`)
      lines.push('')
      lines.push('问题清单：')
      for (const i of v?.issues ?? []) lines.push(`- [${i.severity}] ${i.msg}`)
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  async execute(args, exec) {
    const cfg = loadConfig()
    const a = args ?? {}
    const sessionId = typeof exec?.agent?.session?.id === 'string' ? exec.agent.session.id : undefined
    if (typeof a.path === 'string' && a.path.trim() !== '') {
      const p = a.path.trim()
      if (!existsSync(p)) return { ok: false, error: `路径不存在：${p}` }
      const st = statSync(p)
      if (!st.isDirectory()) return { ok: false, error: `不是目录（请用 text 审查单文件）：${p}` }
      return await runReview({ isPath: true, path: p }, cfg, sessionId)
    }
    if (typeof a.text === 'string' && a.text.trim() !== '') {
      return await runReview({ isPath: false, text: a.text }, cfg, sessionId)
    }
    return { ok: false, error: '请提供 path（项目目录）或 text（代码片段）' }
  },
})

/* ---------------- 路由 ---------------- */

function apply(ctx) {
  ctx.effect(() => {
    const tools = ctx.tools
    const disposers = []
    if (tools?.register !== undefined) disposers.push(tools.register(reviewAuditTool))
    const sys = ctx.get('systemPrompt')
    if (sys?.section !== undefined) {
      try {
        disposers.push(sys.section({
          name: 'plugin-review-discipline',
          order: 150,
          text: REVIEW_DISCIPLINE,
        }))
      } catch (e) {
        console.log(`[plugin-review] systemPrompt section 注册失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    const webServer = ctx.webServer
    if (webServer === undefined) {
      return () => { for (const d of disposers) d() }
    }
    const disposeRoutes = webServer.register({
      kind: 'prefix',
      path: '/api/review',
      handler: async (req, res) => {
        const json = (status, body) => {
          res.statusCode = status
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(body))
        }
        const url = req?.url ?? '/'
        const method = req?.method ?? 'GET'
        const path = url.split('?')[0] ?? '/'
        try {
          if (method === 'GET' && (path === '/api/review/config' || path === '/api/review/config/')) {
            json(200, { ok: true, config: loadConfig() })
            return
          }
          if (method === 'POST' && (path === '/api/review/config' || path === '/api/review/config/')) {
            let body = ''
            req?.on?.('data', (c) => { body += c.toString('utf8') })
            req?.on?.('end', () => {
              ;(async () => {
                try {
                  const next = JSON.parse(body).config ?? {}
                  const merged = { ...DEFAULT_CONFIG, ...next }
                  saveConfig(merged)
                  json(200, { ok: true, config: merged })
                } catch (error) {
                  json(400, { ok: false, message: error instanceof Error ? error.message : String(error) })
                }
              })()
            })
            return
          }
          if (method === 'GET' && (path === '/api/review/history' || path === '/api/review/history/')) {
            const q = new URLSearchParams(url.split('?')[1] ?? '')
            const sort = ['time', 'project', 'score'].includes(q.get('sort') ?? '') ? q.get('sort') : 'time'
            const page = Math.max(1, Number.parseInt(q.get('page') ?? '1', 10) || 1)
            const pageSize = Math.min(50, Math.max(1, Number.parseInt(q.get('pageSize') ?? '20', 10) || 20))
            purgeExpiredTrash()
            const sorted = sortHistory(reviewHistory, sort)
            const total = sorted.length
            const totalPages = Math.max(1, Math.ceil(total / pageSize))
            const items = sorted.slice((page - 1) * pageSize, page * pageSize)
            json(200, { ok: true, sort, page, pageSize, total, totalPages, items })
            return
          }
          const delMatch = /^\/api\/review\/history\/([^/]+)$/.exec(path)
          if (method === 'DELETE' && delMatch !== null) {
            const id = decodeURIComponent(delMatch[1])
            const idx = reviewHistory.findIndex((h) => h.id === id)
            if (idx === -1) { json(404, { ok: false, message: `记录不存在：${id}` }); return }
            const [moved] = reviewHistory.splice(idx, 1)
            moved.deletedAt = new Date().toISOString()
            reviewTrash.unshift(moved)
            saveJsonFile(HISTORY_FILE, reviewHistory)
            saveJsonFile(TRASH_FILE, reviewTrash)
            json(200, { ok: true, id })
            return
          }
          if (method === 'GET' && (path === '/api/review/trash' || path === '/api/review/trash/')) {
            purgeExpiredTrash()
            json(200, { ok: true, trash: reviewTrash, retentionDays: Number(loadConfig().trashRetentionDays) || 0 })
            return
          }
          if (method === 'POST' && (path === '/api/review/trash/restore' || path === '/api/review/trash/restore/')) {
            let body = ''
            req?.on?.('data', (c) => { body += c.toString('utf8') })
            req?.on?.('end', () => {
              ;(async () => {
                try {
                  const id = JSON.parse(body).id
                  const idx = reviewTrash.findIndex((t) => t.id === id)
                  if (idx === -1) { json(404, { ok: false, message: `回收站无此记录：${id}` }); return }
                  const [moved] = reviewTrash.splice(idx, 1)
                  delete moved.deletedAt
                  reviewHistory.unshift(moved)
                  reviewHistory = reviewHistory.slice(0, HISTORY_LIMIT)
                  saveJsonFile(HISTORY_FILE, reviewHistory)
                  saveJsonFile(TRASH_FILE, reviewTrash)
                  json(200, { ok: true, id })
                } catch (error) {
                  json(400, { ok: false, message: error instanceof Error ? error.message : String(error) })
                }
              })()
            })
            return
          }
          const delTrashMatch = /^\/api\/review\/trash\/([^/]+)$/.exec(path)
          if (method === 'DELETE' && delTrashMatch !== null) {
            const id = decodeURIComponent(delTrashMatch[1])
            const idx = reviewTrash.findIndex((t) => t.id === id)
            if (idx === -1) { json(404, { ok: false, message: `回收站无此记录：${id}` }); return }
            reviewTrash.splice(idx, 1)
            saveJsonFile(TRASH_FILE, reviewTrash)
            json(200, { ok: true, id })
            return
          }
          if (method === 'POST' && (path === '/api/review/trash/empty' || path === '/api/review/trash/empty/')) {
            reviewTrash = []
            saveJsonFile(TRASH_FILE, reviewTrash)
            json(200, { ok: true })
            return
          }
          if (method === 'GET' && (path === '/api/review/stats' || path === '/api/review/stats/')) {
            const map = new Map()
            for (const h of reviewHistory) {
              const cur = map.get(h.target) ?? { target: h.target, count: 0, sum: 0, min: 101, max: -1, lastAt: '' }
              cur.count += 1
              cur.sum += h.overall ?? 0
              cur.min = Math.min(cur.min, h.overall ?? 0)
              cur.max = Math.max(cur.max, h.overall ?? 0)
              if (cur.lastAt === '' || h.at > cur.lastAt) cur.lastAt = h.at
              map.set(h.target, cur)
            }
            const stats = [...map.values()]
              .map((s) => ({ target: s.target, count: s.count, avg: Math.round(s.sum / s.count), min: s.min, max: s.max, lastAt: s.lastAt }))
              .sort((a, b) => b.count - a.count || b.avg - a.avg)
            json(200, { ok: true, stats })
            return
          }
          if (method === 'GET' && (path === '/api/review/export' || path === '/api/review/export/')) {
            json(200, { ok: true, rows: sortHistory(reviewHistory, 'time') })
            return
          }
          if (method === 'POST' && (path === '/api/review/rerun' || path === '/api/review/rerun/')) {
            let body = ''
            req?.on?.('data', (c) => { body += c.toString('utf8') })
            req?.on?.('end', () => {
              ;(async () => {
                try {
                  const parsed = JSON.parse(body)
                  const target = (parsed.target ?? '').trim()
                  if (target.length === 0) { json(400, { ok: false, message: 'rerun needs a target' }); return }
                  if (!existsSync(target)) { json(404, { ok: false, message: `路径不存在：${target}` }); return }
                  const st = statSync(target)
                  if (!st.isDirectory()) { json(400, { ok: false, message: `不是目录：${target}` }); return }
                  const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined
                  const result = await runReview({ isPath: true, path: target }, loadConfig(), sessionId)
                  json(200, { ok: true, result })
                } catch (error) {
                  json(400, { ok: false, message: error instanceof Error ? error.message : String(error) })
                }
              })()
            })
            return
          }
          if (method === 'GET' && (path === '/api/review/last' || path === '/api/review/last/')) {
            json(200, { ok: true, result: lastReview })
            return
          }
          json(404, { ok: false, message: `unknown ${method} ${path}` })
        } catch (error) {
          json(500, { ok: false, message: error instanceof Error ? error.message : String(error) })
        }
      },
    })
    return () => {
      disposeRoutes()
      for (const d of disposers) d()
    }
  })
}

export { apply, inject, name }
