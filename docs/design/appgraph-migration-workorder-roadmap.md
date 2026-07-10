# AppGraph 迁移工单优化路线图(Android→HarmonyOS)

本文档是 `plan-agent-skill-agent-cli-skill-robust-sutherland.md` 的 **P0 交付物**：把六项目评审证据 + 分阶段计划固化到仓库里，防止散落在会话级 scratchpad 中丢失。后续 P1-P4 各阶段可跨会话按本文档接力推进。

项目缩写：K = koler、N = NewPipe、S = shadowsocks-android、C = CatchUp、A = nowinandroid（nia）、P = AntennaPod。

---

## 1. 背景与方法

六个真实 Android 项目（koler、NewPipe、shadowsocks-android、CatchUp、nowinandroid、AntennaPod）全量重跑 `migrate index → modules → community → capabilities → semantics → order → plan` 全流水线，产出各自的 `plan.json` + 单元工单（`.migration/plan/units/*.md`）。随后派出 **6 个并行评审 agent**，分别以「拿到这份工单去把该项目迁到 HarmonyOS 的执行者」视角逐份评审，输出 `report-{koler,newpipe,shadowsocks,catchup,nowinandroid,antennapod}.md`；再用 **3 个探索 agent** 把评审中点名的每一处代码锚点（file:line）与当前分支源码逐条核对，确保本文档引用的锚点真实有效。

评审运行时，本分支已经落地了 `93e3722`…`6fb16e4` 共 10 个 commit（P0 并行调度、P0-3 盲区自曝、P1-1～P1-6、审计闭环修复，见第 6 节），六份评审因此反映的是**这些改动落地之后**仍然存在的问题——不是过时快照。

**结论一句话**：工单在结构骨架上可信（依赖顺序/波次、能力→鸿蒙 API 映射、公共接口基线、Room 实体 schema、测试契约、coverageWarnings 诚实自曝盲区），但作为完整迁移输入，决定成败的 **UI 主干（屏幕/导航/布局/资源）系统性缺失**，叠加**抽取器栈敏感**（越偏离 Kotlin/Compose/Room 注解/Hilt/协程范式产出越空）与**一批确定性数据质量 bug**，导致所有带 UI、动态派发、非注解持久层、原生边界的单元仍须大量回源——而这恰是迁移里工作量最大、风险最高的部分。

---

## 2. 栈敏感性（元结论）

抽取器按现代 Kotlin 技术栈（Kotlin + Jetpack Compose + Room 注解 + Hilt + 协程）调优，质量随项目偏离该范式**单调下降**，六项目连成一条清晰的退化梯度：

| 项目 | 技术栈 | 抽取质量 |
|---|---|---|
| nowinandroid（nia） | 标准 Kotlin + Compose + Hilt + Room | 最好——模块角色、DI 接线、Room 字段 schema 全部达到可交付质量 |
| CatchUp | Kotlin，但 DI 用 Metro（非 Hilt）、导航用 Circuit、持久层用 SQLDelight | 明显退化——DI 标错（Metro 当 Hilt）、自动绑定（`@ContributesBinding` 等）全漏、导航图为空、`.sq` 未解析 |
| NewPipe / AntennaPod | Java + Fragment + RxJava + 手写 SQLite + 自定义 View + EventBus，基本无 DI 框架 | 严重退化——dataModels/customViews/constants/flows/diAssembly 五个槽位几乎全空 |
| shadowsocks-android | Kotlin 壳 + Rust/C 原生栈 + JNI + AIDL 跨进程 | 最差——vendored Rust 子模块淹没真实 app 代码（80% 符号来自子模块），真正的原生边界（C/JNI/AIDL/ProcessBuilder）反而不可见 |

**AntennaPod-Harmony 黄金对照坐实这一结论**：AntennaPod 有一份真实存在的鸿蒙移植工程可供对照。该工程里逐值复刻的枚举取值、自定义 View、model 字段，在源侧工单里**全部是空的**（`dataModels=0`、`customViews=0`、`constants` 只在 wearos 模块有 4 条、`flows` 只在 wearos 有 2 条）——也就是说，真实迁移里反复要回源补的，恰恰就是抽取器当前最薄弱的这几项。

---

## 3. 跨项目命中矩阵

### A. 结构性覆盖缺口（缺失的有用信息）

| 缺口 | 命中 | 说明 |
|---|---|---|
| UI 布局视图树缺失（只给布局文件名） | 6/6 KNSCAP | ArkUI 无 View 继承必须重写，输入（控件层级/id/约束/binding）全无。数据部分已在图里（Resource 节点）只差下发 |
| 导航图空/极稀疏 | 6/6 KNSCAP | 各用不同机制均未覆盖：Fragment 动态派发 `loadFragment(tag)`（K/P/N）、Circuit `@CircuitInject`+`navigator.goTo`（C）、Navigation3 `NavKey`+`entryProvider`（A）。多数静态可提取，非动态盲区 |
| 资源映射缺失（string/color/drawable/theme→resources） | 6/6 KNSCAP | Resource 节点在图里（koler 33/catchup 27/antennapod 92）但 0 份工单下发 |
| 异步/线程模型无 per-symbol 语义 | 6/6 KNSCAP | 只有能力级泛化；冷/热流、Dispatcher、`stateIn` 作用域、背压未标；RxJava 在 Java 项目被完全漏掉 |
| 三方库鸿蒙等价物缺失 | 5/6 NSCAP | NewPipeExtractor（132 文件零提及）、Apollo GraphQL、Firebase（需换 AGConnect）、ExoPlayer/Media3、Coil |
| 跨模块调用契约（方法级） | 5/6 KNSCA | 只给对方公共成员扁平名单，不给「实际调了哪些方法/签名/语义」 |
| 非 Room 持久层 schema 缺失 | 3/6 严重 KCP | koler（ContentResolver/Telecom 域模型只有裸类名）、catchup（SQLDelight `.sq` 未解析）、antennapod（手写 SQLiteOpenHelper `KEY_*` 常量） |

