
## 原始诉求
基于CodeGraph来构建移动端的知识图谱，要能更贴合移动端应用的特点，识别出他的模块依赖、页面迁移关系、依赖注入等移动端特有的一些隐形关系。在CodeGraph的纯代码的基础上进行增强。尤其是需要分析出功能模块，要能理解当前移动端应用究竟提供了哪些能力，他们之间的关系是什么，要高内聚低耦合的模块。

基于分析出来的知识图谱，我会从他的功能模块角度从下到上的进行功能迁移，比如Android迁移到鸿蒙、iOS迁移到鸿蒙等，我希望这个知识图谱尽量是可以中立的。需要当前能输出一份转换适配的模块迁移计划，这个会作为后续Agent转换的关键输入。功能模块不应该严格按照实际的工程模块来划分，应该是按照代码多少适当的聚合和拆分。这份输出很关键，一定要确保能真的帮助到转换。

迁移后我希望目标侧也能生成知识图谱，并且如果能基于两个项目的知识图谱进行对比分析，看看还有哪些功能没有迁移或者遗漏，可以进一步的能力增强。

整体能力的构建要面向Agent，AppGraph不负责转换，只是用来提取出确定性的关系和事实。

---

## AppGraph 架构（fork 在 CodeGraph 之上的增强）

**双图**：核心代码符号图（上游 CodeGraph 管线，`.codegraph/` SQLite）+ 平台中立的应用语义图 overlay（`src/appgraph/`，写 `.appgraph/app-graph.json`）。应用层**只读消费核心图**，不重扫源码。`src/migration/` 是应用层的一个消费者（源→目标迁移交付），不是它的拥有者。

**分层不变量**：`src/appgraph/` **不得 import `src/migration/`**（单向：appgraph 通用层 ← migration 消费者）。用 `grep -rn "migration/" src/appgraph --include='*.ts'` 应只剩注释。

**三个 bin**：`codegraph`（上游，勿动）、`migrate`（源→目标迁移）、`appgraph`（`appgraph build [--platform android|harmony|ios]` 写 `.appgraph/app-graph.json` + `screens|nav|features|capabilities` 查询）。`migrate sync` 与 `appgraph build` 共用同一 builder `src/appgraph/build.ts:buildAppGraph`，节点集逐一相同（parity 测试锁定）。

**核心图语义（Android，A1）** — 走三个既有插件缝，零触碰 `tree-sitter.ts`：
- 缝1 `extraction/languages/kotlin.ts:extractModifiers` — 注解简名进 `node.decorators`（`@Composable/@HiltViewModel/@Inject/@Binds`）。
- 缝2 `resolution/frameworks/compose.ts` — NavHost DSL（`composable`/`dialog`/`entry<>`，string + type-safe）→ `route` 节点 + route→composable `references` 边。
- 缝3 `resolution/android-synthesizer.ts` — 三族合成边（`provenance:'heuristic'`）：`android-intent`（startActivity/startService(Intent(X::class.java))→类）、`compose-route`（navigate→route）、`compose-state`（VM 写状态方法→收集该 VM 的 @Composable，跨类 recomposition，赋值门控 + fan-out cap 8）。
- 合成边读取：`appgraph/graph-reader.ts:getSynthesizedEdges(synthesizedBy[])`（保留 metadata，`getAllEdges` 丢弃 metadata）。

**应用语义层（A2）** — 导航单源：`appgraph/lift/navigates-from-core.ts:liftNavigatesToFromCore` 读 `compose-route`/`android-intent` 合成边 → Screen→Screen `navigates_to`/`backed_by`（`provenance:'lifted'` + `attrs.liftedFrom`），跟一跳 `calls` 处理帮助方法间接。`detect/compose.ts` 与 `lift/android-navigation.ts` 的字符串扫描已删（Fragment/Dialog 后缀发现保留）。端点按 名/全限定符号/符号尾 三键索引（manifest Activity 的 FQN 符号对齐核心类简名）。

**Agent 消费面**：主通道 `appgraph/annotate.ts` + `mcp/tools.ts` explore 钩子（命中 `.appgraph/` 的 Screen/AppEntry 符号追加一行 `App: Screen '…' (launcher) — navigates_to: …`，无 `.appgraph/` 静默）；辅通道 migrate MCP `app_screens`/`app_nav`/`app_features` + `appgraph` CLI 查询。**不扩 codegraph MCP 默认工具集**（新工具 under-pick）。

## 上游触点清单（fork 分歧收敛点，merge 上游时重点看这几处）

改上游文件仅这几处，其余全是 `src/appgraph/` + `src/resolution/{android,compose}*` 新文件：
- `src/extraction/languages/kotlin.ts` — `extractModifiers` 追加注解简名（缝1）。**未碰 `tree-sitter.ts`**。
- `src/resolution/frameworks/index.ts` — +1 import、+1 数组项（注册 `composeResolver`）。
- `src/resolution/callback-synthesizer.ts` — +1 import、+3 调用、+3 merge 项（接线 `android-synthesizer` 三族，与 goframe/arkui 并列）。
- `src/mcp/tools.ts` — +1 import、explore 后置钩子 `appGraphFacts`（~10 行）+ `synthEdgeNote` 6 个友好标签 case（compose/android/arkui 族）。

## 已知遗留 / 未做

- **真实仓库 A/B 未跑**：A1/A2 用合成 fixture 单测 + 确定性探针验证；`references/samples/`（nowinandroid 等）此环境不存在，agent A/B 待样本补测。
- **compose 导航召回边界**：纯命名启发式（`navigateToTopic()` 背后无代码）不再臆测——需真实 `navigate`/`startActivity` 核心图看得见（precise-or-drop）。
- **Phase H（Harmony 生产者）/ Phase I（iOS）未做**：核心 arkui 三族已备；H 重建 `extractors/harmony/` + 从 `verify/target-graph.ts` 抽对称投影。
- **包名仍 `@colbymchenry/codegraph`**：fork 勿误发布（发布策略由维护者拍板）。

