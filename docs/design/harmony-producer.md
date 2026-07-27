# HarmonyOS 生产者设计与实测

针对鸿蒙（HarmonyOS Stage 模型 / ArkTS）工程的应用语义图能力。设计基线来自
`agc-template-market-harmonyos-demos` 语料：**76 个真实工程、1,146 个模块、19,965 个
`.ets`（约 163 万行）**。

---

## 1. 为什么鸿蒙不能照搬 Android 的抽取路径

结构定义（`AppNode`/`AppEdge`/9 种 NodeKind/8 种 EdgeKind/matchKey 族/能力词表）**完全复用**
——鸿蒙的 `ohos.permission.CAMERA` 和 Android 的 `android.permission.CAMERA` 归一到同一个
`capability:camera`，跨平台 diff 直接对齐。真正不同的只有事实**来源**：

| 事实 | Android | HarmonyOS |
|---|---|---|
| 模块清单 | `settings.gradle` 的 `include` | 根 `build-profile.json5` 的 `modules[].srcPath` |
| 模块依赖 | `implementation project(':x')` | 模块 `oh-package.json5` 的 `"x": "file:../x"` |
| 应用清单 | 一份 `AndroidManifest.xml` | **每模块一份** `src/main/module.json5` |
| 启动入口 | `<intent-filter>` MAIN/LAUNCHER | `mainElement` / `entity.system.home` |
| 后台组件 | `<service>`/`<receiver>` | `extensionAbilities[type=form\|backup\|…]` |
| 深链 | `<data android:scheme>` | `skills[].uris[]` + `domainVerify` |
| 导航图 | `res/navigation/nav_graph.xml`（集中） | `route_map.json`（**每模块分布式**，1,146 模块中 478 个声明） |
| 页面 | `@Composable fun XxxScreen` / Fragment | `@Entry struct` ∪ `build()` 根为 `NavDestination` 的 struct ∪ 路由注册项 |
| 数据模型 | Room `@Entity` / SQLDelight | `@ObservedV2` class + `AppStorageV2/PersistenceV2.connect` |

因此平台差异收敛到 `src/appgraph/platforms/PlatformProducer` 的 4 个缝（模块骨架 /
import→capability / 清单能力 / 语义编排），其余管线原样复用。

---

## 2. 四个非显然的坑（都有实测代价）

### 2.1 工程根必须认 `AppScope/`，不能认 `build-profile.json5`

5 个工程有 `ohpm_custom_dependency/` 依赖镜像目录，它带完整的 `build-profile.json5` +
`oh-package.json5` 但没有 `AppScope/`。以 build 文件判定工程根会把镜像模块重复计数
（WebShortDrama 32 模块 → 64）。

同理必须排除 `src/ohosTest/module.json5`（全语料 976 个，全是 `type:"feature"` 的测试模块），
否则模块数直接翻倍。

### 2.2 JSON5 不是 JSON —— 而且失败是**静默**的

5,041 个 `.json5` 中 **40.2% 无法用 `JSON.parse` 解析**（`build-profile.json5` 达 93%）。
`jsonc-parser` 能覆盖注释 + 尾逗号，把失败率降到 3.5%，但剩下的 100% 是单引号字符串和
无引号 key，且**恰好集中在 `oh-package.json5` 的 dependencies 块**——模块依赖边的唯一来源。

更关键的是失败形态：`src/resolution/workspace-packages.ts:184` 调
`jsonc-parser.parse()` 时不传 errors 数组，于是无引号 key 的文件**返回一个看起来正常的空
`dependencies`**，102 个模块的依赖静默消失。这正是 CLAUDE.md 的 anti-silence 反例。

处置：引入 `json5` 依赖覆盖完整语法，外面包一层 `extractors/harmony/json5.ts` 保证
**issues 非空的结果绝不冒充完整**，并顺手修掉上游那处静默丢弃。

### 2.3 路由名 ≠ 文件名 ≠ struct 名，且文件名不固定

```json
{ "name": "OrderDetail",
  "pageSourceFile": "src/main/ets/views/OrderDetailPage.ets",
  "buildFunction": "buildOrderDetailPage" }
```