### B. 确定性/数据质量 bug

| bug | 命中 | 说明 |
|---|---|---|
| 拆分退化 | 6/6 KNSCAP | 按符号阈值切非真实接缝→线性瀑布（K 9 片/N 11/S 14，每片依赖前面全部，无并行无独立验收）；又对卡边巨石失效（A app#rest 7415 符号/222k 留一单元；C app-scaffold 2880 卡 3000 下没拆） |
| publicInterface 假阳性污染 L1 基线 | 6/6 KNSCAP | 匿名回调/local 函数/lambda override/预览函数被当「须同名导出」：`createFragment`（K）、`onMove`/`onSwiped`（S）、`lazyImageLoader.enqueue`（C）、`@DevicePreviews`（A） |
| 功能簇命名系统性错乱+低内聚 | 6/6 KNSCAP | 取跨模块泄漏/边缘符号：auth 簇叫「ProductHuntService」（C）、含 MediaType 的簇叫「PlaybackService」（P）、单元叫 ErrorInfo 实为 DB 实体（N）；内聚 0.05-0.29 |
| scaffold 后台组件表 ×N 重复 | 4/6 KNSP | N=split 数（K 9×/N 11×/S 14×/P 2×）；根因同下，聚合未去重 |
| 模块级事实灌进每个 split 单元逐字重复 | 3/6 严重 KNS | DI/flows/SQL/枚举/后台组件整模块复制进每片（N：单元 04 只 3 个 View 类也塞满 feed_group SQL；S：`172.19.0.1` 命中 14 份），真单元内容被淹没 |
| build.gradle.kts 符号当产品接口 | 4/6 NSCA | `CutChangelogTask`（C）、`NiaIssueRegistry`（A）、python 构建脚本（S）、`SharpStream`=build.gradle.kts（N） |
| Screen 节点混入 XML 布局项虚高计数 | 4/6 KNAP | koler 35→真实 ~16；antennapod 190 虚高；放大导航稀疏假象 |
| Service/VpnService 泛化误映射 | 3/6 KSN | 都映成 ServiceExtensionAbility/backgroundTaskManager，丢掉平台可行性关键区分（InCallService 默认拨号 K、VpnExtensionAbility S、AVSession N） |
| DI 框架标错+自动绑定漏 | 2/6+ NC | Koin（N）/Metro（C）都标「源侧 Hilt」；`@ContributesBinding`/`@ContributesTo`（C 81 处）、convention 插件注入依赖（S）未捕获 |
| merge/波次不尊重 necessity | 3/6 CAP | product 与 dev-only 混同单元；dev-only 叶子排 wave0 与「建议延后」冲突 |
| 文本/SQL/类型签名字符截断污染 L3 契约 | 1 确认（疑全局）A | Room SQL 止于 `ELSE` 丢 `ORDER BY publish_date DESC`；类型签名 `StateFlow<Set<NavKey>` 缺闭合 |
| 框架注入清单组件当 app 组件 | 1+ S | FirebaseInitProvider/MultiInstanceInvalidationService 当待迁组件还配了误导映射 |
| convention 插件注入依赖漏解析→波次倒挂 | 1 S | mobile/tv 判波次 0 但实际强依赖 core（约定插件注入），依赖方排被依赖方前 |

### C. 一致的强项（勿回归）

- 能力→HarmonyOS 目标 API 映射：6/6 一致好评，带语义差异提醒（notification `SlotLevel` 渠道级 vs `setPriority` 单条级）。
- 依赖波次/拓扑序：5/6 可靠（nia/antennapod/catchup 已核实；S 因约定插件依赖漏解析而倒挂）。
- Room `@Entity` 字段 schema：适用时最强（nia 7 表逐字段核对全对、shadowsocks Profile 21 字段、newpipe 实体）——可直接建 RDB 表。
- 公共接口验收基线 + ArkTS 嵌套类型提升/同名冲突提示：6/6 有用，ArkTS 专有洞察。
- 语义常量 L3（Kotlin 项目）：好；测试契约 L4 定位准确；`coverageWarnings` 诚实自曝盲区（多次被赞）。

---

## 4. 改进分工三区

判定原则：**确定性静态分析**（可单测、字节稳定、不依赖模型判断）进工具侧；**判断/研究/生成类**能力（可行性裁决、三方库选型、语义标注、代码翻译）落插件侧。

### A · 工具内（本仓 `/Users/legend/Desktop/Code/appgraph`）

现状分析 agent 的 CLI（`migrate` + `appgraph` 两个 bin）。第 3 节里几乎全部「结构性覆盖缺口」和「数据质量 bug」都属于此区——它们是抽取/聚合/渲染阶段的确定性缺陷或缺失特征，本身不需要判断，只需要把已经在图里的事实正确地下发、去重、切片。对应 P1（T1，数据质量）与 P3（T2，覆盖缺口）。

