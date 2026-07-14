# MCP Browser/JS 调试类工具竞品分析

> 数据来源：GitHub 搜索（2026-03-17）
> 搜索关键词：playwright mcp、chrome devtools mcp、javascript reverse engineering mcp、browser automation mcp 等多组关键词

---

## 一、全量竞品汇总（按 Stars 排序）

| 工具 | ⭐ Stars | Forks | 最近 Push | 语言 | License | JS调试能力 | 反检测 | 定位 |
|------|---------|-------|-----------|------|---------|------------|--------|------|
| [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | 29,062 | 2,338 | 2026-03-16 | TypeScript | Apache-2.0 | ❌ | ❌ | 微软官方，通用浏览器自动化，行业标准 |
| [browserbase/mcp-server-browserbase](https://github.com/browserbase/mcp-server-browserbase) | 3,191 | 337 | 2026-02-27 | TypeScript | Apache-2.0 | ❌ | ❌ | 云端浏览器（付费服务），Stagehand AI 驱动 |
| [refreshdotdev/web-eval-agent](https://github.com/refreshdotdev/web-eval-agent) | 1,235 | 104 | 2026-02-11 | Python | Apache-2.0 | ❌ | ❌ | Web 应用自动化 QA 测试评估 |
| [jae-jae/fetcher-mcp](https://github.com/jae-jae/fetcher-mcp) | 1,009 | 93 | 2026-01-14 | TypeScript | MIT | ❌ | ❌ | Playwright 无头浏览器抓取网页内容 |
| [kontext-dev/browser-use-mcp-server](https://github.com/kontext-dev/browser-use-mcp-server) | 812 | 112 | 2025-07-10 | Python | MIT | ❌ | ❌ | AI 驱动网页浏览（browser-use/LangChain） |
| **[js-reverse-mcp](https://github.com/zhizhuodemao/js-reverse-mcp)** | — | — | **2026-03（活跃）** | TypeScript | Apache-2.0 | ✅ | ✅ **唯一** | 反检测 + JS 逆向工程调试 |
| [NoOne-hub/JSReverser-MCP](https://github.com/NoOne-hub/JSReverser-MCP) | — | — | 2026-03-09（活跃） | — | Apache-2.0 | ✅ | ❌ | Hook 系统 + AI 增强分析 + 本地复现工程体系 |
| [reverse-craft/rc-devtools-mcp](https://github.com/reverse-craft/rc-devtools-mcp) | 5 | 1 | 2026-01-10 | TypeScript | Apache-2.0 | ✅ | ❌ | JS 调试 + 脚本替换 + 调用图分析 |
| [Eddym06/chrome-devTools-advanced-mcp](https://github.com/Eddym06/chrome-devTools-advanced-mcp) | 4 | 0 | 2026-02-26 | TypeScript | MIT | ❌ | ❌ | Playwright+CDP，50工具，HAR录制/回放 |
| [echo-lumen/cdp-browser-mcp](https://github.com/echo-lumen/cdp-browser-mcp) | 0 | 0 | 2026-03-08 | JavaScript | MIT | ❌ | ❌ | 纯 CDP，宣称比 Playwright MCP 省 5.5x token |

---

## 二、JS 逆向工程三工具详细对比

> 仅含具备 JS 调试/逆向能力的三个工具

| 功能维度 | js-reverse-mcp | JSReverser-MCP | rc-devtools-mcp |
|----------|---------------|----------------|-----------------|
| **反检测（Patchright C++）** | ✅ 通过知乎/Google 指纹检测 | ❌ Puppeteer | ❌ |
| **CDP 导航静默（防 anti-bot 触发）** | ✅ NAVIGATION 类别跳过 CDP init | ❌ | ❌ |
| **Canvas/WebGL/WebRTC 指纹防护** | ✅ hideCanvas/disableWebgl/blockWebrtc | ❌ | ❌ |
| **断点设置/管理/列表** | ✅ | ✅ | ✅ |
| **XHR/Fetch 断点** | ✅ | ✅ | ✅ |
| **URL Regex 断点** | ✅ | ✅ | ✅ |
| **按代码文本自动定位断点** | ❌ | ✅ `set_breakpoint_on_text` | ❌ |
| **单步执行（into/over/out）** | ✅ | ✅ | ✅ |
| **变量检查（scope）** | ✅ | ✅ | ✅ 更丰富（分页/过滤scope类型/存文件） |
| **call frame 表达式求值** | ✅ | ✅ | ✅ |
| **脚本内容全文搜索** | ✅ | ✅ `search_in_sources` | ❌ |
| **WebSocket 帧收集** | ✅ | ❌ | ❌ |
| **性能 Trace 分析** | ✅ | ❌ | ❌ |
| **网络监控** | ✅ | ✅ | ✅ 更丰富（搜索/分页/保存到文件） |
| **请求触发者追溯** | ❌ | ✅ `get_request_initiator` | ❌ |
| **脚本源码保存** | ✅ | ✅ | ✅ |
| **调用图分析** | ❌ | ❌ | ✅ `analyze_call_graph`（上下游追踪） |
| **函数名全局搜索** | ❌ | ❌ | ✅ `search_functions` |
| **脚本运行时替换** | ❌ | ❌ | ✅ `replace_script`（持久跨刷新） |
| **有效断点位置查询** | ❌ | ❌ | ✅（混淆代码调试必需） |
| **变量导出为 JSON** | ❌ | ❌ | ✅ `save_scope_variables` |
| **Hook 系统（侵入式最小观测）** | ❌ | ✅ `hook_function` / `trace_function` | ❌ |
| **AI 辅助代码理解/反混淆** | ❌ | ✅ `understand_code` / `deobfuscate_code` | ❌ |
| **本地复现工程导出** | ❌ | ✅ `export_rebuild_bundle` | ❌ |
| **会话状态快照/恢复** | ❌ | ✅ `save/restore_session_state` | ❌ |
| **Storage 读取（cookie/localStorage）** | ❌ | ✅ `get_storage` | ❌ |
| **风险视图聚合面板** | ❌ | ✅ `risk_panel` | ❌ |
| **已验证真实逆向案例** | ❌ | ✅ 京东h5st/快手falcon/抖音a-bogus | ❌ |
| **最近更新** | 2026-03（活跃） | 2026-03-09（活跃） | 2026-01-10（疑似停更） |

---

## 三、rc-devtools-mcp 功能详解

**仓库**：https://github.com/reverse-craft/rc-devtools-mcp
**npm 包**：`@reverse-craft/rc-devtools-mcp`
**Stars**：5 ⭐ | **最近 Push**：2026-01-10 | **License**：Apache-2.0

### 工具分类

#### 断点管理
- `set_breakpoint` — 支持 urlRegex + 行列号 + condition + 智能列吸附（snapRange）
- `remove_breakpoint` / `list_breakpoints` / `clear_all_breakpoints`
- `get_possible_breakpoints` — **查询混淆代码中有效断点位置**（js-reverse-mcp 缺失）
- `set_xhr_breakpoint` / `remove_xhr_breakpoint` / `list_xhr_breakpoints`

#### 执行控制
- `step_into` / `step_over` / `step_out` / `resume_execution`
- 所有 step 工具支持参数：maxCallStackDepth、contextLines、maxLocalVariables

#### 变量检查
- `get_debugger_status` — 调试状态（调用栈+变量+代码上下文）
- `evaluate_on_call_frame` — 表达式求值，可保存结果到文件
- `get_scope_variables` — 支持按 scopeType 过滤、按名称搜索、分页、保存
- `save_scope_variables` — **全量变量导出为 JSON**（js-reverse-mcp 缺失）

#### 脚本分析（js-reverse-mcp 完全缺失的模块）
- `analyze_call_graph` — 函数调用链上下游分析（upstreamDepth/downstreamDepth 可配）
- `search_functions` — 按名称搜索已加载脚本中的所有函数
- `save_script_source` — 保存脚本源码到文件

#### 脚本替换（js-reverse-mcp 完全缺失）
- `replace_script` — 运行时替换脚本片段，**页面刷新后规则持续生效**
- `list_script_replacements` / `remove_script_replacement` / `clear_script_replacements`

---

## 四、JSReverser-MCP 功能详解（新兴竞品）

**仓库**：https://github.com/NoOne-hub/JSReverser-MCP
**底层**：Puppeteer（非 Playwright）
**最近 Push**：2026-03-09（v2.0.3，活跃）| **License**：Apache-2.0
**备注**：README 明确声明参考了 `zhizhuodemao/js-reverse-mcp`

### 独有功能（js-reverse-mcp 完全没有）

#### Hook 系统（侵入式最小观测）
- `create_hook` / `inject_hook` / `get_hook_data` — 创建、注入、读取 hook 采样结果
- `hook_function` — 直接 hook 全局函数/对象方法，记录参数和返回值
- `trace_function` — 按源码函数名做调用追踪

#### AI 增强分析层（可接 OpenAI/Anthropic/Gemini）
- `understand_code` — AI 辅助代码语义理解、业务逻辑提取
- `deobfuscate_code` — 混淆代码还原（本地+AI双模式）
- `risk_panel` — 聚合代码分析、加密检测、hook信号输出风险视图
- `collect_code` — 按优先级采集页面代码

#### 本地复现工程体系
- `export_rebuild_bundle` — 导出本地复现工程（入口+补环境+证据材料）
- `diff_env_requirements` — 比对 Node 运行缺失的环境能力
- `record_reverse_evidence` — 把关键观察写入 task artifact 沉淀证据

#### 会话管理
- `save_session_state` / `restore_session_state` — 内存快照保存/恢复登录态
- `dump_session_state` / `load_session_state` — JSON 持久化会话

#### 其他
- `get_request_initiator` — 追溯请求触发者（定位调用链）
- `get_storage` — 读取 cookie/localStorage/sessionStorage
- `set_breakpoint_on_text` — 按代码文本自动定位断点（无需行号）
- `search_in_sources` — 所有已加载源码中搜索关键字
- `check_browser_health` — 浏览器连接健康检查

### 已沉淀真实案例
- 京东 `h5st` 参数
- 快手 `falcon` 风控参数
- 抖音 `a-bogus` 参数

### 方法论（独有）
Observe-first → Hook-preferred → Breakpoint-last → Rebuild-oriented → Evidence-first → Pure-extraction-after-pass

### 不具备的能力
- 反检测（Patchright C++ 级别）❌
- CDP 导航静默（anti-bot 防触发）❌
- Canvas/WebGL/WebRTC 指纹防护 ❌

---

## 五、结论与定位分析

### 当前竞争格局

1. **通用浏览器自动化（无调试能力）**：由 `playwright-mcp`（29k★）统治，市场已饱和
2. **云端托管浏览器**：`browserbase`（3k★）有商业背景，面向企业级
3. **JS 调试/逆向专项**：赛道小众但逐渐活跃，三个工具（js-reverse-mcp、JSReverser-MCP、rc-devtools-mcp）各有侧重，说明**市场需求真实存在但尚未被充分挖掘**

### js-reverse-mcp 核心竞争优势

**唯一具备 Patchright C++ 级反检测的 JS 逆向 MCP**，这是本工具在整个 MCP 生态中不可替代的差异化能力：
- 通过知乎、百度、Google、主流电商等主流反爬系统的指纹检测
- 导航期间 CDP 完全静默（其他工具一导航就触发 Debugger.enable 被识别）
- Canvas/WebGL/WebRTC 多维度指纹防护

### 竞品超越 js-reverse-mcp 的功能（值得参考引入）

| 优先级 | 来源 | 功能 | 逆向价值 |
|--------|------|------|----------|
| 🔴 高 | rc-devtools-mcp | `replace_script` 脚本运行时替换 | 逆向中修改代码逻辑的核心需求，刷新持续生效 |
| 🔴 高 | rc-devtools-mcp | `analyze_call_graph` 调用图分析 | 定位加密/签名函数入口的关键能力 |
| 🔴 高 | JSReverser-MCP | `hook_function` / `trace_function` Hook 系统 | 侵入式最小观测，记录参数和返回值，逆向首选手段 |
| 🔴 高 | JSReverser-MCP | `export_rebuild_bundle` 本地复现工程 | 完整补环境体系，实战必需 |
| 🟡 中 | rc-devtools-mcp | `search_functions` 函数名搜索 | 在大型混淆文件中快速定位目标函数 |
| 🟡 中 | rc-devtools-mcp | `get_possible_breakpoints` 有效断点查询 | 混淆代码调试必需 |
| 🟡 中 | JSReverser-MCP | `set_breakpoint_on_text` 按文本定位断点 | 无需行号，降低混淆代码调试门槛 |
| 🟡 中 | JSReverser-MCP | `get_request_initiator` 请求触发者追溯 | 快速定位签名函数调用链 |
| 🟢 低 | rc-devtools-mcp | `save_scope_variables` 变量导出 JSON | 方便离线分析大量变量 |
| 🟢 低 | JSReverser-MCP | `save/restore_session_state` 会话快照 | 登录态保持，避免重复登录 |