三个名字全不同，没有任何命名约定能推导——只有注册表能连。而注册表**文件名本身也不统一**：
`route_map.json`(364) / `router_map.json`(105) / `route_map_mine.json` / `home_route_map.json` /
`router_map_report.json` … 十余种。所以文件名必须从 `module.json5` 的 `routerMap: "$profile:x"`
字段反查，硬编码会静默丢掉整个工程的导航。

路由名是**全局命名空间**（`pushPathByName` 不带模块前缀），所以注册表是全工程合并的；
跨模块重名**两条都丢弃**（调用点无法判定目标，取先者会让所有调用者跳错页）。

### 2.4 ArkTS 内建方法会被吸进 `RouterModule` 单例

每个鸿蒙工程都自建一个 `RouterModule` 导航单例，带静态
`push`/`pop`/`replace`/`clear`。而 `name-matcher.ts` 的 Strategy 3 在"全库只有一个同名方法"时
无条件解析——于是 `this.expressions.push(x)` 这种普通数组操作全部连到
`RouterModule.push`。

Calculator 实测：`module_standard_calculator → lib_foundation` 的 63 条跨模块边，**63 条
全是这个**，进而制造出一条"强隐式耦合但未声明依赖"的假警告，并污染 Louvain Feature 聚类。

修复是 `name-matcher.ts` 的 ArkTS 内建方法守卫（要求 receiver 有类型证据），沿用该文件已有的
precise-or-drop 惯例。真实静态调用 `RouterModule.push(...)` 由 Strategy 1 处理，不受影响
（实测修复后 63 → 0，真实调用方 19 条入边全保留）。

---

## 3. 导航合成（`harmony-nav`）

鸿蒙导航是字符串键的，静态图在每次跳转处断链：

| API | 语料出现次数 |
|---|---:|
| `NavPathStack` | 2,781 |
| `NavDestination` | 2,693 |
| `pushPath` | 1,713 |
| `pushPathByName` | 1,401 |
| `windowStage.loadContent` | 82 |
| **`router.pushUrl`（legacy，现有 `arkui-route` 族覆盖的）** | **19** |

即现有 `arkui-route` 族覆盖约 1% 的真实导航。`harmony-nav` 按三跳解析：

```
调用点 pushPathByName(RouterMap.ORDER_DETAIL)
  → 枚举回溯  RouterMap.ORDER_DETAIL = 'OrderDetail'
  → 注册表    'OrderDetail' → features/order/.../OrderDetailPage.ets + buildOrderDetailPage
  → 图锚定    @Builder buildOrderDetailPage() { OrderDetailPage() } → struct 节点
```

**枚举回溯是必需的**：实测 `pushPathByName`/`replacePathByName` 的实参
**字面量 675 : 非字面量 1,144**，非字面量的大头正是 `RouterMap.X` / `PageName.X` 这类字符串值
枚举成员。

**精度由注册表白名单保证**：动词匹配放宽无妨，但路由名必须命中注册表才产边。
`info.url`(67) / `name`(59) / `v.routerName`(28) / `page.pageName`(22) 这类运行期名字零产边。

`arkui-route` 保留不动：两套解析模型正交（*url 路径→文件* vs *路由名→注册表→文件*），
合并会让一个函数背两套无关策略。

---

## 4. 十工程实测（`scripts/appgraph-eval/harmony-probe.mjs`）

探针的真值由**独立于产品代码的实现**（裸正则/glob）计算——复用产品解析器会让探针与产品同错同对。