### B · 插件侧外部 agent-skill（`/Users/legend/Desktop/Code/migration/plugin`）

mobile-migration 插件，端到端执行侧。现有：`agents/{converter,reviewer}.md`；`skills/{using-mobile-migration(+references/mappings/android-to-harmonyos/{data,di,permissions}.md), scaffolding-harmony-app, migrating-unit, reviewing-unit, testing-with-hypium}`。判断/研究/生成类能力落这里，对应 P2（不依赖工具新输出的第一批 skill）与 P4（消费 T2 新事实的第二批）：

- **`annotating-units`**（语义标注）：迁移开工前批量 pass，为每个单元/Feature 写「功能 + 迁移要点」摘要，经 `migrate_label` 写回。
- **`adjudicating-feasibility`**（可行性裁决）：消费 scaffold 覆盖告警里的未映射权限、Service 类系统集成（InCallService/VpnService/QS Tile…），查证后产出三分裁决（可行 API 映射 / 降级方案 / 平台不可行）。koler Telecom 生死线即此类。
- **三方库选型 reference + skill 扩容**：`references/mappings/android-to-harmonyos/libraries.md`（移植/替代/桥接三分决策表）。
- **`using-mobile-migration` 流水线更新**：加入标注→裁决→scaffold→逐单元的完整顺序。

### C · 协作契约

- **11 个 migrate MCP 工具**（10 只读 + `migrate_label` 唯一写回）：`migrate_order`/`migrate_unit`/`migrate_module_facts`/`migrate_verify_gaps`/`migrate_ledger`/`migrate_ready`/`app_screens`/`app_nav`/`app_features`/`app_modules`（只读）+ `migrate_label`（写）。
- **`migrate_label` 写回**：display-only，落 `.migration/labels.json` 侧车文件，**不进图、不进指纹**，keyed by Feature 签名/单元 id；已支持多行 summary。插件侧的判断/标注结果通过它回传，工具侧图保持确定性不被非确定性内容污染。

---

## 5. 分阶段路线

### 5.1 阶段总览

| 阶段 | 仓库 | 内容 | 依赖 |
|---|---|---|---|
| P0 | appgraph | roadmap 设计文档落 `docs/design/`（全量 A/B/C 划分 + 六项目证据附录，防丢失）——**即本文档** | 无 |
| P1 | appgraph | 工具 T1：数据质量修复（10 项）+ 测试 + 六项目重跑验证 | 无 |
| P2 | plugin | 插件第一批：不依赖工具新输出的 skill（裁决/选型/语义标注）+ references 扩容 | 现有 MCP 即可 |
| P3 | appgraph | 工具 T2：覆盖缺口（布局/资源下发、导航合成、Java 范式、构建维度、能力细分、split 结构） | P1 |
| P4 | plugin+appgraph | 插件第二批：消费 T2 新事实（ArkUI 结构输入、路由表）；工具 T3 native 边界事实 | P3 |

### 5.2 P1 · 工具 T1：数据质量修复

| # | 问题（评审命中） | 锚点 | 修法 | 现状标注 |
|---|---|---|---|---|
| T1-1 | scaffold 后台组件/数据模型 ×N 重复（4/6） | `plan/scaffold.ts:55-57,65`（background/dataModels 用数组；appEntries 等已用 Set） | 按 (name,subtype,module) 去重 | 纯缺口 |
| T1-2 | split 单元整模块复制 DI/flows/constants/后台组件（3/6） | `plan/context.ts:269-278` + `plan/index.ts:153-158` | 有 file 锚点的事实按 fileFilter 切片；不可归属的折叠为一行「模块级共享」引用（仅首片/scaffold 全文） | 纯缺口——P1-3a（`974b94e`）的 Feature sections 只是把模块文件按簇分组展示，`6fb16e4` 的 whole-module manifest 只补了文件清单，均未按 fileFilter 收窄 DI/flows/SQL/后台组件事实本身，逐字重复原样保留 |
| T1-3 | publicInterface 假阳性污染 L1（6/6） | `plan/context.ts:337-360`（仅有 `name.startsWith('<')` 守卫） | 加顶层符号判定（复用 `appgraph/qualified-name` isNestedType/enclosing 信息）+ 排除 `@Preview`/`@DevicePreviews` | 部分已覆盖——B2（`93e3722`）已排除匿名类 `<X$anon@N>` 并统一/拓宽 `isTestPath`；但 nia 报告仍见 5 个 `@DevicePreviews` 进验收基线，顶层符号判定与 Preview 系列过滤尚未做 |
| T1-4 | 契约 kind 硬编码 'interface' | `plan/contract.ts:185,189` | 直通 `member.kind` | 纯缺口 |
| T1-5 | SQL/泛型截断污染 L3（nia ORDER BY 丢失） | `detect/constants.ts:44-46,86`（`MAX_SQL_LEN=500` slice）；`detect/flows.ts:31`（非嵌套泛型正则） | 截断则标 truncated 且该 L3 check 降 info；泛型平衡括号截取 | 纯缺口 |
| T1-6 | Screen 被布局名/private Composable 污染（4/6） | `detect/resources.ts:133`；`detect/compose.ts:105-119` | xml-layout 不入路由表/计数；Compose 过滤 private+`@Preview` | 纯缺口——P0-3 的 `coverageWarnings` 只是自曝稀疏/不准，未消除污染源头 |
| T1-7 | 簇命名跨模块泄漏（6/6） | `community/detect.ts:196-207 hubLabel` | cross-module 簇限 span 主模块内选 hub；weak grab-bag 不用 hub 名 | 部分已覆盖——P1-4（`b1b9c1c`）已对 span>6 模块/cohesion<0.15 的簇做 re-split + weak 标记（`app_features` 显示 ⚠低置信），但 hubLabel 算法本身（从跨模块邻居取标签）仍在产生错误簇名，核心修复未动 |
| T1-8 | 构建脚本符号进接口/簇（4/6） | 迁移层无过滤（.kts 全索引） | publicInterface/Feature 成员/簇 hub 三处排除构建文件 | 纯缺口——B4（`93e3722`）排除的是 test 源集，不含 `.kts` 构建脚本 |
| T1-9 | 枚举重复、「权重 0()」空噪声 | `detect/constants.ts`；`plan/brief.ts:433-439` | 取值集+file 去重；weight=0 不渲染 | 纯缺口 |
| T1-10 | merge 混装 product/dev-only、波次冲突（3/6） | `plan/unit-planning.ts:334,453,476-478` | 分箱键加 devOnly；dev-only 波次后置 | 部分已覆盖——P1-2（`a0c0910`）已加 `necessity` 分类 + 排序 tie-break（:476-478 product-first），但合并分箱键（:334 `effectiveDependents`）不含 devOnly，`mergeUnits`（:453）用 `every()` 判定 devOnly，故混装单元被判为 product、「建议延后」提示消失——nia 报告 unit2（designsystem+lint 混装）证实问题仍在 |

