# migration — Android 源工程迁移分析(功能模块图谱 + 工单 + 验收)

在 codegraph 代码符号图之上,做 **Android → HarmonyOS 迁移的源侧分析**:梳理功能模块依赖图、语义事实(屏幕/实体/DI/数据流/权限)、自底向上迁移顺序,并产出交付给**外部迁移 agent** 的工单与验收闸门。**本层不做代码翻译**——翻译与目标工程装配由消费工单的外部 agent 完成。

是与 `src/appgraph/` 并列的 sibling 层,复用其确定性原语,产出独立的 **MigrationGraph JSON**(不写入 `codegraph.db`)。

## 管线与 CLI

每个阶段读取上一步的图 JSON 并就地增量扩充(`.migration/migration-graph.json`):

```bash
node dist/migration/cli.js index        <android-root>   # M0 建/刷新 codegraph 索引(复用 CodeGraph.indexAll/sync)
node dist/migration/cli.js modules      <android-root>   # M1 ArchModule + depends_on(声明 ∪ 隐式耦合)
node dist/migration/cli.js community    <android-root>   # M2 确定性社区检测 → Feature 功能簇
node dist/migration/cli.js capabilities <android-root>   # M3 API→能力 + 能力→HarmonyOS 目标 API + S1 权限能力
node dist/migration/cli.js semantics    <android-root>   # U+S2 角色/屏幕+导航/实体schema/DI图/数据流/资源 + 四大组件/Intent导航/深链/布局宿主
node dist/migration/cli.js order        <android-root>   # M3 SCC 缩点 + 自底向上拓扑序(叶子优先)
node dist/migration/cli.js plan         <android-root>   # P  迁移工单:单元计划 + 每单元 brief + 单元契约 + app 装配工单 + plan.json
node dist/migration/cli.js verify       <android-root> --target <harmony-root>            # M4 全量验收 diff(含 L2 导航/DI)
node dist/migration/cli.js verify       <android-root> --target <harmony-root> --unit <u> # M4 单元级验收(按契约逐条 + 三分类缺口)
node dist/migration/cli.js ledger set   <android-root> <unit> --status migrated [--target-module <m>] [--target-path <p>] [--export Src=Dst]  # 登记迁移进度
node dist/migration/cli.js ledger show  <android-root> [unit]   # 查看台账全表 / 单条
node dist/migration/cli.js sync         <android-root>   # I1 增量同步 + 变更单元报告(含语义常量/契约变化标记)
node dist/migration/cli.js serve --mcp --path <android-root>   # MCP 查询面(迁移 agent 在线查工单/事实/缺口/台账)
```

**迁移回路(每单元)**:`migrate_unit` 取工单 → `ledger set --status in-progress` → 翻译 → `ledger set --status migrated`(带 target-module/path/export)→ `verify --unit` → 修 unit-missing 缺口 → 下一单元。

- `plan --min-unit-symbols/--max-unit-symbols/--no-unit-planning`:单元计划层阈值(默认 120/3000)。小模块按安全规则聚合(叶子兄弟装箱、唯一 dependent 吸收),超大单模块按 M2 subdivision Feature 拆成 sub-unit(成员文件圈定)+ remainder;`graph.order` 与图指纹不受影响,打包参数记录在 plan.json 的 `planning` 块。

## 与外部迁移 agent 的分工

```
appgraph(本层)                    外部迁移 agent
──────────────────                ──────────────────
分析源工程 → 迁移图                读 plan.json / units/*.md
生成工单(事实+锚点+验收清单)   →   按自底向上顺序逐单元翻译
                                   写入真实 HarmonyOS 工程
验收(verify --target)         ←   跑 verify,按缺陷清单修复
增量 sync(源变更 → 需重迁单元) →   增量重迁
```

- **工单(`.migration/plan/units/NN-*.md`)**:每个迁移单元一份——模块角色分布、屏幕(含导航扇出)、实体字段 schema、DI 装配、响应式数据流、能力→HarmonyOS 目标 API 映射、公共接口(带源码文件锚点)、声明/隐式依赖,以及与 verify 对应的验收清单。事实带来源标注([清单]/[静态]/[启发])。
- **plan.json**:同一份事实的机器可读形态(全量 ModuleBrief)。
- **验收(T3/T4/V1/V2 + L2)**:`verify --target` 用 ArkAnalyzer 符号级解析目标工程,对能力覆盖、公共接口 fidelity(基线 = plan 持久化的 `attrs.publicInterface`)、屏幕(V1)、实体 schema(V2)、**导航拓扑 + DI 绑定(L2)**做双侧 diff,输出 `verify-report.json`。

## 转换支撑层:单元契约 + 迁移台账 + 语义真值

把「迁移成功标准」做成**分层的机器可读契约**。核心思想:只有平台翻译下必须**原样存活**的事实才做验收标准;类型/语法/框架结构永不做标准(交给目标编译器),否则同名空壳即可全绿(Goodhart 风险)。