| Project | mods | ets | det | modRec | depRec | permRec | routeReg | routeScr | routeIn | screens | nav | data | caps | json5 | warns | secs |
|---|---:|---:|:---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| ComprehensiveTool | 44 | 1075 | ✓ | 44/44 | 56/56 | 19/19 | 121/121 | 0.992 | 0.446 | 124 | 68 | 29 | 23 | 0 | 72 | 13 |
| ComprehensiveNews | 39 | 873 | ✓ | 39/39 | 139/139 | 9/9 | 61/61 | 1 | 0.279 | 70 | 36 | 28 | 17 | 0 | 43 | 5.6 |
| ComprehensiveMall | 32 | 570 | ✓ | 32/32 | 80/80 | 9/9 | 54/54 | 0.963 | 0.389 | 57 | 40 | 18 | 14 | 0 | 35 | 3.9 |
| CarBeautyCare | 14 | 174 | ✓ | 14/14 | 38/38 | 3/3 | 22/22 | 1 | 0.409 | 26 | 12 | 2 | 8 | 0 | 13 | 1 |
| ArtTraining | 12 | 201 | ✓ | 12/12 | 29/29 | 5/5 | 20/20 | 1 | 0.55 | 25 | 21 | 4 | 8 | 0 | 12 | 1.3 |
| HomeDecoration | 12 | 158 | ✓ | 12/12 | 21/21 | 4/4 | 19/19 | 1 | 0.789 | 25 | 24 | 6 | 9 | 0 | 5 | 1 |
| Metro | 8 | 104 | ✓ | 8/8 | 19/19 | 3/3 | 16/16 | 1 | 0.25 | 17 | 6 | 2 | 7 | 0 | 13 | 0.7 |
| BusTravel | 8 | 127 | ✓ | 8/8 | 12/12 | 3/3 | 24/24 | 1 | 0.125 | 25 | 5 | 2 | 13 | 0 | 22 | 0.8 |
| Calculator | 8 | 95 | ✓ | 8/8 | 11/11 | 0/0 | 3/3 | 1 | 1 | 9 | 4 | 2 | 2 | 0 | 0 | 0.8 |
| ReservationQueue | 2 | 138 | ✓ | 2/2 | 1/1 | 3/3 | 8/8 | 1 | 0.5 | 11 | 7 | 4 | 5 | 0 | 6 | 0.8 |

**硬性判据全部通过**：确定性（两次构建字节一致）、模块召回 179/179、依赖召回 406/406、
权限召回 58/58、路由注册表召回 348/348、JSON5 健康度 0 失败、anti-silence。

### 怎么读这张表

- `depRec` 的分母是"目标为已声明模块的 `file:` 依赖"。指向 `libs/` 下 vendored SDK 的依赖
  （ComprehensiveMall 有 1 条指向 `weibo_open_sdk`）不是模块间依赖，单独计入告警。
- `routeScr`（路由→页面 struct 定位率）0.96–1.00。缺口是少数 `@Builder` 渲染了**别的模块
  导入进来的**组件，该文件本身没有 struct——逐条告警，不猜。
- **`routeIn`（注册路由被静态跳转指向的比例）0.13–1.00 不是解析缺陷**，而是真实工程大量使用
  `RouterModule.push({url: info.url})` 这类运行期路由名。BusTravel 全工程只有约 11 处静态跳转
  却注册了 24 条路由。未被指向的路由**逐条**进 coverageWarning。
- 该比例低于首版（0.21–1.00）是**修复的结果而非退化**：首版把跳转归属到"调用了该文件任意符号的人"，
  制造了大量假边（见下）。

---

## 5. 对抗审查修掉的缺陷

首版通过了全部硬性判据，但独立对抗审查在语料上找出七个真实缺陷。都已修复并补了回归测试。

### 5.1 导航归属从「文件」而非「跳转函数」出发 —— 31–36% 的导航边是假的

共享工具文件通常放多个互不相关的入口，例如 `LoginUtils` 同时有 `openSheet()`（开弹窗，不跳转）
和 `jumpLoginPage()`（跳转）。归属回溯若以**文件**为起点，`openSheet()` 的每个调用者都会被算成
跳转来源，一条真边变成一张星形假边网：ComprehensiveNews 46→30（-16，36%），
ComprehensiveTool 97→68（-30，31%），且全部带 `confidence 0.85`——**自信地错**，比缺失更糟。

修复：从跳转函数自身的 `calls` 入边出发，并把 visited 集从「按文件」改成「按节点」（按文件会
阻断同文件其他调用者的探索，结果依赖索引返回顺序）。回归测试 `harmony-nav-lift.test.ts` 在
回退修复后确实失败——已验证不是空测试。

