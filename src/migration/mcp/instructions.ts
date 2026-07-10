/**
 * Server instructions returned in the MCP `initialize` response — the first
 * (and often only) usage guidance the external migration agent sees. One page,
 * playbook-shaped: what each tool answers, in what order to use them, and what
 * to do when the analysis artifacts aren't generated yet.
 */

export const MIGRATE_SERVER_INSTRUCTIONS = `# migrate — Android→HarmonyOS 迁移分析查询

本服务把 appgraph 的迁移分析事实(迁移图 / 工单 / 验收报告)暴露给迁移 agent 在线查询。
所有事实都是确定性静态分析产物;本服务只读,不做任何翻译或修改。

## 迁移回路(每个单元)

**取工单 → ledger set(登记开始)→ 翻译 → ledger set migrated → verify --unit → 修缺口 → 下一单元**

1. **migrate_unit "0"**(或 "scaffold")— 先取应用装配工单:全局路由表、权限/深链(module.json5)、
   EntryAbility 入口。建立全局观后再逐单元迁移。
2. **migrate_order** — 自底向上的迁移单元顺序(叶子优先)。从第 1 个单元开始。
   多个迁移 agent 并行时改用 **migrate_ready**:它按并行波次列出「前置已全部完成、
   可立即开工」的单元;领取即登记 in-progress,完成登记 migrated 后再查即得下一批。
3. **migrate_unit** — 取一个单元的完整工单:台账状态 + 依赖去向/导出改名 + 验收契约摘要 +
   markdown 原文。参数 unit 可以是序号(如 "3")、单元 id、label 或成员模块名。
4. **migrate_module_facts** — 需要某个依赖模块的完整事实时查询(屏幕/导航、字段 schema、
   DI 装配、响应式流、后台组件、深链、能力→HarmonyOS 目标、公共接口基线、依赖)。
5. **migrate_ledger** — 查看/回顾各单元迁移状态(状态由 CLI \`migrate ledger set\` 写入)。
   迁移前后务必登记:开始时 \`--status in-progress\`,完成时 \`--status migrated --target-module <m>
   --target-path <前缀> --export <源名=目标名>\`。登记的 targetPath/exportMap 让 verify 精准定位与匹配改名。
6. **app_modules / app_screens / app_nav / app_features** — 应用总览:模块依赖图全景
   (角色/层/必要性/符号量/邻接,是 migrate_module_facts 的入口)、屏幕清单+跳转、
   navigates_to 页面图、功能簇。想从“产品/功能/模块”角度而非单个符号快速看懂这个 App 时用。
7. **migrate_label**(写入)— 图谱本身是确定性的、不含 LLM 猜测;若想补语义名/功能与迁移
   要点说明,可另起一个分析 Agent 读源码+工单,再用本工具把「语义名 + 说明(可多行)」回填到
   功能簇/单元。写入只做轻量校验(限长、target 必须命中真实对象),存于 sidecar 不进图谱指纹,
   仅在 app_features / migrate_order 展示。这是唯一的写入通道。
8. 迁移完一个单元后,在源工程运行 \`migrate verify <源> --target <目标工程> --unit <单元>\`(单元级)
   或不带 \`--unit\`(全量),然后用 **migrate_verify_gaps**(带 unit 参数看单元报告)查看缺口。
   单元缺口分三类:**unit-missing**(已登记迁移却缺失,真缺口,必修)、**dependency-missing**
   (依赖单元还没迁,先迁依赖)、**not-migrated**(本单元还没登记迁移,不是缺口)。

## 产物未生成时

工具会返回引导文本(不是错误):按提示在源工程运行
\`migrate index → modules → community → capabilities → semantics → order → plan\`
生成分析产物后重试。

源码级问题(符号定义、调用链、实现细节)不要问本服务 —— 用 codegraph MCP 的
\`codegraph_explore\`,或直接按工单里的文件锚点读源码。`;