- **契约(`plan/contracts/NN-*.json`)**:每单元一份,每条 check 的 id 由 `sha1(kind∅moduleId∅subject)` 内容派生 —— 重调 `--min/--max-unit-symbols` 重新打包后 check id 全集不变,只在契约文件间移动,验收发现可跨轮次 diff。tier 语义:

  | tier | 含义 | 例 | verify |
  |---|---|---|---|
  | **L1** | 存在性 | 接口/屏幕/数据模型字段集/能力/后台组件 | auto / agent |
  | **L2** | 关系拓扑 | 导航边(from→to)、DI 绑定(iface←impl 双端存在) | auto |
  | **L3** | 语义真值(字面量原样存活) | 常量/URL、路由、SQL、枚举取值集、深链 | auto(contains-scan) |
  | **L4** | 行为契约 | 测试移植义务清单(只提取,不执行) | agent(恒 info) |
  | info | 提示,永不判 fail | 暴露的响应式状态(命名不保) | info |

- **语义真值(U7)**:`detect/constants.ts` 从源码提取 `const val` 字面量/Retrofit 路由/Room SQL/枚举取值集,挂 `ArchModule.attrs.constants`;`verify/semantic-scan.ts` 对目标 `.ets/.ts/.json5` 做 contains-scan(诚实标注 depth=contains-scan:注释内字面量会误命中,与能力 marker 同一已知限制)。
- **行为契约(E/L4)**:`detect/tests.ts` 反转过滤 test 源集,把每个 `FooTest` 的 @Test 面提取为**移植义务清单**(`attrs.testContract`);appgraph 不执行测试,完成情况由迁移方自证。
- **迁移台账(`.migration/ledger.json`)**:agent 每迁一单元用 `migrate ledger set` 登记状态(pending→in-progress→migrated→verified,状态机校验非法迁移)+ 目标模块/路径/导出改名。台账驱动两件事:`verify --unit` 用它把失败 check 三分类;`targetPaths` 收窄目标扫描作用域,`exportMap` 匹配改名后的导出。台账是 agent **声明**,不校验真实性(路径不存在 → warning + 降级,不报错)。
- **单元级验收(`verify --unit`)**:只解析目标一次,逐 check 派发比对,失败三分类 —— **unit-missing**(台账已 migrated 却缺失,真缺口)/**dependency-missing**(引用的他单元事实还没迁,先迁依赖)/**not-migrated**(本单元未登记迁移,非缺口)。报告落 `.migration/verify/units/<unitId>.json`,带稳定 check id 可跨轮 diff。
- **应用装配工单(`plan/units/00-app-scaffold.md` + 契约)**:跨单元的全局装配事实 —— 全应用路由表(屏幕+导航+单元归属)、权限/深链(共享 module.json5)、EntryAbility 入口、数据模型/后台组件总表。**不进 `units[]`**(totalUnits/order 不变),`verify --unit scaffold` 核对 app 级契约。

## 阶段设计

| 阶段 | 产物 | 复用 |
|---|---|---|
| **M1 模块图** | ArchModule + depends_on(声明 confidence 1 ∪ 隐式 lifted) | appgraph gradle 解析;codegraph 全边上卷跨模块耦合 |
| **M2 社区** | 确定性 Feature(成员指纹作 matchKey) | graphology Louvain,移植 graphify `cluster.py` |
| **M3 能力** | Capability + uses_capability + HarmonyOS 目标 API 表 | 扩展 appgraph `capabilities.ts`;S1 manifest 权限能力 |
| **U 语义** | 角色/Screen(+navigates_to)/DataModel(字段 schema)/DI/流/资源 | codegraph span 读源 + 确定性 detect passes |
| **S2 结构** | Screen(activity)/BackgroundComponent(+目标映射)/AppEntry/Resource(深链)+ Intent navigates_to/backed_by + setContentView/ViewBinding 布局宿主 | 复用 appgraph `extractManifest` + `liftNavigation`(S1 曾丢弃的结构节点全部入图) |
| **M3 顺序** | SCC 缩点 + 拓扑序 | Tarjan;默认仅用声明依赖(DAG),`--include-lifted` 可对照 |
| **P 工单** | 单元计划 + plan.json(v3)+ 每单元 brief.md + 单元契约 + app 装配工单 + ArchModule.attrs.publicInterface | plan/unit-planning(打包)+ plan/context(组装)+ plan/brief(渲染)+ plan/contract(契约)+ plan/scaffold(装配) |
| **M4 验收** | 能力/接口/屏幕/实体/导航/DI diff + maps_to(verify-report.json 含 T3/T4/V1/V2/L2)+ 单元级三分类报告 | ArkAnalyzer 符号级(正则回退)+ appgraph `compareAppGraphs`;verify/unit + semantic-scan(L3)+ ledger 作用域 |
| **I1 增量** | sync-report(需重迁移的单元);保留 order/目标节点/publicInterface 基线 | codegraph sync + 结构层重建 + 图 diff |
| **MCP** | migrate_order / migrate_unit(含台账+契约摘要,"scaffold" 取装配工单)/ migrate_module_facts / migrate_verify_gaps(可带 unit)/ migrate_ledger | 独立 stdio server(复用 codegraph `StdioTransport`);产物未生成时 success-shaped 降级引导 |

## 关键取舍

- **不做翻译**。翻译是外部 agent 的职责:一次性 prompt 无法承载真实模块(私有实现、编译修复迭代都不在其能力内),而工单 + 按需读源码 + 验收回环是 agent 的自然工作形态。
- **迁移顺序只用声明依赖(Gradle DAG)排序**。隐式耦合边含假阳性/测试夹具回边,纳入会把几十个模块误合成一个巨型 SCC;真实代码依赖已被声明依赖(传递)覆盖。`--include-lifted` 可对照。工单中隐式耦合以 [启发] 标注供参考。
- **能力检测走 `import` 边,不依赖注解**。codegraph 对 Kotlin 的 `decorators` 列 0% 填充(实测),框架使用可从 import 完整包名精确识别。
- **验收基线在源侧**。T3 接口 fidelity 的基线是 plan 持久化在 android ArchModule 上的 `publicInterface`,与目标工程布局解耦(目标按模块名路径匹配,匹配不到时诚实降级为全局匹配并标注 scope)。
- **确定性是硬约束**。稳定 `makeNodeId`(sha1,排除行号)、社区成员指纹、Louvain 固定种子、`mergeInto` 排序数组;plan 输出同样字节稳定。两遍完整流程 `hashMigrationGraph` 一致。

## 文件布局

```
src/migration/
  types.ts            MigrationGraph 容器 + mergeInto(唯一合并原语)
  graph-reader.ts     只读打开 codegraph.db(节点 / 全边 / getCode)
  serialize.ts        确定性序列化(canonicalJson)+ 哈希 + 读写
  paths.ts            .migration/ 与 plan 目录
  capabilities-ext.ts 能力词表 + API→能力规则 + 能力→HarmonyOS 目标 API 表
  incremental.ts      I1:迁移图 diff(需重迁移的单元;含语义常量/契约变化)
  ledger.ts           迁移台账:状态机 + 目标模块/路径/导出改名(agent 声明,CLI 写入)
  cli.ts              commander CLI(index|modules|community|capabilities|semantics|order|plan|verify[--unit]|ledger set/show|sync|serve)
  modules/            M1:gradle-ext / assign(符号归属)/ aggregate(耦合上卷)/ index(编排)
  community/          M2:project(file 耦合投影)/ detect(Louvain 移植)/ index(Feature 综合)
  detect/             S1+S2+U:manifest 权限能力 / android 结构(组件+Intent导航+布局宿主)/ 角色 / compose+xml 屏幕 / 实体 / DI / 流 / 资源
  order/topo.ts       M3:Tarjan SCC + 自底向上拓扑序
  plan/               P:unit-planning(聚合/拆分)/ context(工单组装)/ brief(渲染)/ contract(单元契约)/ scaffold(app 装配)/ resolve(单元解析)/ index(计划+落盘)
  verify/             M4:target-graph(社区 tree-sitter 索引目标→投影 capability/screen/export/nav)/ capability-markers(能力 marker 表)/ diff(含 L2 导航/DI)/ structure-diff(V1/V2/导航)/ semantic-scan(L3 contains-scan)/ unit(单元级+三分类)
  mcp/                MCP 查询面:server(stdio JSON-RPC)/ tools(5 个查询工具)/ instructions
```

`.migration/` 布局:`migration-graph.json`(结构层,图指纹覆盖)· `plan/{plan.json, units/NN-*.md, contracts/NN-*.json, units/00-app-scaffold.md}` · `ledger.json`(运行态,不进指纹)· `verify-report.json`(全量)· `verify/units/<unitId>.json`(单元级)。

## 不做什么(明确边界)

- **不碰工具链**:不调 hvigor/DevEco、不编译目标工程(编译由外部 agent 自跑)。
- **不执行任何测试**:L4 只交付移植义务清单,`verify:'agent'` 恒 info 不计 fail。
- **不验证行为等价/类型正确/框架结构**:契约只覆盖迁移不变量,类型语法交给目标编译器。
- **advisory 永不判 fail**:state 检查、无 marker 能力均 info。
- **台账是 agent 声明**:targetPaths 不存在 → warning + 降级不报错;exportMap 不验目标真有该导出(那是 T3 的活)。
- **L3 contains-scan 诚实边界**:注释字面量会误命中;权限名不做 android↔ohos 逐字校验;SQL 只做空白归一后包含比对 —— 全部经 `depth` 字段明示。
- **重 pack 使 merged/split 单元 ledger 键失效**是接受边界(模块 1:1 单元 id 稳定不受影响),`ledger show` 显式列 orphan。

## 新增依赖

`graphology`、`graphology-communities-louvain`、`graphology-utils`(M2 图算法);`arkanalyzer` 为 optionalDependency(验收符号级解析,不可用时正则回退)。