每项配 `__tests__/migration/` 回归用例（现有 30 个测试文件为模板；`plan-brief`/`scaffold`/`unit-planning` 等已有对应套件可扩）。

**P1 验证**：`npm test` 全绿 → `npm run build` → 六项目重跑 `migrate plan`，定向核对：koler scaffold 后台组件 9×→1、NewPipe 单元 04 不再携带整模块 SQL、nia SQL 完整含 ORDER BY、CatchUp unit21 无 CutChangelogTask、koler publicInterface 无 createFragment、簇名不再跨模块。

### 5.3 P2 · 插件第一批（不依赖工具新输出）

落 `/Users/legend/Desktop/Code/migration/plugin`，风格对齐现有 skill（中文、frontmatter name/description、工单/契约驱动）：

1. **新 skill `annotating-units`**（B4 语义标注）：迁移开工前的批量 pass——读源为每个单元/Feature 写「功能 + 迁移要点」多行 summary，经 `migrate_label`（或 `migrate label` CLI）写回，converter 消费合并视图。触发词：「标注单元 / 语义补充 / annotate」。
2. **新 skill `adjudicating-feasibility`**（B1 可行性裁决）：消费 scaffold 覆盖告警里的未映射权限、Service 类系统集成（InCallService/VpnService/QS Tile…），用 `harmonyos-docs-lookup`/`harmonyos-sdk-api-lookup` 查证，产出三分裁决（可行 API 映射 / 降级方案 / 平台不可行）写入 `references/permissions.md` 增补 + `migrate_label`。koler Telecom 生死线即此类。
3. **新 reference + skill 扩容**（B2 三方库选型）：`references/mappings/android-to-harmonyos/libraries.md`（移植/替代/桥接三分决策表，首批收录六项目实证：NewPipeExtractor、ExoPlayer/Media3→AVPlayer+AVSession、Firebase→AGConnect、OkHttp/Retrofit→rcp、Coil/Glide→Image、RxJava→emitter/TaskPool 模式）；`migrating-unit`/`reviewing-unit` SKILL.md 加引用。
4. **`using-mobile-migration` SKILL.md**：流水线加入上述两个新阶段（标注→裁决→scaffold→逐单元）。

**P2 验证**：用 AntennaPod 现有 plan 做 dry-run——对 2 个单元跑 `annotating-units`（labels.json 落盘、`migrate_unit` 显示合并标注）；对 koler scaffold 的 10 条未映射权限跑 `adjudicating-feasibility`（逐条有裁决与依据）。

### 5.4 P3 · 工具 T2：覆盖缺口（确定性）

按性价比排序（细节锚点见上，此处摘要）：

1. **布局树+资源下发**（成本最低，6/6）——控件树已解析未消费（`detect/resources.ts:135` → `attrs.controls` 丢弃于 brief 层）：补 `ScreenBrief.controls`、`ModuleBrief.resources`、drawable 类；新增 MCP `app_resources`。**纯缺口**。

2. **导航合成扩展**：
   - Fragment 字符串 tag/工厂派发合成器（AntennaPod/koler 模式，挂 `resolution/android-synthesizer.ts` 旁）——**P1-1（`bff1405`，seam-3d）已覆盖 INLINE 形式**（`.replace/.add(container, MyFragment())`、reified KTX、`MyDialog().show(fm, tag)`），但该 commit 明确声明「cross-statement variable forms dropped — silent beats wrong」；`loadFragment(tag)` 式运行时字符串/工厂派发（AntennaPod 190 屏仅 3 边的主因）仍是缺口，是 P1-1 的**直接延续**而非重复实现。
   - Circuit 从盲区指纹升级 resolver（`@CircuitInject`+`goTo`，静态可提取）——**P0-3（`c214b90`）只做了 import 前缀指纹 + coverageWarning**（"Circuit detected, screen/nav coverage incomplete"），未解析 `@CircuitInject` 注解与 `navigator.goTo` 调用生成真实 route 节点/边，仍是缺口。
   - seam-2 补路由参数/startDestination/顶层 Tab——纯缺口（seam-2/`compose.ts` 现只产出 route→composable 引用边，无参数/起始目的地/Tab 语义）。
   - 深链补 host/path——纯缺口（多份报告标注「深链只到 scheme 级」）。