### 5.2 `build(): void {` 认不出页面 —— verify 侧会整体误报页面缺失

`build()` 带返回类型标注是合法且常见写法（语料 195 处，87 个文件同时含 `NavDestination`）。
首版要求 `()` 后紧跟 `{`，这些全被判为"不是页面"。源侧靠路由注册表救回大半，但
`migrate verify` 侧**没有注册表**，会把一个正常鸿蒙目标报成"页面全缺"。

修复同时放宽了第二种形态：`build() { if (cond) { NavDestination() … } }`。判定改为「该 struct
自己的 `build()` 体内含 `NavDestination`」——比原来的整文件 `includes` 严，比「首个组件」松。

### 5.3 `connect<T>(...)` 泛型写法静默丢失 9 个全局状态模型

`AppStorageV2.connect<ControlInfo>(ControlInfo, …)` 语料 84 处、涉 8 个工程，其中 3 个丢的是
自己的 `GlobalInfoModel`。正则不匹配就什么都不产出，连告警都没有——违反本层的 anti-silence 契约。

### 5.4 Screen 按简名合并 —— 一个模块的页面被另一个吸收

19/76 工程存在跨模块同名页面。ComprehensiveNews 里两个模块各有 `SettingFont.ets`，首版合成
**一个** Screen 节点，`module_app_setting` 的页面在图里根本不存在、也不拥有任何页面。
修复：简名在多个文件出现时，matchKey 用路径限定；两侧（源侧与 verify 侧）用同一套判定，保持对称。

### 5.5 内建方法守卫放行了不可调用符号

首版守卫注释写「只放行 free function」，代码却放行所有 non-method（`constant`/`property`/
`enum_member`）。结果是把一类假边换成另一类：`downloadTask.delete(cb)` 连到另一个模块的中文
UI 标签枚举成员。修复：收紧到 `kind === 'function'`；`receiverNamesAType` 也改为**精确匹配**
类型名（首字母大写再匹配会把小写局部变量 `replace` 读成类型 `Replace`）。

> 残留：语料里仍有 7 条 `str.replace(...)` 连到同名导入常量的边，但它们 `resolvedBy: "import"`，
> 来自**导入解析器**而非本守卫，是影响所有 TS/JS 工程的既有行为，不在本次范围。

### 5.6 路由 token 窗口不配平括号

首版按固定 240 字符取实参，会越过本次调用的右括号读到下一条语句：`list.push(item)` 因此抓到
下一个方法里的 `'ResultPage'`，造出 `addToList → ResultPage`。比例低（≈0.25%）但纯属疏漏。
修复：按括号配平截取本次调用的实参。

### 5.7 两处性能与静默

- `resolveRouteStruct` 对**每条路由**各跑一次 `getAllNodes()` + `getAllEdges()`，O(routes × graph)。
  ComprehensiveTool 上 15.7s 构建里 14.5s 花在这里。改为构建一次索引：**27s → 13s**。
- 纯 legacy-router 工程（`main_pages.json`，无 Navigation 路由表）注册表为空，所有基于注册表的
  检查都被平凡满足 → 零导航边零告警，与"该应用确实没有跳转"无法区分。已补显式告警。

### 5.8 条件路由只取第一个候选 token

`ROUTE_TOKEN_RE` 原先只取实参里**第一个**候选，遇到条件路由会取错甚至全丢：

```ts
RouterUtils.pushPathByName(cardData.type === NewsEnum.Broadcast ? RouterMap.AUDIO_DETAILS
                                                               : RouterMap.VIDEO_PROGRAM_DETAILS, params)
```

第一个 `Ident.MEMBER` 是**条件里**的 `NewsEnum.Broadcast`,它不在路由注册表 → 整个调用点零边,
而两个分支都是真实目标。全语料 1829 个跳转调用点中,含条件分支的约 3%–5%,条件枚举抢先的 2–3 处。

