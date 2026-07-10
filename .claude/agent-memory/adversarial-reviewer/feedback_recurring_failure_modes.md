---
name: recurring-failure-modes
description: AppGraph 迁移层评审中反复出现的缺陷模式——启发式护栏、行为变更测试、"仅供测试"导出
metadata:
  type: feedback
---

审查 AppGraph（src/appgraph + src/migration）改动时反复命中的失败模式，优先针对性检查：

1. **护栏/启发式的代码条件比其文档意图更宽 → 对已充分覆盖的输入误报。**
   - **Why:** P0-3 `navCoverageWarnings`（src/appgraph/detect/semantics.ts）注释与单测都写"single-Activity app"，但代码判据是 `activityScreens > 0`（不是 `=== 1`），于是纯多 Activity / 纯代码构建 UI（无 res/layout、无 Compose、无 Fragment）的**完整**工程也会被打上"屏幕清单不完整、疑似第三方路由"的盲区告警。误报会顺 plan.coverageWarnings → scaffold 工单 → migrate_order 传到 agent。
   - **How to apply:** 见到"仅当满足 X 时告警/降级"的护栏，先把注释里的意图翻成最严格判据，再对照代码条件，构造"完整但触发"的反例。本仓库信条是"错误信号比没有信号更糟"，误报要按 Major 报。

2. **OR→AND 之类的判据收紧 / 阈值变更常无直接断言。**
   - **Why:** `buildCommunityOverlay` 的 `weak` 从 OR 改 AND（src/appgraph/community/index.ts:132）改变了置信度降级行为，但 build-parity.test 不断言 weak，p1-feature-resplit.test 只测 resplit 不测 overlay flag —— 行为变更零覆盖。
   - **How to apply:** 任何改判据/阈值/比较符的 diff，去 __tests__ grep 该输出字段（如 `weak`、`confidence`）有无断言;没有就报"验证缺口"。

3. **"Exported for testing" 的函数只在隔离环境测，无证据证明真实流水线会喂进触发输入 → 可能是死特性。**
   - **Why:** `resplitCrossModuleGrabBags`（src/appgraph/community/detect.ts）注释自认"第一趟 Louvain 永不产出可分裂的宽社区"，测试直接喂预制社区。没有任何测试/证据证明 M1→M2 真实图会产出 span>6 且 cohesion<0.15 的社区，P1-4 再拆可能从不触发。
   - **How to apply:** 看到 `export ... // for testing` + 注释解释"真实流程构造不出这个输入"，追问该分支在生产中是否可达;不可达即死代码/假特性。