3. **Java/非注解范式**（治栈敏感）：
   - constants 加 static final——纯缺口。
   - customViews 去 Kotlin-only 门禁（`plan/index.ts:499`）——**P1-6（`ae08b7b`）刚交付的 `isAndroidViewSuper` 检测本身按 Kotlin header 解析**（`superTypes` 只认 Kotlin 语法，`node.language !== 'kotlin'` 直接 `continue`），对 AntennaPod 这类 Java 自定义 View（`PieChartView`/`CircularProgressBar`/`VideoPlayerControlsView`）门禁关闭——是 P1-6 落地后立刻暴露的**下一步**，而非另起炉灶。
   - entities 扩 Moshi/`@JsonClass`、Java POJO、手写 SQLite（KEY_*+CREATE TABLE）、SQLDelight `.sq`——纯缺口。
   - EventBus 拓扑与 RxJava 流——纯缺口。
   - DI 按 import 判框架名（勿硬编码 Hilt）+ Contributes 绑定 + `@Provides` 表达式体降级——纯缺口（与 P1-2 的 necessity 分类是两回事，不重叠）。

4. **构建维度**：
   - convention 插件注入依赖（最小修复=隐式耦合方向 sanity-check 出告警）——纯缺口（shadowsocks 波次倒挂由此产生；B5/`93e3722` 只重算了 topo order，未解析约定插件注入依赖本身）。
   - flavor 解析（消除 DI 矛盾绑定）——纯缺口。
   - vendored 子模块排除（`.gitmodules`→`codegraph.json` exclude）——**机制已有 `project-config.ts`**（支持 exclude），缺的是「从 `.gitmodules` 自动生成排除规则」这一层，不是从零实现。

5. **能力细分**：
   - COMPONENT_TARGETS 按组件超类细分（VpnService/InCallService/MediaSession）——纯缺口。
   - concurrency.async 按证据分派协程/RxJava 文案——纯缺口。
   - 权限表补评审点名项——纯缺口。
   - 未映射项输出「需外部裁决」槽位——纯缺口，且是 P2 `adjudicating-feasibility` skill 的直接输入契约（对接点）。

6. **split/merge 结构**：
   - split 兄弟依赖改用真实 Feature 边（替换 `unit-planning.ts:198-202` 线性链）——**`orderFeatures` 函数已存在**并用于同模块内 sub-unit 排序（`unit-planning.ts:533/573`），但跨 slice 的 wave/`dependsOnUnitIds` 计算（:185-206 `splitSiblings` 分支）对同模块 split 兄弟一律追加「依赖全部更早 slice」的线性边，未复用 Feature 依赖边——复用现有计算结果即可解除线性瀑布，是**收尾**而非新建。
   - rest 超阈值按包目录二次切分——纯缺口。

**P3 验证**：同 P1 的六项目重跑 + 定向指标：koler/AntennaPod 导航边 3→数十、CatchUp 屏幕 2→12+、shadowsocks 符号 14388→~3000（vendored 排除）、AntennaPod dataModels/customViews 非空。

### 5.5 P4 · 消费闭环

- 插件：`migrating-unit`/`scaffolding-harmony-app` 消费新 brief 节（控件树→ArkUI 组件方案、完整路由表→AppRoutes 骨架）；`references/mappings/android-to-harmonyos/ui.md`（View/Compose→ArkUI 模式表）。
- 工具 T3：native 边界事实（ProcessBuilder/System.loadLibrary/.aidl/externalNativeBuild 检测→brief 节），迁移路径裁决交 P2 `adjudicating-feasibility` skill 扩展。

**Verification 总则**：工具侧每项改动先写失败用例再修，`npm test`，六项目重跑验证，brief 字节稳定性（两遍 plan 哈希一致）不回归；插件侧 skill 按现有风格（≤100 行、工单/契约驱动、引用 references），各阶段有 dry-run；CHANGELOG 按 house rules 记 `[Unreleased]`。

---

## 6. 与分支已有工作的边界

`git log --oneline main..HEAD` 当前 10 个 commit（均在评审运行前已落地，评审反映的是这之后的残留状态）：

