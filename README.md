# DSH 审查模式（plugin-review）

把 DeepSeek Harness 变成一个**自带代码质量审查纪律**的工作台：对项目/代码做**多维度健康评分**（程序化指标 + 雷达图可视化），支持**手动触发**、**对话指令触发**，以及 **AI 在模块/任务完成后主动触发**审查。

![review](https://img.shields.io/badge/dsh-plugin-yes-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![version](https://img.shields.io/badge/version-0.1.0-blue)

## 特性

- 🔍 **审查模式开关**：输入框 + 号旁的「审查」按钮，开启后输入项目路径或粘贴代码即审
- 🤖 **AI 主动审查**：注入系统守则——AI 在完成一个任务/模块/一轮修复后**主动**调用 `review_audit`，发现 error 级问题或低于及格线时主动修复并复查
- 📊 **8 维健康评分**（程序化指标，非纯主观）：结构 / 可维护性 / 一致性 / 健壮性 / 测试 / 文档 / 性能 / 安全
- 📈 **程序生成雷达图**：对话内审查结果卡 + 审查历史弹窗，SVG 雷达图实时渲染
- 🗂 **审查历史**：分类（时间 / 项目 / 成绩）、分页、删除、**回收站**（默认保留 7 天，可配置，过期自动清除）
- 📤 **导出 CSV / 项目统计 / 一键重审**
- ⚙️ **设置页配置**：维度开关、及格线、扫描上限/深度、忽略目录、回收站天数

## 兼容性

- DeepSeek Harness **0.1.0-rc.6+**（Cordis 注入规范 + 客户端 `__ModuleLoader__` 注册规范）
- 平台：Windows / macOS / Linux（扫描逻辑跨平台；`USERPROFILE` 路径回退适配 Windows 无 `HOME` 的场景）
- 扫描会读取目标项目文件（前 40KB/文件）做统计，**不修改**目标项目任何内容

## 安装

**方式一：GitHub 源（推荐）**

```sh
dsh plugin --profile web add "github:Mingxi2077/dsh-plugin-review#main"
# 重启 dsh web，刷新页面
```

**方式二：本地目录**

```sh
# 在有源码时
dsh plugin --profile web add /path/to/plugin-review
# 或手动：把目录放入 profile 的 node_modules，并在 web profile 的
# dsh.profile.bundles 加入 "plugin-review"，然后重启 dsh web
```

### 卸载

```sh
dsh plugin --profile web remove plugin-review
# 或从 web profile 的 bundles 移除对应条目，重启
```

## 快速开始

1. 重启 dsh web 后，输入框左下出现 **「审查」** 按钮
2. 点击开启审查模式（输入框上方出现横幅）
3. 输入要审查的目标，例如：`审查 E:\my_project\src` 或直接粘贴代码
4. 发送后模型调用 `review_audit` → 对话中出现**雷达图评分卡** + 审查报告
5. 不点按钮也行：AI 会在模块完成时**主动**触发；或对话里说"审查/评测"也会触发

## 配置

设置页 **设置 → 审查** 可配置（持久化到 `$DSH_HOME/review-config.json`）：

| 配置项 | 说明 | 默认 |
|---|---|---|
| 评分维度 | 参与评分的 8 个维度开关 | 全部开启 |
| 及格线 | 综合分 ≥ 此值视为通过 | 60 |
| 扫描文件上限 | 最多扫描的文件数 | 300 |
| 目录深度上限 | 递归扫描的最大深度 | 4 |
| 忽略目录 | 扫描时跳过的目录（逗号分隔） | node_modules, .git, dist 等 |
| 回收站保留天数 | 删除的审查记录可恢复天数（0 = 立即删除） | 7 |

## 数据与权限

插件会读写以下文件（均在 `$DSH_HOME` 下）：

| 文件 | 用途 |
|---|---|
| `review-config.json` | 审查配置 |
| `review-history.json` | 审查历史（最多 50 条） |
| `review-trash.json` | 回收站（按保留天数过期清除） |

审查时会**读取**目标项目文件前 40KB 做统计（不写、不改目标项目）；对话 URL 使用审查发生时的会话 ID（仅存 ID，不存内容）。

## 常见问题

- **雷达图/历史不显示**：确认已重启 dsh web 并硬刷新（Ctrl+F5）；历史记录在 `$DSH_HOME/review-history.json`，删除该文件会清空历史。
- **审查报"路径不存在"**：`review_audit` 需要绝对路径；审查单文件请用 `text` 参数（粘贴代码）。
- **设置保存无效**：Windows 下需确保 `$DSH_HOME` 可写；保存后设置页会回显新值。
- **回收站记录消失**：超过保留天数会被自动彻底删除（读取时惰性清理）。

## 开发

```
plugin-review/
├── package.json          # bundle 插件声明（dsh.bundle）
├── cordis.patch.yml      # 组合插入行（id: plugin-review）
└── lib/
    ├── index.mjs         # Node half：review_audit 工具 + 扫描评分 + API（/api/review/*）
    └── index.js          # Browser half：审查按钮/横幅/设置页/雷达图/历史/回收站
```

- Node half 遵循 rc.6 注入规范（`inject: ['webServer','tools','systemPrompt']`，服务用 `ctx.get` 安全读取）
- Browser half 使用 `window.__ModuleLoader__.load({ id, factory })` 注册外壳（require 获取 React）
- 本地修改后：`lib/` 两个文件同步到 profile 的 `node_modules/<name>/lib/` 并重启生效
- 雷达图为纯 SVG 程序生成（`RadarChart` 组件），无外部图表依赖

## 路线图

- [ ] 审查报告导出为 Markdown/JSON
- [ ] 按项目平均分趋势图
- [ ] 重审结果对比视图（旧分 vs 新分）

## 许可证

MIT License。见 [LICENSE](LICENSE)。

> 与 DeepSeek 官方无关联；插件名称、描述仅供社区分发使用。