修复:收集实参内**全部**候选逐个查注册表,并把扫描范围收紧到**第一个实参**(路由名恒为首参,
后面的 `param`/`onPop`/`animated` 常带无关枚举,扫进去会给一次跳转配上第二个错目标)。
精度不变——白名单机制照旧,条件里的非路由枚举自然落空。ComprehensiveNews 合成边 68 → 72。

**Android 侧无此暴露面**(已实测):`android-synthesizer.ts` 的 `NAVIGATE_RE` 锚定在 `navigate(`
紧邻位置,而 Compose Navigation 惯用单参字面量/类型化 key。nowinandroid 的 27 个 `navigate(`
调用点中含 `if`/`when` 分支的为 **0**,未命中的 2 处是转发封装 `navigate(navKey)` 和一个函数声明。
鸿蒙之所以有,是因为 `pushPathByName(name, param, onPop, animated)` 路由名只是多个位置参数之一,
且各工程普遍再包一层 `RouterUtils`,助长了计算式取值。

---

## 6. 页面清单完整性（与导航覆盖是两回事）

导航边受运行期路由名限制（§4「怎么读这张表」），但**页面总数是完整的**。用三个互相独立的
信号各数一遍，与产出的 Screen 集合逐个方向比对：

| Project | @Entry | NavDestination struct | route 注册页 | appgraph Screen | 漏 @Entry | 漏 NavDest | 路由未覆盖 |
|---|---:|---:|---:|---:|---:|---:|---:|
| ComprehensiveTool | 5 | 119 | 118 | 125 | 0 | 0 | 0 |
| ComprehensiveNews | 5 | 60 | 57 | 70 | 0 | 0 | 0 |
| ComprehensiveMall | 2 | 54 | 53 | 58 | 0 | 0 | 0 |
| CarBeautyCare | 2 | 25 | 22 | 26 | 0 | 0 | 0 |
| ArtTraining | 3 | 21 | 20 | 25 | 0 | 0 | 0 |
| HomeDecoration | 1 | 23 | 19 | 25 | 0 | 0 | 0 |
| Metro | 1 | 15 | 16 | 17 | 0 | 0 | 0 |
| BusTravel | 1 | 24 | 24 | 25 | 0 | 0 | 0 |
| Calculator | 2 | 6 | 3 | 9 | 0 | 0 | 0 |
| ReservationQueue | 1 | 2 | 8 | 11 | 0 | 0 | 0 |

**零遗漏**：10 个工程、348 条注册路由 **100%** 都有对应 Screen，`@Entry` 与 NavDestination
struct 也一个不漏。Screen 数高于任一单列，是因为它是三源并集——一个页面可能只在其中一源出现
（如只走 `@Entry` 的卡片入口、或注册了路由但 `build()` 不以 NavDestination 为根的页面）。

一类曾被丢弃的页面已补回：路由指向的文件里只有一个 `@Builder`，渲染的是**其他模块 import
进来的**组件，该文件本身没有 struct。这类页面确实存在且可导航，现在计入并标
`subtype: 'declared-route'` + `attrs.implementation: 'unresolved'`，同时保留告警。若同名的真实
Screen 已存在（`features/points/…/UpdateAddressPage.ets` 只是 `lib_widget` 同名组件的三行封装），
则折叠到那个 Screen 上而不是造一个重复页面。

> 反向也确认过没有虚增：ReservationQueue 的 11 个 Screen = 8 个注册路由 + 2 个 `@Entry`
> （含桌面卡片入口）+ 1 个 NavDestination，全是真页面。

## 7. 复现

```bash
npm run build
node scripts/appgraph-eval/harmony-probe.mjs --out .eval/harmony/run1
cat .eval/harmony/run1/summary.md

# 单工程
node dist/appgraph/cli.js build <鸿蒙工程> --platform harmony   # auto 也能识别
node dist/appgraph/cli.js screens <鸿蒙工程>
node dist/appgraph/cli.js nav <鸿蒙工程>
node dist/appgraph/cli.js capabilities <鸿蒙工程>
```

工程集与选取理由见 `scripts/appgraph-eval/harmony-projects.json`（覆盖规模 2–44 模块、
导航体系、JSON5 脏度、云能力四个轴）。