| commit | 归组 | 内容 |
|---|---|---|
| `93e3722` | 导航合成与去噪（B1-B5） | nav 召回修复（`\bnavigate` 宽正则、entry-sibling 归因、有界调用者 BFS、import 链 fallback）+ anti-silence coverageWarnings；B2 匿名类过滤 + `isTestPath` 统一拓宽；B3 gradle 依赖 scope 标注排除测试期依赖；B4 社区投影/上卷只走 shipped code + reverse-suspect 标注；B5 `migrate sync` 重算拓扑序 |
| `c214b90` | P0 并行调度 + 声明式导航覆盖 | P0-1 Kahn frontier 波次持久化（`MigrationUnit.wave`/`dependsOn`）+ `migrate_ready`；P0-2 `nav_graph.xml`（S3）解析器；P0-3 导航框架指纹（S4：Circuit/Conductor/Cicerone/Voyager/Compose Destinations import 前缀匹配）→ coverageWarning |
| `a0c0910` | P1-2 dev-only 分类 | `classifyModule` 识别 benchmark/test-support/lint 角色，`attrs.necessity='dev-only'`；两处排序（`topo.ts`/`unit-planning.ts`）product-first tie-break；brief/`migrate_order` 标注 `[开发支撑]` |
| `b1b9c1c` | P1-4 Feature 重切分 | 跨 >6 模块且 cohesion<0.15 的社区做第三轮 re-split（只在能真正拆出 >1 部分时生效）；无法拆分的标 `attrs.weak` + 置信降级，`app_features` 显示 ⚠低置信 |
| `974b94e` | P1-3a Feature sections + 规模估算 + 合并亲和 | brief 按 M2 subdivision/跨模块 Feature 对模块文件分组（对齐簇跳过）；`estimatedTokens`（symbolCount × 系数）；bin-packing 时共享主导 Feature 签名的小模块相邻排序 |
| `ae08b7b` | P1-6 app_modules + customViews（Kotlin-only） | `app_modules` MCP（模块依赖总览，bottom-up）；`isAndroidViewSuper` + `detectCustomViews`（仅按 Kotlin header 解析 `superTypes`），brief 新增「自定义 View [静态]」节 |
| `90ab766` | P1-5 ledger 重打包对账 | `computeLedgerRemap`/`applyLedgerRemap`（成员+featureSig 精确匹配优先，其次最大模块重叠）；`migrate plan` 自动侦测孤儿并写 `ledger-remap.json`；新 CLI `migrate ledger remap [--apply]` |
| `0057eac` | P1-3b `migrate_label` 写回 | `.migration/labels.json` 侧车（不进图/不进指纹）；`migrate_label`（10→11 工具，唯一写工具）解析目标为真实 Feature/单元后校验写入；`app_features`/`migrate_order` 渲染 `〔AI:…〕` |
| `bff1405` | P1-1 Fragment/Dialog 导航合成（seam 3d） | `android-synthesizer.ts` 新增 `android-fragment` 族，仅覆盖 INLINE 形式；`navigates-from-core.ts` 以 conf 0.8 提升为 Screen→Screen `navigates_to` |
| `6fb16e4` | 审计闭环修复 | P0-3 `navFrameworks` 顶层字段 + app-scaffold「已知盲区」节；P1-3a merged/split 工单补整模块文件清单；P1-6 `app_modules` 真正 bottom-up 排序（原按字母序）；P1-4 抽出 `resplitCrossModuleGrabBags`/`isWeakGrabBag`、修复 false-green 测试、weak 标记窗口 OR→AND；`modules` 命令重建结构层时保留翻译 overlay，消除 orphan 累积 |

**本 roadmap（P1 T1 十项 + P3 T2 六大类）与上述 10 个 commit 无重复**：T1/T2 每一项要么是全新的确定性缺陷/缺口，要么是这些 commit 明确划定边界后留下的下一步（已在 5.2/5.4 节逐项标注「已覆盖 vs 缺口」，四处存在直接承接关系的是 T1-10↔P1-2、T1-7↔P1-4、T2-2↔P1-1/P0-3、T2-3↔P1-6、T2-6↔`orderFeatures`）。规划与开发前先 `git status`/`git log` 核对，避免与在途会话的并发改动（`labels.ts`/`cli.ts`/`mcp/tools.ts`/`instructions.ts` 四个多行 label 相关文件尤其要小步提交）冲突。

---

## 7. 附录 · 六项目评审精要

### koler（12 单元，Kotlin + Hilt + Telecom）

确定性事实抽取强（语义常量/能力→API 构造映射/公共接口+ArkTS 嵌套&同名冲突/L1-L4 契约），但作迁移输入不充分。三大结构缺口：① UI/资源层缺席（20 个 layout XML 全无；33 个 Resource 节点在图里却未下发到 screen/unit）；② Telecom/InCallService/默认拨号可行性未裁决（koler 生死线，被轻描淡写映射成 ServiceExtensionAbility/backgroundTaskManager，误导；`ANSWER_PHONE_CALLS`/`BIND_INCALL_SERVICE`/`MANAGE_OWN_CALLS` 未归一化为 capability）；③ split 把内聚模块（`:chooloolib` 3429 符号）按符号阈值碎成 9 片线性链（内聚 0.11 极低），且模块级事实 9× 逐字复制。数据质量 bug：scaffold 后台组件 9× 重复、DI/flows 9 单元逐字重复、publicInterface 混入 `createFragment`/`getItemCount`/`onPageSelected` 等局部函数假阳性、Screen 节点被 35 个里 ~19 个布局名污染、语义常量枚举重复、隐式耦合权重 0 空噪声、跨模块依赖裸名重复且截断。数据模型：全 11 单元 `dataModels=[]`（koler 零 `@Entity`）。缺失信息排序：UI 布局树 > 资源映射 > 原生能力可行性裁决 > 数据模型字段 schema > 异步/线程 per-symbol 清单 > 跨模块方法级契约 > 导航扇出 > gradle 构建配置。

### NewPipe（14 单元，Java/Kotlin + RxJava + ExoPlayer）

