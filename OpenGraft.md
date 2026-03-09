# OpenGraft

**可自举的自主 AI 编程系统** — 给定目标，AI 自主规划、实现、测试、迭代。Agent 像枝条一样分出去工作，完成后嫁接回主干。

> 本文档供 AI session 冷启动使用。包含架构设计、方法论、实现路径。
> 来源：多个 AI 辅助开发项目的实战经验 + 业界自主编程 agent 研究。
> 官网：opengraft.com

## 一、系统目标

构建一个**可自举的**自主编程系统：给定抽象任务描述，AI 自主规划、实现、测试、迭代。人类只提供目标和偶尔的方向修正。

**核心循环**：
```
目标 → 规划 → 实现 → 测试 → 分析结果 → 调整 → 继续
                ↑                              ↓
                └──────────────────────────────┘
```

**核心洞察**：
- AI 可以幻觉代码逻辑，但不能幻觉测试结果和编译输出
- 因此，每一步都必须通过实际执行验证，测试结果是唯一的 truth source
- Context window 会满，系统必须能压缩历史但保留进度和方法论

**与 OpenClaw 等系统的关键差异**：
- **可自举**：系统成熟后，AI session 运行在系统自身之上（见第十一节）
- **元可扩展**：部署者的 AI 可以修改系统本身，并通过 PR 将改进回馈上游（见第十二节）

## 二、技术选型原则

### 2.1 选择对 AI 友好的语言

核心标准：**编译器/类型检查器能在运行前告诉 AI 哪里写错了**。

| 语言方案 | 优势 | 注意事项 |
|---------|------|---------|
| **TypeScript strict** | 类型推断强、生态大、AI 训练数据多、前后端统一 | `tsconfig` 必须开 `strict: true` |
| **Python + pyright strict** | AI 最熟悉的语言、库生态最大 | 必须配 pyright `typeCheckingMode: strict`，否则退化为动态类型 |
| **Rust** | 编译器即导师，borrow checker 消灭整类 bug | 学习曲线陡，AI 在复杂生命周期上会挣扎 |
| **Go** | 简单、编译快、并发原生 | 泛型较弱，类型表达力有限 |

**关键原则**：不是选哪个语言"最好"，而是选哪个让 AI 在犯错时**最快得到反馈**。动态类型语言让 AI 写出"看起来对"但运行时崩溃的代码。静态类型把一半 bug 消灭在编译期，这对 AI 的价值远大于对人类。

**Python 特别说明**：Python 本身是动态类型，但加上 pyright strict 后可以接近静态类型体验。必须在项目第一天就配好，否则后面补类型标注的成本极高。推荐配置：
```json
{
  "typeCheckingMode": "strict",
  "reportMissingTypeStubs": false
}
```

### 2.2 工具链选择

原则：**反馈循环越短，AI 效率越高**。

- **测试框架**：选启动快的（pytest / bun:test / vitest），不选需要大量配置的
- **Lint/Format**：选单工具方案（Biome / Ruff），配置少，AI 容易遵守
- **包管理**：选快的（Bun / uv），依赖安装慢 = AI 等待 = 浪费 token

### 2.3 架构模式

选择 AI 容易理解和调试的模式：

- **事件驱动 > 回调嵌套**：每个模块独立，可以隔离调试
- **插件化 > 单体**：新增功能不需要理解整个代码库
- **集中式状态 > 分散 mutation**：AI 知道"去哪看当前状态"
- **纯函数 > 副作用**：可以用单元测试覆盖的逻辑越多，AI 越不容易出错

### 2.4 反面模式

- **不选 AI 不熟悉的框架**：小众框架的 API，AI 会幻觉
- **不选 magic 太多的框架**：约定优于配置对人好，对 AI 坏——AI 需要显式的东西
- **不选需要大量配置的工具**：AI 在配置文件上浪费的时间比写代码多

## 三、核心方法论

### 3.1 垂直迭代

**每次只实现一个功能，但把这个功能从类型到实现到测试全部做完**。

```
❌ 横向：先写完所有类型 → 再写完所有实现 → 最后补测试
✅ 垂直：功能A（类型→实现→测试→通过）→ 功能B（类型→实现→测试→通过）
```

原因：
- 横向迭代积累大量未验证代码，出问题时不知道是哪步引入的
- 垂直迭代每一步都有测试保护，出问题时 diff 很小，容易定位
- AI 的 context window 有限，垂直迭代让每步需要的上下文更少

### 3.2 测试驱动的自校正

这是整个系统最核心的机制。AI 的幻觉无法靠提示词消除，但可以靠客观反馈消除。

**四层测试金字塔**：

| 层级 | 内容 | 速度 | 数量 |
|------|------|------|------|
| **纯函数单测** | 公式、计算、状态转换 | <1ms | 最多 |
| **单模块集成** | 一个模块 + 受控环境 | ~100ms | 中 |
| **多模块集成** | 模块间交互 | ~500ms | 少 |
| **E2E** | 完整用户场景 | ~2s | 最少 |

**能用纯函数测的逻辑不要启动整个系统。能用单模块测的不要多模块。**