结构为 3 个 Gradle 模块（非 5）：`:shared`（KMP+Compose+Koin 新重写，干净小）/ `:app`（传统 Java+Fragment+RxJava3+ExoPlayer+Room 手动 DI，15390 符号，全部复杂度）/ `:desktopApp`（与鸿蒙迁移无关的噪声）。`:app` 被 split 成 11 单元=严格线性链无并行度，大簇内聚全线 0.05-0.11，命名误导（单元 02 叫「ErrorInfo」实为核心 DB 实体+基础类+列表页）。核心子系统被撕裂：播放器一半在单元 03 一半在单元 12rest；持久层实体散在 02/05/11；`Migrations.kt` 在 12。数据模型完备性最佳（全字段+列名+PK 直接建 RDB），语义常量/公共接口齐全，但屏幕+导航部分（168 Screen 节点仅 12 条 `navigates_to` 边，`navFrameworks=[]`）；DI 不准（`:shared` 标 Hilt 实为 Koin）；响应式数据流缺失为主（完全漏掉主导 `:app` 的 RxJava3——76 文件用 rxjava3 一个没提）；UI 布局缺失最严重（`fragment_video_detail.xml` 707 行只给名）。数据质量 bug：后台组件总表 ×11 重复（88 行）、模块级事实一字不差灌进全部 11 个 split 单元、响应式数据流张冠李戴、Koin 标成 Hilt、契约对 Android View 基建类强加同名导出假需求且 class 标 `kind:interface`。缺失信息排序：UI 布局视图树 > 三方核心库等价物（NewPipeExtractor 132 文件零提及）> RxJava 映射矩阵 > 媒体状态机+AVSession > 资源映射规则 > 每单元事实定位 > 跨单元契约 > 业务逻辑语义。

### shadowsocks-android（18 单元，Kotlin + Rust/JNI + VPN）

4 模块 `:mobile`(1059)/`:tv`(134)/`:plugin`(170)/`:core`(声称 12995)。**头号 bug**：vendored Rust 子模块（shadowsocks-rust）被当 app 代码索引——14388 符号里 Rust 11509（80%）来自子模块，真实 app Kotlin 仅 2777；`.gitmodules` 明标 vendored 却未排除，撑爆 3 单元并生成伪特征。剔除 Rust 后 core 真实 Kotlin 仅 1414 符号，根本不需切 14 片。**原生边界双向失真**：该采的没采（badvpn/redsocks/libevent C 源 0 符号；`aidl/*.aidl` 0 符号），不该采的 Rust 全采了。**波次方向 bug**：mobile/tv 判为波次 0，实际强依赖 `:core`（隐式耦合权重 305），根因是依赖由约定插件（`buildSrc/Helpers.kt:101 setupApp()`）注入，规划器只解析字面 dependencies 块。划分：`:core` 切 14 片=严格线性瀑布，`12-coredatastore`（Profile/Room 数据层）应最先却排到波次 9；05/10 都叫 `:core#config`、08/09 都叫 `:core#context` 标签碰撞。完备性：数据模型准确但缺字段默认值；导航缺失（41 屏导航图空自曝）；后台组件部分且不准（VpnService 误映为普通 ServiceExtensionAbility，还混入 Firebase/Room 框架注入项）；公共接口含噪声（匿名回调污染 86 项基线）；DI 缺失（object 单例手工装配未 surface）。缺失信息排序：原生库 JNI→NAPI 迁移信息（最关键）> UI 布局+资源映射 > 导航图 > VpnService→VpnExtensionAbility+网络栈 > 异步线程与进程模型 > 跨模块调用契约 > 三方库鸿蒙等价物 > gradle 构建配置。

### CatchUp（22 单元，Kotlin + Metro + Circuit + SQLDelight）

35 模块，schemaVersion 4，波次 6 层拓扑正确无环（最扎实部分），`merged=14/split=0`。`navFrameworks=["Circuit"]`+coverageWarnings 自陈 Circuit 屏幕识别与 `navigates_to` 提升不覆盖，图里 `navigates_to` 边=0。划分问题：merge 产出「大杂烩单元」（unit08 把 `:libraries:auth` 网络鉴权与 `:bookmarks:db` 仅 build.gradle.kts 并箱；unit21 把真实 `:app` 与 4 个纯构建工具+dev-only `:benchmark` 装一箱）；split=0 是最大粒度问题——核心 UI 单元 `:app-scaffold`（unit20）=2880 符号/74 文件/86k tokens 巨石，刚好卡 3000 阈值下没拆，含全 app 63 composable+12+ Circuit 屏幕，不可作单工单执行。屏幕+导航缺失/严重不准：unit20 自报 composable-ui×63 但屏幕节只列 2 个（真首屏 HomeScreen 未识别，唯一命中的是 debug 工具 BugReportDialog），源码实测 12+ Circuit Screen；导航图完全空（源码 8 处 `navigator.goTo` 静态跳转未提，静态可提取非动态盲区）。持久化 SQLDelight schema 缺失致命：`service.sq` 定义 30+ 列，unit07 `:service-db` 文件清单只有 build.gradle.kts、CREATE TABLE 全无。DI（Metro 非 Hilt）部分且不准：8 份工单 DI 头写「源侧 Hilt」，`@ContributesBinding`×24/`@ContributesTo`×55/`@ContributesMultibinding`×2 一条没捕获，`@Provides` 被解析污染（函数体文本当提供类型）。缺失信息排序：Circuit 屏幕清单+跳转图（`@CircuitInject` 26 处+`navigator.goTo` 8 处静态可提取）> SQLDelight 表结构 > 全量数据模型字段 schema（非仅 `@Serializable`）> Metro/Anvil 自动 DI 绑定图 > Compose UI 树 > 资源映射 > 异步冷热流区分 > 三方库等价物 > 跨模块调用契约。

### nowinandroid / nia（27 单元，标准 Kotlin + Compose + Hilt + Room）——最干净的教科书样本

26 单元+scaffold，35 模块归入 26，模块角色识别准确（core/feature api-impl 分层/library/app/dev-only 三元分类正确），波次 6 层无环，依赖顺序高度可信，`merged=9/split=0`（最大模块 designsystem 942 符号 < 3000）。划分问题：merge 未考虑 necessity——unit2 = `:core:designsystem`（product 942 符号）+ `:lint`（dev-only）且不带「建议延后」提示，dev-only 属性被藏没（对应 T1-10 未尽事宜）；dev-only 独立单元时处理到位（unit7 benchmarks 明写建议延后），但波次纯拓扑，dev-only 叶子因无依赖排到 wave0 与「建议延后」冲突。完备性：Room 字段 schema 齐全准（7 张表逐字段核对全对）；DI（Hilt）齐全准（8 条 `@Binds` 接口→实现+每个注入点构造依赖）；能力→API 齐全可用；语义常量部分（枚举全，但 Room SQL 被截断★）；公共接口部分含噪声（`@DevicePreviews` 预览函数当验收基线）；**屏幕+导航缺失/不准（最大短板）**：`navFrameworks=[]` 未识别 Navigation3（用 `navigation3.runtime.NavKey`/`EntryProvider`），全 App 仅 6 条 L2 导航边 0 参数；数据流部分（无线程/操作符语义，类型签名截断 `StateFlow<Set<NavKey>` 缺尾）。**★严重数据质量 bug**：Room SQL 被截断且污染契约——`getNewsResources`/`getNewsResourceIds` 的 SQL 在 brief 与 contract 都止于 `ELSE`，丢掉「`1 END ORDER BY publish_date DESC`」；DI `@Binds` 跨 flavor 拍平→重复+矛盾（`SyncSubscriber` 同时列 prod/demo 两个互斥实现，无 flavor 标注）；假屏幕 `InterestsEmptyScreen`（private 子 Composable 靠名后缀误判）；预览函数当公共接口；功能簇命名噪声。缺失信息排序：导航图（头号缺口）> 构建配置/convention 插件/flavor > Compose UI 树/布局结构 > 资源映射 > 异步线程模型 per-symbol > 三方库具体等价物 > 跨模块调用契约 > 业务逻辑语义。注：此项目 DI、模块角色分类正确——印证越标准的 Kotlin 栈工具表现越好。

### AntennaPod（35 单元+scaffold，Java + Fragment + 手写 SQLite + 自定义 View + EventBus + RxJava，无 DI 框架）——有真实鸿蒙目标 AntennaPod-Harmony 黄金对照

37 模块，波次 0-8 无环拓扑合理（真实目标正是按此底层优先），`merged=3/split=1`，全 38 模块标 product 无 dev-only 区分。**★元结论黄金对照坐实**：dataModels/customViews/constants/flows/diAssembly 五个槽位全 35 单元几乎全空——恰是传统 Java+媒体迁鸿蒙最吃紧的信息，真实目标工程反复要回源补的正是这些。拆分退化最严重：`:app` 只切走 ReorderDialog（142 符号），其余 7415 符号/222k tokens 全留 `#34`（阈值 3000 的 2.5 倍，822 行 brief，49 屏+203 公共成员，不可作一份工单）。完备性：公共接口齐全（656 成员+锚点）；测试契约齐全；能力→API 齐全但有 Kotlin/RxJava 错配；屏幕部分（190 Screen 有 file/layouts 但只给布局文件名无视图树，XML 布局项与 Fragment 混计虚高）；**导航缺失**（190 屏仅 3 条 `navigates_to`，全靠 `MainActivity.loadFragment(tag)` 字符串动态派发未覆盖）；数据模型缺失（`dataModels=0` 全 35 单元）；自定义 View 缺失（`customViews=0`，源码实有 ~10 个 `PieChartView`/`CircularProgressBar`/`VideoPlayerControlsView`）；语义常量缺失（`constants=4` 全在 wearos）；响应式数据流缺失（`flows=2` 全在 wearos，源码 43 个 `@Subscribe`+157 处 `EventBus.post`+79 RxJava 文件）；DI 缺失（手工装配 `ClientConfig` 也未捕获）；权限归因近乎失效（`Permission=11` 但 `requires_permission` 边仅 1 条且指向坏的 `BIND_QUICK_SETTINGS_TILE`）。数据质量 bug：功能簇标签系统性错误（取自图邻居非簇内容）；`concurrency.async` 能力映射与证据自相矛盾（正文写协程/Flow，证据却列 RxJava）；屏幕计数混淆；scaffold 后台组件表重复；`FOREGROUND_SERVICE_MEDIA_PLAYBACK`（播客前台播放最关键权限）未归一化。缺失信息排序（结合真实目标）：Fragment 导航图 > 数据模型字段 schema+RDB 建表 > 枚举/常量取值 L3 > 自定义 View 视图树/绘制逻辑 > XML 布局→ArkUI 视图树 > 响应式/事件流拓扑 > 媒体/下载状态机 > 三方库等价物+RxJava 异步模型。