**确定性测试原则**（[Fowler](https://martinfowler.com/articles/nonDeterminism.html)、[Google SWE Book](https://abseil.io/resources/swe-book/html/ch11.html)、[Luo et al.](https://mir.cs.illinois.edu/lamyaa/publications/fse14.pdf)）：

| 根因 | 占比 | 对策 |
|------|------|------|
| 异步等待不足 | ~45% | `wait_for(condition)` 代替 `sleep(ms)` |
| 测试间共享可变状态 | ~25% | 每个测试独立环境，`setup`/`teardown` 隔离 |
| 时间依赖 | ~8% | 控制时间推进，不依赖墙钟 |
| 资源泄漏 | ~5% | teardown 中关闭所有连接/文件 |

**Flaky 测试 = Bug**，永远不要用重试来"修"测试。

### 3.3 实际执行消灭幻觉

```
❌ AI: "这个 API 应该接受一个 options 对象"
✅ AI: 先跑 --help 或读文档，确认签名，再写代码

❌ AI: "这段代码应该能工作"
✅ AI: 写完 → 编译 → 跑测试 → 看输出 → 确认工作

❌ AI: "这个错误应该是框架的 bug"
✅ AI: 加日志 → 看实际发生了什么 → 接受日志告诉你的事实
```

### 3.4 调试协议

**永远不要**：反复空跑、加超时、减并发、怀疑框架。

**正确流程**：
1. **定层**：错误来自哪一层？是框架报的还是我们的代码报的？
2. **加日志**：在状态变更点加 log，确认变更是否发生
3. **信任日志**：日志显示"不可能"的现象 → 接受它正在发生 → 加更多 log 追因
4. **隔离**：单独跑 20-30 次确认是偶发还是必现
5. **最小化**：剥到最小复现，验证修复

### 3.5 系统替换的铁律

当新机制替代旧机制时，旧机制必须**完全移除**。不保留 fallback。

Fallback 的危害：
1. 抵消新系统的优势
2. 默默存在，出 bug 时没人怀疑它
3. 更危险的是**思维模型残留**：AI 会把新系统强行解释为旧系统的变体，用旧概念理解新概念，导致完全错误的推理方向

### 3.6 代码膨胀防控

AI 生成代码的系统性问题：**功能正确但架构判断缺失**。GitClear 2025 研究（2.11 亿行变更）显示，AI 辅助开发后复制粘贴代码增加 8 倍，重构占比从 25% 降至 10% 以下。AI 优化当前请求，不考虑系统长期一致性。

**防控原则**：

1. **加功能前先问架构问题**：这个功能放在哪个模块？需要新模块还是扩展现有的？有没有已存在的类似机制可以复用？
2. **三行重复优于过早抽象**：只在确实出现第三次重复时才提取公共逻辑。AI 倾向于为每个一次性操作创建 helper/utility，这会制造比重复代码更难维护的抽象
3. **每次 PR 的 diff 必须审查架构影响**：不只看"功能对不对"，还要看"放的位置对不对"、"有没有引入不必要的耦合"
4. **自动化质量门禁**：在 CI 中加入复杂度检查（cyclomatic complexity）、重复代码检测。超标即阻断，不允许"先上后改"
5. **定期重构窗口**：每完成 N 个功能后，专门做一轮架构审查和重构，而不是永远只加新功能

## 四、自主运行架构

### 4.1 业界参考架构

主流自主编程 agent 都收敛到同一个核心模式：**LLM 在循环中观察环境状态、发出工具调用**（[Anthropic: Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)）。

| 系统 | 核心架构特征 | 值得借鉴的点 |
|------|-------------|-------------|
| **OpenHands** | 事件溯源 + 无状态 `step()`，所有交互是不可变事件日志 | 事件溯源让回放/调试/恢复非常简单 |
| **SWE-Agent** | Agent-Computer Interface（ACI），为 LLM 定制的工具界面 | 编辑即 lint：无效编辑立即被拒绝并返回错误 |
| **Aider** | Architect/Editor 双模型 + tree-sitter 仓库地图 | 用 AST 提取函数签名作为上下文，不发送全部源码 |
| **Devin** | 隔离 VM + 多 agent 内部结构 | 从"全自主"回退到"agent-native IDE"——承认需要人参与 |

**关键共识**：
- **沙箱隔离**：所有执行在容器/VM 中进行
- **工具输出必须精简**：原始 terminal dump 会撑爆 context
- **即时验证**：编辑后立即 lint/typecheck，不让 AI 在错误状态上继续
- **Git 作为检查点**：每个通过测试的状态都 commit，出错可回退

### 4.2 系统结构

整个系统是一个**后台 daemon**，通过 API 管理多个项目。API 和实际执行行为分离——前端 UI 只是 API 的消费者。

```
┌───────────────────────────────────────────────────────────────┐
│                          Daemon                               │
│                                                               │
│  ┌──────────────┐                                             │
│  │  REST/WS API │ ← 前端 UI / CLI / 其他客户端                │
│  └──────┬───────┘                                             │
│         │                                                     │
│  ┌──────▼─────────────────────────────────────────────────┐   │
│  │              Project Manager                           │   │
│  │  project_a (running) │ project_b (stopped) │ ...       │   │
│  └──────┬─────────────────────────────────────────────────┘   │
│         │                                                     │
│  ┌──────▼────────────────── per project ──────────────────┐   │
│  │                                                        │   │
│  │  Root Agent (main branch)  ← 主脑，全局把控             │   │
│  │  │  有自己的 memory、context、AI session                │   │
│  │  │  负责：任务分解、优先级、架构决策、合并审查           │   │
│  │  │                                                     │   │
│  │  ├── Agent: 实时消息收发  (feat/realtime-msg)          │   │
│  │  │   │  自己的 memory、context、AI session              │   │
│  │  │   ├── (子节点由该 agent 自主管理)                    │   │
│  │  │   └── 完成 → merge 回 main，记忆汇入 root           │   │
│  │  │                                                     │   │
│  │  ├── Agent: 用户认证  (feat/auth)                      │   │
│  │  │   ├── Sub-agent: JWT 实现  (feat/auth-jwt)          │   │
│  │  │   └── Sub-agent: 登录 UI   (feat/auth-ui)          │   │
│  │  │                                                     │   │
│  │  └── (pending nodes — root agent 决定何时启动)          │   │
│  │                                                        │   │
│  │  共享：File System / Terminal / Test Runner / Git       │   │
│  └────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────┘
```

**Agent 层级 = 任务树层级**：

不存在独立的 "Orchestrator" 组件——**Root Agent 就是主脑**，它自己也是一个完整的 AI agent（有 context、memory、session），只是它工作在 main branch 上，职责是全局把控。

- **Root Agent**（main branch）：拥有任务树全局视图。负责任务分解、优先级排序、架构决策。小任务自己做，大任务 spawn 子 agent
- **子 Agent**（feature branch）：在自己的分支上自主工作。有自己的 memory 和 context，不需要事事请示 root。完成后 merge 回 main
- **递归**：子 agent 如果发现自己的任务太大，可以继续分解并 spawn 孙子 agent。层级越高的 agent 自然管理它下面的 agent
- **每个 agent 一个分支**：agent 和 branch 是 1:1 绑定的。agent 的生命周期 = 分支的生命周期

**API 层**：
- `POST /projects` — 指定文件夹，创建项目（初始化 git + `.opengraft/`）
- `DELETE /projects/:id` — 删除项目（只删元数据，不删代码）
- `POST /projects/:id/start` — 启动 root agent
- `POST /projects/:id/stop` — 优雅停止（root 通知所有子 agent 完成当前原子操作后停）
- `GET /projects/:id/tree` — 获取 agent 树（WebSocket 推送实时更新）
- `POST /projects/:id/tasks` — 插入/修改/删除任务节点（root agent 响应）
- `GET /projects/:id/agents/:nodeId` — 获取某 agent 的对话流和状态
- `GET /projects/:id/metrics` — 获取成本和效率指标（按 agent 分breakdown）

**前端 UI** 是一个网页应用，连接 daemon API。核心交互：选文件夹 → 创建项目 → 输入目标 → 开始。之后通过任务树 UI（见 4.3）监控和交互。任务树中的每个节点同时也是一个 agent 的视图——点进去能看到这个 agent 在做什么。

### 4.2.1 数据分离：git 内 vs daemon 侧

一个项目有两个存储位置：**项目 git 仓库**（代码 + 知识）和 **daemon 数据目录**（运行时状态）。

判断标准：**`git clone` 到别处还有用吗？**

**在 git 仓库内**（`.opengraft/` 目录，随代码版本化）：
```
project/
├── .opengraft/
│   ├── memory.md          # 积累的知识（随分支合并，见 4.3）
│   └── project.yaml       # 项目级配置（autonomy level、质量门禁阈值）
├── src/
├── tests/
└── ...
```

- **memory.md**：AI 积累的经验。跟随分支走、合并时汇聚。clone 到别处这些知识仍然有价值
- **project.yaml**：项目自身的配置偏好。新的 daemon 接手这个项目时应该读到同样的配置

**在 daemon 数据目录**（`~/.opengraft-daemon/projects/{id}/`）：
```
~/.opengraft-daemon/
├── daemon.yaml                # 全局配置：API keys、模型偏好、默认安全策略模板
├── projects/
│   ├── {project-id}/
│   │   ├── tree.json          # 任务树：节点状态、分支绑定、优先级
│   │   ├── security.yaml      # 该项目的安全策略（沙箱规则、命令白名单、网络权限）
│   │   ├── sessions/          # AI 对话历史（按节点 ID 分文件）
│   │   │   ├── node-auth.jsonl
│   │   │   └── node-realtime-msg.jsonl
│   │   ├── metrics.jsonl      # token 消耗、成本追踪、效率指标
│   │   └── audit.log          # 安全审计日志
│   └── {project-id-2}/
│       └── ...
```

安全策略 per project：不同项目有不同的安全需求——爬虫项目需要网络访问，数据库工具需要特定端口，纯库项目则几乎不需要网络。创建项目时从 `daemon.yaml` 的默认模板拷贝一份，用户按需调整。

各类数据的归属和理由：

| 数据 | 位置 | 理由 |
|------|------|------|
| 代码、测试 | git | 核心产物 |
| Agent 记忆 | git `.opengraft/memory.md` | scratch pad，每个 agent 在自己分支上自由写，merge 时上浮 + 父 agent 审查 |
| 项目配置 | git `.opengraft/project.yaml` | 项目自带偏好，换 daemon 仍适用 |
| 任务树状态 | daemon `tree.json` | 运行时状态，变化极频繁（每秒级），不适合 git commit |
| 分支绑定 | daemon `tree.json` | 是关于 git 的元数据，不是 git 管理的内容 |
| AI 对话日志 | daemon `sessions/` | 体积大、仅调试用、不是项目知识 |
| Token/成本 | daemon `metrics.jsonl` | 运营数据，与代码无关 |
| 安全策略 | daemon `security.yaml` | per project，但在 AI 的沙箱之外，不可被项目内的 AI 修改 |
| API keys | daemon `daemon.yaml` | 敏感信息，绝对不进 git |

**关键设计**：安全策略在 daemon 侧（per project），**不在项目 git 内**。这意味着项目内的所有 agent（root 和子 agent）都无法通过修改 `.opengraft/` 文件来突破安全边界——安全规则在它们的修改范围之外。

### 4.3 每个 Agent 的内部结构

每个 agent（无论 root 还是子 agent）都有三个组件：**Task Tracker**（管理自己负责的子树）、**Context Manager**（管理自己的 context window）、**Stimulus Generator**（决定自己下一步做什么）。Root agent 的 Task Tracker 管理整棵树，子 agent 的 Task Tracker 只管自己的子树。

**Task Tracker 与任务树**：

核心数据结构是**任务树**。项目是树根，root agent 分解出子节点，每层 agent 可以继续分解自己的子节点。

**按功能垂直切分，不按前后端水平切分**：

```
project: "多人聊天应用"
├── 实时消息收发              [feat/realtime-msg]     ✅ passed
│   ├── WebSocket 协议 + 服务端处理
│   ├── 客户端连接管理 + 重连
│   └── 消息渲染 UI
├── 用户认证                  [feat/auth]             🔄 in_progress
│   ├── JWT 签发/验证
│   ├── 登录/注册 API + UI
│   └── 会话持久化
├── 消息持久化 + 历史记录      [feat/msg-history]      ⏳ pending
├── 多房间/频道                                       ⏳ pending
└── 在线状态 + 输入指示器                              ⏳ pending
```

每个功能节点是一个**垂直切片**——从数据层到 API 到 UI 全部包含。这确保每个节点完成后都是一个可用的、可测试的增量，而不是"后端做完了但没法验证因为前端还没做"。

**分支策略：Trunk-Based + 短命 Feature Branch**

遵循 [Trunk-Based Development](https://trunkbaseddevelopment.com/short-lived-feature-branches/) 的核心原则：

- **分支寿命 ≤ 1-2 天**：每个功能节点绑定一个 feature branch，从父分支 checkout，完成后 merge 回父分支并删除。超过 2 天说明任务拆得不够细——继续分解、spawn 子 agent
- **频繁同步父分支**：工作中定期从父分支 merge，保持距离最小
- **一个 agent 一个分支**：agent 和 branch 是 1:1 的。分支是 agent 的工作空间，agent 结束 = 分支合并或丢弃
- **所有改动通过子 agent**：root agent 是纯 orchestrator，不直接修改代码。即使是小改动也 spawn 子 agent 在独立分支上完成

**节点状态**：`pending → in_progress → testing → passed | failed`（`stuck` 是系统内部的断路器，对 agent 不可见——连续失败 3 次后自动标记）

**Agent 生命周期 = 分支生命周期**：
- **passed** → 子 agent 的分支 merge 回父分支，子 agent 销毁，记忆汇入父 agent
- **failed** → 子 agent 遇到困难或无法解决，返回父 agent。父 agent 决定：resume（给指示继续）、reset（擦除分支重来）、或删除任务换方案

**回退天然内置**：分支就是回退边界。一个子 agent 走错方向，父 agent `git branch -D` 丢弃即可，其他 agent 零影响。不需要单独设计回退机制——agent 树 + 分支隔离本身就是回退机制。

**记忆系统**：

每个 agent 有自己的记忆文件（`.opengraft/memory.md`），性质是 **scratch pad**——不是正式文档，而是 agent 随手记下的笔记、踩坑记录、发现的模式。类似 Claude 的 auto memory，不是 CLAUDE.md。

```
feat/auth 分支上 agent 的 memory.md：
  - JWT refresh token 必须用 httpOnly cookie，不能放 localStorage
  - bcrypt rounds=12 在测试中太慢，测试环境用 rounds=4
  - 这个项目的 session 中间件挂载顺序很重要，auth 必须在 cors 之后

feat/realtime-msg 分支上 agent 的 memory.md：
  - WebSocket 重连需要指数退避，固定间隔会打爆服务端
  - 消息顺序用服务端时间戳，不要信客户端时钟
```

**写入权限：自由写自己的，谨慎碰上层的**：
- 子 agent 可以**随心所欲**地往自己分支的 memory 里写任何它觉得重要的事。没有格式约束，没有审批。这是它的 scratch pad
- 子 agent **不应修改从父分支继承来的记忆条目**。就像向上级汇报工作——你可以补充新发现，但不能擅自改上级的结论。子 agent 只追加，不修改已有内容

**记忆上浮 = 汇报工作**：

子 agent 完成后分支 merge 回父分支，memory.md 也随之合并。但这不是无条件合并：

1. **子 agent 新增的条目**（子 agent 工作中的发现）→ 进入父分支的 memory。父 agent 可以在 merge 后审查、整理、保留重要的、丢弃琐碎的
2. **子 agent 不应修改的条目**（父分支/main 上已有的记忆）→ 如果子 agent 确实发现上层记忆有误，它应该**追加一条纠正说明**而非直接覆盖。父 agent merge 时看到这个纠正，自行决定是否采纳
3. **分支丢弃 = 记忆丢弃**：走错方向的分支被删除，那些关于错误方向的"经验"也一起消失——正确的，因为那些经验建立在被放弃的代码之上

**自然筛选**：越往上层汇聚的记忆越重要。子 agent 随手记的琐碎细节，如果父 agent 审查后觉得不重要就删掉。最终留在 main 上的 memory.md 是整个项目最精华的经验，经过了层层筛选。这和人类组织的信息上浮是同一个模式。

**鼓励同步写入**：agent 每次 commit 功能代码时，同时 commit 相关记忆。不要等功能全做完再补——中途的发现最容易遗忘。

这解决了 Context Manager 的核心难题：context window 会被压缩，对话历史会丢失，但**记忆已经持久化在 git 中**。新 session / 新 agent 启动时读 `.opengraft/memory.md`，就能继承之前积累的经验，无需从对话历史中恢复。

**任务树即 UI**：

任务树不只是内部数据结构，它本身就是面向用户的界面：

```
┌─ 多人聊天应用  [root agent · main] ───────────────────┐
│                                                        │
│  ✅ 实时消息收发          agent #2 · merged            │
│  │  点击展开 → agent 对话记录、commit 历史、记忆条目    │
│  │                                                     │
│  🔄 用户认证              agent #3 · feat/auth         │
│  │  点击展开 → 实时查看 agent 正在做什么               │
│  │  ├── ✅ JWT 签发/验证   agent #4 · merged into auth │
│  │  ├── 🔄 登录注册 API    agent #5 · feat/auth-ui     │
│  │  └── ⏳ 会话持久化      (agent #3 稍后自行处理)      │
│  │                                                     │
│  ⏳ 消息持久化 + 历史记录  (root agent 决定何时启动)    │
│  ⏳ 多房间/频道                                         │
│  🔴 在线状态 + 输入指示器  agent #6 · failed             │
│     点击展开 → 查看失败原因、agent 的分析、保留的分支   │
└────────────────────────────────────────────────────────┘
```

每个节点 = 一个 agent（已完成、进行中、或待分配）。点击可查看：
- **Agent 状态**：运行中 / 完成 / stuck，分支名、与父分支的距离
- **Agent 对话流**：该 agent 的思考和操作过程（实时流式）
- **commit 历史**：该 agent 在分支上的 git log
- **记忆条目**：该 agent 积累的经验和决策
- **子 agent 列表**：该 agent spawn 了哪些子 agent，各自状态
- **失败详情**：尝试过什么、卡在哪里、需要什么帮助

用户在这个 UI 上可以：给 failed agent 发送 continue 指令、调整节点优先级、插入新需求节点（root agent 响应）、拆分过大的节点。

**Context 压缩**（Claude Code 式 compact）：

接近 context window 上限时，对**全部对话**生成结构化 checkpoint，然后**重建上下文**：

1. 用同级模型对完整对话生成 checkpoint（Task / Current Phase / Completed / Files Modified / Current State / Next Action / Key Context）
2. 清空全部消息
3. 重建：原始 task prompt + 从磁盘重读 fresh memory + checkpoint
4. System prompt 每次 API 调用都重新发送（方法论、架构规则不会丢失）

关键设计：
- **前瞻性**：checkpoint 重点在"下一步该做什么"，不是回顾历史
- **记录被拒绝的方案**：防止 compact 后重复尝试已失败的路径
- **Fresh memory**：从磁盘重读 `.opengraft/memory.md`（agent 可能在 session 中修改了它）
- **UI 显示**：compact 事件在 activity log 中显示为可折叠的边界线，附带 checkpoint 内容，并标注"上方内容对 AI 不可见"

跨 session 持久化的核心——session 恢复时先读任务树 + `.opengraft/memory.md`，就知道从哪里继续、带着什么经验继续。

- **子 agent 不需要全局 context**：它只需要知道自己负责的子树 + 从 root 继承的方法论和架构约束

**Stimulus Generator**（per agent，但 root 和子 agent 行为不同）：

Root agent（优先级从高到低）：
  1. 有 failed 的子 agent → 审查失败原因，resume（给指示）或 reset（换方案）
  2. 有 passed 但未 merge 的子 agent → merge 分支，delete_task 清理
  3. 有 pending 的子节点 → 评估依赖关系，spawn 下一个子 agent
  4. 所有子 agent done → 在 main 上跑完整测试套件确认无回归
  5. 所有任务完成 → 停止，报告最终状态

子 agent：
  1. 当前任务测试失败 → 修复
  2. 当前任务通过 → 看有无子节点待做，有则继续或 spawn 孙子 agent
  3. 遇到困难无法解决 → fail 返回父 agent（不是自己标 stuck）
  4. 所有子节点完成 → merge 回父分支，自己销毁

### 4.4 Tool 设计

参考 [SWE-Agent ACI 原则](https://arxiv.org/abs/2405.15793)：

1. **原子操作**：每个 tool 做一件事，组合在 agent 层完成
2. **输出有界**：搜索结果限 50 条，文件查看限 100 行窗口，防止 context 洪泛
3. **即时验证**：编辑操作自带 lint，无效编辑立即拒绝并返回错误信息
4. **结构化返回**：`run_tests()` 返回 `{ passed: [...], failed: [...] }` 而不是原始文本
5. **为 LLM 设计，不为人设计**：search/replace 比 unified diff 更适合 LLM（[Aider 的发现](https://aider.chat/docs/more/edit-formats.html)：LLM 写 diff 需要先预测行号，容易错）

```
Tools（接口，具体实现取决于语言/环境）：

文件操作：
  read_file(path, offset?, limit?) → content_with_line_numbers
  write_file(path, content) → success | lint_errors
  edit_file(path, old_str, new_str) → success | lint_errors | not_found
  glob(pattern) → paths (capped)
  grep(pattern, path?) → matches (capped)

执行：
  run_command(cmd, timeout?) → { stdout, stderr, exit_code }

专用（封装 + 结构化返回）：
  run_tests(filter?) → { passed: [...], failed: [...], errors: [...] }
  typecheck() → { errors: [...] }
  lint() → { warnings: [...], fixable: [...] }
  git_status() → { branch, staged, unstaged, untracked }
  git_commit(message) → hash  // 仅在测试通过后允许调用
```

### 4.5 起源与演进路径

OpenGraft 现在不存在于物理世界上。**它的第一个版本应该脱胎于 Claude Code**——不是从零造轮子，而是在已有的、能用的 AI 编程工具上构建 orchestration 层。

**三阶段演进**：

1. **脱胎于 Claude Code**（Phase 0-1）：用 Claude Code 的 headless 模式（`claude -p`）或 Agent SDK 作为执行引擎。OpenGraft 只负责 orchestration（任务树、agent 管理、记忆）。好处：tool 实现、沙箱、context 管理全部白嫖 Claude Code 已有的
2. **替换为直接 API 调用**（Phase 2-3）：逐步把 Claude Code 依赖替换为直接 Messages API + 自建 tool 层。此时支持通用 API key
3. **多 provider 支持**（Phase 4+）：支持 Claude OAuth + 通用 API key + 其他 LLM provider

**目标是完全自建 tool 层**——OpenGraft 最终拥有自己的文件编辑、搜索、命令执行、context 管理实现，不依赖 Claude Code。但 Phase 0 不是做这件事的时候。先用 Claude Code 跑通 orchestration 逻辑（任务树、agent 层级、记忆上浮），确认设计可行后，再逐步替换底层。这本身就是自举——用别人的工具造出自己的工具，然后用自己的工具替掉别人的。

### 4.6 认证配置

Daemon 支持两种认证方式，在 `daemon.yaml` 中配置：

**方式 1：通用 API Key**（标准方式）
```yaml
auth:
  type: api_key
  key: "sk-ant-..."                    # Anthropic API key
  # 或其他 provider 的 key
```

**方式 2：Claude OAuth**（用 Claude Max 订阅额度，无需单独付费 API）
```yaml
auth:
  type: claude_oauth
  token: "sk-ant-oat01-..."            # OAuth token
```

调用方式：
```
# API Key 方式
x-api-key: sk-ant-...

# OAuth 方式（唯一区别：Bearer + beta flag）
Authorization: Bearer sk-ant-oat01-...
anthropic-beta: oauth-2025-04-20
```

**Token 获取**：

| 方式 | 命令 | 有效期 | 刷新 |
|------|------|--------|------|
| `claude login`（OAuth） | 浏览器授权流程 | ~8 小时 | 有 refresh token，可自动续期 |
| `claude setup-token` | 生成长期 token | 长期有效 | 无 refresh token，过期需重新生成 |

**建议**：开发/自用场景直接用 `setup-token`，不需要刷新逻辑。生产部署用 OAuth + 自动刷新。

**模型选择**（配合 5.6 成本控制的模型分级）：
```yaml
models:
  strong: "claude-opus-4-6"            # 规划、架构、复杂调试
  fast: "claude-sonnet-4-6"            # 常规编码、测试
  cheap: "claude-haiku-4-5-20251001"   # 格式修复、简单任务
```

**风险提示**：Claude OAuth token 的 ToS 限制其用于 Claude Code 和 claude.ai。用于第三方系统存在被收紧的风险。通用 API key 无此问题。

## 五、运行行为模型

### 5.1 永不停止原则

Root agent 启动后持续运行，session 永久保留。**只有两种情况停止**：

1. **完成**：所有任务 passed 并已 merge，测试全绿
2. **所有任务 failed**：无法继续推进，等待用户

**Agent 退出模型**（对 agent 可见的只有两种）：
- **passed** — 完成任务，测试通过，代码已提交。父 agent merge 分支
- **failed** — 遇到困难或无法解决，返回父 agent。包含清晰的失败原因和已尝试的方案

**需要澄清时**：agent 调用 `clarify(question)` 工具，阻塞等待回答。超时后 agent 自行判断继续。这是工具调用，不是退出条件。

**stuck 是断路器**：agent 不知道 stuck 的存在。系统在一个任务连续失败 3 次后自动标记为 stuck，父 agent 跳过它处理其他任务。这是防止无限循环的内部机制。

除此之外，AI 永远有事可做：failed 的子 agent 需要 resume/reset；pending 的任务需要启动。Stimulus Generator 保证了这一点。

### 5.2 自主程度（Autonomy Level）

用户可以设定 1-10 的自主程度，控制 AI 在什么粒度上需要征求用户意见：

| 等级 | 含义 | 不询问 | 需要询问 |
|------|------|--------|---------|
| 1 | 极保守 | 纯格式化 | 任何代码变更 |
| 2 | 保守 | 格式化、注释 | 小 refactor、bug fix |
| 3 | 谨慎 | bug fix、小 refactor | 新函数、接口变更 |
| 4 | 稳健 | bug fix、小 refactor、补测试 | 新功能、接口变更、依赖变更 |
| 5 | 平衡（默认） | 上述 + 新增小功能 | 中等以上功能、架构调整、依赖变更 |
| 6 | 主动 | 上述 + 中等功能、中等 refactor | 大型重构、架构变更、删除功能 |
| 7 | 大部分自动 | 上述 + 大功能 | 系统关键变化、架构变更 |
| 8 | 项目自由 | 用户项目的一切变更 | 对系统本身的任何元修改 |
| 9 | 元修改宽松 | 用户项目 + 小型元修改 | 系统核心（orchestrator、tool 实现）的修改 |
| 10 | 全自主 | 一切 | 从不询问（仅在完成或遇到技术阻塞时停止） |

### 5.3 澄清机制

Agent 通过 `clarify(question)` MCP 工具请求澄清。这是阻塞式工具调用：

```
Agent 调用 clarify("用户认证是用 JWT 还是 session?")
    │
    ├── 用户/父 agent 在 timeout 内回复 → agent 收到回答，继续工作
    │
    └── 超时（可配置，默认 5min）
        → agent 收到 "No response received. Use your best judgement."
        → agent 自行决策，在 memory 中记录决策理由，继续工作
```

**技术上卡住**：agent 不用 clarify，而是直接 fail 返回父 agent。父 agent 有更多上下文，可以 resume（给指示）或 reset（换方案）。

### 5.4 用户中途交互

用户可以在任何时刻：

- **加需求**：插入新任务到 Task Tracker，AI 在当前步骤完成后评估优先级
- **改需求**：修改已有任务描述，如果已部分实现，AI 评估需要回退多少
- **撤销需求**：标记任务为 cancelled，AI 清理已实现的相关代码（如果有的话）
- **调整自主程度**：随时改变 autonomy level
- **强制方向**：直接指定"用方案 A 不用方案 B"，AI 不再讨论替代方案

**中断处理**：用户消息到达时，AI 不会立即放下手头工作。它会完成当前原子操作（比如一次编辑 + 测试），确保代码在可编译状态，然后处理用户消息。

### 5.5 配置示例

```yaml
autonomy:
  level: 7                    # 1-10
  timeout: 30m                # 询问超时
  timeout_action: search      # search | skip | wait

  # 覆盖规则（优先于 level）
  overrides:
    - scope: "tests/*"
      level: 9                # 测试文件几乎全自动
    - scope: "core/*"
      level: 3                # 核心模块更保守
    - scope: "meta"
      level: 5                # 元修改中等询问
```

### 5.6 成本与 Token 预算

系统永不停止意味着持续消耗 LLM API 调用。没有成本控制 = 烧钱失控。

**预算层级**：
- **项目预算**：整个项目的总 token/费用上限。超出则停止，报告已完成和未完成的节点
- **节点预算**：单个任务节点的 token 上限。一个功能不应该消耗不成比例的资源——如果一个节点烧了总预算的 30% 还没完成，很可能需要拆分或换方案
- **单步预算**：单次 AI 调用的 token 上限。防止 AI 把整个代码库塞进 context

**异常检测**：
- **循环检测**：同一个错误修了 3 次、同一个文件编辑了 5 次以上 → 可能在兜圈子 → 标记 stuck，不继续烧
- **成本速率告警**：token/分钟突增（正常编码 vs 反复跑失败的测试）→ 通知用户
- **空转检测**：AI 在做 lint fix → test → lint fix → test 循环但测试通过率没有提升 → 中断

**模型分级**（降本）：
- 规划、架构决策、复杂调试 → 强模型（Opus 级）
- 常规编码、测试编写、格式修复 → 快模型（Sonnet/Haiku 级）
- 系统自动判断当前步骤的复杂度，选择对应模型

### 5.7 可观测性

自主运行的系统如果不可观测，就是黑箱。用户不可能实时看对话流，需要结构化的监控。

**三层可观测性**：

1. **任务树 UI**（见 4.3）：节点状态、分支信息、点击展开详情——这是主界面
2. **结构化日志**：每个 AI 动作记录为结构化事件，不是自由文本
   ```
   { "time": "...", "node": "用户认证", "action": "edit_file",
     "file": "src/auth.ts", "result": "success", "tokens": 1200 }
   { "time": "...", "node": "用户认证", "action": "run_tests",
     "passed": 12, "failed": 1, "tokens": 800 }
   ```
3. **告警**：
   - 节点标记 stuck → 通知用户
   - 节点预算消耗 > 80% → 通知用户
   - 连续 N 次测试失败 → 通知用户
   - 长时间无进展（无新 commit 超过 30min）→ 通知用户

**定期报告**（可配置频率）：
- 已完成节点、进行中节点、阻塞节点
- 总 token 消耗 / 剩余预算
- 关键决策摘要（AI 做了哪些重要选择）
- 新增记忆条目

## 六、失败模式与防御

长时间自主运行的 AI 系统有已知的失败模式。提前识别，设计防御。

| 失败模式 | 表现 | 检测 | 防御 |
|---------|------|------|------|
| **无限循环** | 反复尝试同一个修复，永远过不了测试 | 同一错误出现 3+ 次；同一文件编辑 5+ 次 | 自动标记 stuck（断路器），父 agent 跳过处理其他任务 |
| **上下文污染** | 压缩丢失关键信息，AI 重复之前的错误决策 | 重复相同的失败路径；与记忆中的决策矛盾 | 记忆持久化在 git 中；压缩后强制重读 `.opengraft/memory.md` |
| **抽象层级错误** | AI 在实现细节上打转，没意识到是设计问题 | 一个节点内反复重构但测试不变；代码量增长但功能未增加 | 节点预算用尽时强制回退到规划阶段，重新分解 |
| **依赖地狱** | 引入互相冲突的库，或版本不兼容 | 安装依赖失败；类型错误来自第三方包 | 依赖变更需要 autonomy level 检查；lockfile 变更 diff 审查 |
| **镀金（Gold Plating）** | 功能已完成但 AI 不停优化、重构、加"改进" | 测试早已全绿但仍在提交；改动集中在非功能性方面 | Stimulus Generator 在全绿后进入收敛模式：只修 stuck 节点和质量门禁不通过的问题 |
| **分支漂移** | feature branch 存活过久，与 main 严重分化 | 分支存活 > 2 天；merge main 时冲突过多 | 自动提醒拆分；超过阈值则强制 merge 或重新规划 |

## 七、安全模型

系统能执行任意命令、修改文件、访问网络——必须定义安全边界。

**沙箱层级**：
- **文件系统**：AI 只能访问项目目录和指定的临时目录。不能读 `/etc/passwd`、`~/.ssh/` 等敏感路径
- **网络**：只允许访问包管理器（npm/pypi）、文档站点、搜索引擎。不能发任意 HTTP 请求（除非任务明确需要且 autonomy level 允许）
- **命令执行**：白名单机制。编译、测试、lint、git 直接允许。`rm -rf`、`curl | bash`、`sudo` 等需要显式授权
- **Git 操作**：push 到 remote 需要用户确认（除非 autonomy ≥ 8）。force push 永远需要确认

**元修改的安全**（第十二节相关）：
- AI 修改自身的 tool 实现 → 必须在 worktree 中执行 + 全量测试通过
- AI 修改自身的安全规则 → 永远需要用户确认，无论 autonomy level
- 安全规则本身是**不可被 AI 绕过的硬编码约束**，不是 prompt 中的"建议"

**架构保证**（见 4.2.1）：安全策略存储在 daemon 侧（`~/.opengraft-daemon/projects/{id}/security.yaml`），per project 配置，但不在项目 git 仓库内。AI 的文件系统访问被限制在项目目录——它物理上无法修改自己的安全规则。这不是靠 prompt 约束，是靠沙箱隔离。

## 八、实现路径

### Phase 0：最小循环（1-2 天）

证明 orchestration 逻辑能跑通。**不造轮子，用 Claude Code 作为执行引擎**。

```
1. 用 Claude Code headless（claude -p）或 Agent SDK 作为单个 agent 的执行层
2. 写一个最简 orchestrator：while loop + 硬编码任务 + 调用 agent
3. 任务："创建项目，实现 FizzBuzz 函数和测试"
4. agent 写代码 → 跑测试 → 结果回到 orchestrator → 判断是否完成
5. 不需要 task tree，不需要 context 管理，先证明 orchestrator → agent 循环能转
```

### Phase 1：任务分解（3-5 天）

AI 能把抽象目标分解成具体步骤并逐一执行。

```
1. 实现 Task Tracker（JSON 文件持久化）
2. System prompt 注入方法论（垂直迭代、测试优先）
3. 中等任务："实现一个 REST API with CRUD + 测试"
4. 观察分解质量和执行路径
```

### Phase 2：持续运行（1 周）

解决 context window 限制。

```
1. 实现 Context Manager（token 计数 + 压缩策略）
2. 实现 Stimulus Generator
3. 大任务，连续跑数小时
4. 验证压缩后不丢失关键信息
```

### Phase 3：复杂项目 + 代码质量门禁（2 周）

真实复杂度验证 + 防膨胀。

```
1. 完整项目需求（如：多人聊天应用 with WebSocket）
2. 加入质量门禁：复杂度检查、重复代码检测、架构审查
3. 观察：AI 是否在功能正确性之外也维护了架构一致性
4. 对比无门禁时的代码质量，量化改善
```

### Phase 4：自举切换（见第十一节）

### Phase 5：元可扩展（见第十二节）

## 九、方法论注入模板

系统 prompt 中应注入的核心规则：

```
你是一个自主编程系统。你通过实际执行代码来工作，不靠猜测。

## 工作流程

每实现一个功能：
1. 先问架构问题：放在哪个模块？需要新模块吗？有可复用的机制吗？
2. 写类型定义
3. 写测试（描述期望行为）
4. 写实现（用最简单的方式满足测试）
5. 运行测试 + typecheck + lint，全部通过
6. 审查 diff：有没有不必要的抽象？有没有重复代码？
7. 提交

## 测试原则

- 确定性靠构造：用条件等待不用固定延迟
- 每个测试自给自足：独立 setup/teardown
- 测试失败 = 代码有 bug，不是运气差
- 调试：加日志 → 看实际发生了什么 → 信任日志 → 修复

## 架构原则

- 加功能前先考虑放在哪里，不要创建不必要的新文件
- 三行重复优于一个只用一次的抽象
- 每个模块职责单一，通过事件/接口通信
- 纯函数优先，副作用隔离到边界

## 禁止事项

- 禁止猜测 API——先查文档或跑 --help
- 禁止说"这应该能工作"——跑了才知道
- 禁止怀疑框架——先怀疑自己的代码
- 禁止保留旧系统 fallback——替换就彻底替换
- 禁止用重试修复 flaky 测试——找根因
- 禁止不加日志就猜 bug 原因
- 禁止为一次性操作创建 helper 函数
```

## 十、成功指标与评估方法

### 门禁指标（必须达到）

- [ ] 给定中等任务，能自主产出可运行、有测试覆盖的代码
- [ ] 连续运行 4 小时不需要人工干预
- [ ] 测试覆盖率 > 80%，且零 flaky
- [ ] Context 压缩后能正确恢复工作进度
- [ ] 代码质量经人工审查可接受（结构清晰、类型安全、无不必要的抽象）
- [ ] 自举成功：系统运行在自身之上，功能无退化

### 量化追踪（持续度量）

定性 checkbox 不够——需要量化指标来判断系统在改进还是退化：

| 指标 | 含义 | 度量方式 |
|------|------|---------|
| **任务完成率** | passed / (passed + stuck) | 任务树统计 |
| **Token 效率** | 每个 passed 节点平均消耗的 token | 结构化日志聚合 |
| **首次通过率** | 节点一次 merge 成功（无 failed→retry）的比例 | 节点状态历史 |
| **分支寿命** | 从 checkout 到 merge 的平均时间 | git log 统计 |
| **回退率** | 被 `git branch -D` 丢弃的分支占比 | git reflog |
| **人工介入频率** | 用户回复 stuck/clarify 的次数 / 总节点数 | Task Tracker |
| **代码膨胀趋势** | 每个功能的平均新增行数是否随项目增长而增长 | git diff --stat |

**趋势比绝对值更重要**：Token 效率如果随项目增长而恶化，说明 context 管理或任务分解有问题。首次通过率下降说明方法论注入在退化。定期对比这些趋势，发现系统性问题。

## 十一、自举（Self-Bootstrapping）

### 11.1 什么是自举

系统成熟到一定程度后，后续开发 session 应该运行在系统自身之上，而不是依赖外部工具。这类似于编译器用自己编译自己（GCC、Rust）。

### 11.2 自举的风险

自举失败是**灾难性的**：如果 AI 在修改自身的过程中破坏了文件操作或命令执行能力，它就无法修复自己——因为修复也需要这些能力。这等价于"编译器编译出一个有 bug 的编译器，然后你只有这个有 bug 的编译器"。

### 11.3 安全切换协议

借鉴编译器 bootstrapping 的成熟实践（[GCC 三阶段构建](https://gcc.gnu.org/install/build.html)、[Rust bootstrap](https://rustc-dev-guide.rust-lang.org/building/bootstrapping/what-bootstrapping-does.html)、[Thompson's Trusting Trust](https://www.cesarsotovalero.net/blog/revisiting-ken-thompson-reflection-on-trusting-trust.html)）：

**阶段 1：双轨运行**
- 外部工具链（如 Claude Code）和自建系统同时可用
- 每个任务用两套系统各跑一次，对比结果
- 差异 = 自建系统的 bug，修到零差异

**阶段 2：切换前门禁**

必须全部通过才允许切换：
- [ ] 核心 tools 测试覆盖 100%：file read/write/edit、command execution、test runner
- [ ] 破坏性测试：故意制造文件写入失败、命令超时、磁盘满——系统能优雅降级而不是死锁
- [ ] 自修复测试：AI 被指令"在 edit_file 中引入一个 bug"→ 运行测试 → 检测到失败 → 定位并修复 bug → 测试恢复全绿
- [ ] 回退路径存在：永远保留从外部工具链启动的能力，切换后不删除

**阶段 3：渐进切换**
- 先把低风险任务（如文档生成、测试编写）迁移到自建系统
- 核心基础设施修改（tool 实现、orchestrator 逻辑）最后迁移
- 每次迁移后跑完整测试套件 + 人工验收

**铁律**：**永远不删除外部启动路径**。就像 Rust 保留 mrustc（C++ 写的独立 Rust 编译器）作为独立信任链一样，必须始终能从外部环境重建系统。

## 十二、元可扩展架构

### 12.1 目标

与 OpenClaw 等系统的最大差异：部署者的 AI 不仅**使用**系统，还能**改进**系统本身，并将改进通过 PR 回馈上游。这是一种让系统通过分布式 AI 实例持续进化的机制。

### 12.2 两层可扩展性

**第一层：插件体系**

插件适合标准化的扩展点：新增 tool、新增 stimulus 策略、新增质量门禁。

```
plugins/
├── tools/
│   ├── builtin/           # 内置 tools（file, terminal, test）
│   └── community/         # 社区/用户自定义 tools
├── stimuli/               # 自定义 stimulus 策略
├── quality-gates/         # 自定义质量门禁（复杂度、风格检查）
└── context-strategies/    # 自定义 context 压缩策略
```

接口约定：
```
interface ToolPlugin {
  name: string
  description: string          // LLM 读这个来决定何时调用
  parameters: JSONSchema       // 参数定义
  execute(params): Result      // 执行逻辑
  validate?(params): Error[]   // 可选：参数预验证
}
```

**第二层：直接修改系统自身**

插件体系的扩展能力有限——有些改进需要修改 orchestrator 逻辑、context 压缩策略、甚至 tool 调用协议。这些无法通过插件接口覆盖。

因此系统必须支持 AI 直接修改自身代码的能力。关键设计：

1. **系统自我文档**：系统的架构、模块职责、接口契约必须有机器可读的文档（类似 CLAUDE.md），AI 修改前先读这些文档理解当前架构
2. **修改 = 标准开发流程**：AI 修改系统代码和修改用户项目代码走完全相同的流程（类型 → 测试 → 实现 → 验证）
3. **自举测试套件作为安全网**：第十一节的所有门禁测试在每次自修改后都必须通过
4. **隔离验证**：自修改在独立分支/worktree 执行，通过所有测试后才合并

### 12.3 Worktree 热切换机制

自修改不能在运行中的实例上直接进行——改错了就死了。借鉴 git worktree 的隔离能力：

```
生产环境（main worktree）
    │  正常运行中
    │
    ├── AI 发现改进机会
    │
    ├── git worktree add /tmp/self-mod feature/improve-x
    │   └── 在 worktree clone 中修改、测试
    │
    ├── 在 worktree 中跑完整测试套件 + 自举测试
    │   ├── 失败 → 丢弃 worktree，生产环境不受影响
    │   └── 通过 ↓
    │
    ├── git merge feature/improve-x（或 rebase 到 main）
    │
    └── 重启/热重载生产实例
```

**关键**：生产实例在 worktree 测试期间正常运行，测试失败时零影响。这是和编译器自举的"三阶段构建"同源的思路——永远在安全的环境中验证，再切换。

### 12.4 版本号与上游 Rebase

部署实例的版本是 **上游版本 + 本地修改版本** 的组合：

```
1.2.3+0.0.1
  │       │
  │       └── 本地修改的语义化版本（自己的 patch stack）
  └────────── 上游版本（origin/main 的语义化版本）
```

**工作流**：
- 本地修改永远是 origin 之上的 patch stack（`git rebase origin/main`）
- 上游发布 `1.2.4` → 本地 rebase → 解决冲突 → 跑测试 → 版本变为 `1.2.4+0.0.1`
- 本地新增修改 → 本地版本递增 → `1.2.3+0.0.2`
- 本地修改被上游合并 → 从 patch stack 中移除 → 本地版本号可能归零

**好处**：
- 随时可以 `git rebase origin/main` 获取上游更新
- 本地修改和上游修改有清晰的边界
- 如果本地修改引入问题，可以逐个 revert patch 而不影响上游代码
- 上游可以通过 `+` 后面的版本号快速判断部署实例的定制程度

### 12.5 PR 回上游的机制

```
用户部署实例
    │
    ├── AI 发现改进机会（新 tool / bug fix / 性能优化）
    │
    ├── 在 fork 上创建分支（从 patch stack 中提取相关 commit）
    │
    ├── 实现改进（遵循项目方法论 + 测试覆盖）
    │
    ├── 本地验证：完整测试套件 + 自举测试
    │
    ├── 生成 PR：包含变更说明、测试结果、架构影响分析
    │
    └── 上游审查 → 合并/拒绝/要求修改
        └── 合并后：从本地 patch stack 中移除该 commit，rebase
```

**质量保证**：
- PR 必须包含测试（没有测试的 PR 自动拒绝）
- PR 描述必须说明架构影响（不只是"加了什么功能"，还有"放在哪里、为什么放在这里"）
- 上游可以设定自动化门禁（CI 跑通 + 复杂度不增加 + 无重复代码）

### 12.6 防止分化

当多个部署实例各自修改系统，分化风险很高。这是所有分布式扩展系统的核心难题（Android 碎片化、Linux 发行版分裂）。

**架构防御**：
- **核心 vs 扩展的清晰边界**：核心 orchestrator 逻辑尽量小且稳定，大部分功能通过插件或可配置策略实现。核心的 API 表面积越小，分化风险越低
- **接口稳定性承诺**：上游遵循语义化版本——patch 版本不破坏任何接口，minor 版本只增不删，major 版本才允许 breaking change。部署实例的 patch stack 只能依赖已承诺稳定的接口

**流程防御**：
- **定期 rebase**：部署实例定期从上游拉取更新。Rebase 频率建议 ≤ 1 周。越久不 rebase，冲突越多，分化越深
- **共享测试套件**：上游维护完整的兼容性测试，部署实例的自修改不能破坏这些测试。这是最硬的防线
- **上游跑部署实例的 patch**：上游 CI 可选地跑已知部署实例的 patch stack，提前发现 breaking change

**度量**：
- **Patch stack 大小**：本地 patch 数量。过多（>20）说明应该回馈上游或重新评估是否真的需要
- **与上游的 diff 量**：`git diff origin/main...HEAD --stat` 的行数。持续增长 = 正在分化
- **Rebase 冲突频率**：每次 rebase 的冲突文件数。持续增长 = 本地修改和上游方向不一致，需要沟通

## 十三、参考资料

### 自主编程 Agent 架构
- [Anthropic: Building Effective Agents](https://www.anthropic.com/research/building-effective-agents)
- [Anthropic: Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Anthropic: Context Engineering for AI Agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [OpenHands SDK Paper (arxiv 2511.03690)](https://arxiv.org/abs/2511.03690)
- [SWE-Agent Paper: Agent-Computer Interface (NeurIPS 2024)](https://arxiv.org/abs/2405.15793)
- [Aider: Repository Map Design](https://aider.chat/2023/10/22/repomap.html)
- [Aider: Edit Formats for LLMs](https://aider.chat/docs/more/edit-formats.html)

### 测试方法论
- [Martin Fowler: Eradicating Non-Determinism in Tests](https://martinfowler.com/articles/nonDeterminism.html)
- [Martin Fowler: The Practical Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html)
- [Software Engineering at Google Ch.11](https://abseil.io/resources/swe-book/html/ch11.html)
- [Google Testing Blog: Flaky Tests](https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html)
- [Luo et al. FSE 2014: Flaky Test Root Causes](https://mir.cs.illinois.edu/lamyaa/publications/fse14.pdf)

### 自举与 Bootstrapping
- [GCC: Installing GCC — Building](https://gcc.gnu.org/install/build.html)
- [Rust Compiler Bootstrap Guide](https://rustc-dev-guide.rust-lang.org/building/bootstrapping/what-bootstrapping-does.html)
- [Thompson's "Reflections on Trusting Trust"](https://www.cesarsotovalero.net/blog/revisiting-ken-thompson-reflection-on-trusting-trust.html)
- [Wheeler's Diverse Double-Compiling Defense](https://dwheeler.com/trusting-trust/)
- [mrustc: Alternative Rust Compiler for Bootstrapping](https://github.com/thepowersgang/mrustc)

### 代码质量与膨胀防控
- [GitClear 2025: AI Code Quality Research](https://www.gitclear.com/ai_assistant_code_quality_2025_research)
- [Sonar: Poor Code Quality in AI-Accelerated Codebases](https://www.sonarsource.com/blog/the-inevitable-rise-of-poor-code-quality-in-ai-accelerated-codebases/)

### Tool 设计
- [SWE-Agent ACI Documentation](https://swe-agent.com/0.7/background/aci/)
- [Anthropic Agents Cookbook](https://github.com/anthropics/anthropic-cookbook/tree/main/patterns/agents)
