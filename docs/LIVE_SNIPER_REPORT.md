# PropStein Live Sniper 交付报告（A–G）

**项目**: PropStein Pro 浏览器伴侣扩展（可见盘口情报层）
**分支**: `feat/live-sniper-foundation`（基于上游 `main` @ `c6789eb8`）
**日期**: 2026-10-30
**铁律**: 只做情报、绝不下单；不收集凭据；不绕过反爬；只分析可见盘口；不捏造数字——浏览器可见报价一律标注 OBSERVED。

---

## A — 审计结论

对 `NickAiNYC/Propstein`（1,208 个受控文件、324 个提交、Apache-2.0）的完整审计确立了三条基线事实。第一，PropStein 是一个真实运行的产品：FastAPI 后端（`api/main.py`，1,703 行，部署于 Railway）加纯前端量化终端（`viewer/`，部署于 Vercel，审计时点在线可验证），已具备多源赔率摄取、走前验证的全场接球模型、LangGraph 五门禁报警管线、SSE 推流、CLV 台账与回执链、Stripe 与 Whop 变现及服务端权益校验。第二，**主动屏幕盘口检测在整个仓库中不存在**——存量 Chrome 扩展只是终端的侧栏包装，没有内容脚本、没有 DOM 读取、没有鉴权，因此 Live Sniper 的检测层是全新建造。第三，最关键的负结论：**现有模型是全场口径**，仓库中不存在任何 possession 级概率模型、NFL 实时 play-by-play 数据源或驱动级校准语料，因此驱动级市场必须以"独立基线模型 + 诚实标注"的方式交付，在证据具备之前一律显示 NO MODEL COVERAGE。

审计同时给出了明确的复用/自建/不支持矩阵与安全发现 S-1…S-8（详见 `docs/LIVE_SNIPER_AUDIT.md`）。本分支逐一落实了与扩展相关的缓解：S-1（市场端点公开）→ 新 `/api/v1/markets/*` 全部服务端鉴权；S-2（客户端可伪造等级）→ 面板仅渲染服务端验证的权益；S-3（长效未作用域 Bearer）→ 15 分钟作用域令牌；S-4（陈旧 host 权限）→ 全新最小权限清单；S-6（共享内部密钥）→ 按会话令牌与限流。

## B — 架构与交付物

交付物是一个 TypeScript monorepo（`extensions/`）加一个附加式 FastAPI 路由（`api/extension_router.py`，对 `api/main.py` 的改动仅两行 include，保持评审可回滚）。四个包各司其职：`@propstein/core` 承载市场类型、赔率数学、归一化器、匹配器、DRIVE-REC-V1 模型、新鲜度引擎、信号状态机与生命周期注册表，是纯函数库、零平台依赖；`@propstein/detection` 承载视口可见性过滤、自适应批量 MutationObserver 差分器（16–200ms 自适应批窗）与适配器注册表；`@propstein/browser` 承载源校验消息协议、不可信载荷验证与按源站点授权模型；`@propstein/ui` 是 React 终端面板（信号卡、权益门、状态视图、设置页）。Chrome MV3 应用（`apps/chrome`）包含后台 service worker、隔离世界只读内容桥与侧栏/伴侣页；`demo/demo-sportsbook.html` 提供合成 KC–NE 实时盘口夹具（含变价、停牌、驱动切换、复位的情景控制钮与 2 秒心跳）；`scripts/build.mjs` 用 esbuild 产出生产/开发/伴侣三份构建。

数据流是单向的：**可见 DOM → 只读内容桥（事件合并成批）→ 适配器（版本化选择器、置信度评分）→ ObservedMarket 规范模式 → 归一化 → 匹配 → DRIVE-REC-V1 → 信号状态机 → 面板**。服务端契约（会话签发、撤销、健康/开关、模型覆盖、评估）与扩展的 `model-provider.ts` 逐字段对齐。

## C — 定价数学与验证

赔率数学与规范 §7 逐条对齐并经 109 个单元测试锁定：美式 +160 → 小数 2.60 → 盈亏平衡 1/2.60 = 38.46%；EV（单位本金）= p(d−1) − (1−p) = pd − 1；概率边际 = p − 1/d；公平小数 = 1/p。决策使用**不确定性 haircut 后**的 EV（将 p 相对盈亏平衡的边际收缩 2%），进入阈值 +5%、退出阈值 +3%（滞回），报警冷却 30 秒。

驱动级接球模型 DRIVE-REC-V1 采用吸收式驱动终止闭式：P = q·(1−(s(1−q))^N)/(1−s(1−q))，其中 q 为单次进攻回合接球概率、N 为剩余进攻回合数投影、s 为驱动存活率。该式在 s=1 时退化为规范基线 1−(1−q)^N，并以 Python/TypeScript 双实现数值对齐（误差 < 1e-9）验证。合成演示参数经数值反解精确命中规范工作例：Kelce q=0.1841、N=8、s=0.72 → P=0.4399，在 +160 上显示 44.0% 模型概率、+14.4% EV（ALERTABLE）；点击变价至 +115 后同一信号即时重算为盈亏平衡 46.51%、EV −5.4%（BELOW_THRESHOLD）——这正是关键测试一的完整数字链。校准纪律执行 200 样本门限：样本不足时置信标签为 insufficient_evidence 或 uncalibrated，绝不出现虚构的校准置信。

## D — 检测系统与适配器策略

检测层的核心承诺是**只分析用户看得见的盘口**。共享可见性谓词在解析前过滤掉所有不与活动视口相交的卡片（虚拟列表与屏外卡片不进入管线）；受监听标签页失焦即暂停观察；桥接层在隔离世界运行且不包含任何点击/提交代码路径。变更检测不轮询整页：MutationObserver 记录按自适应批窗聚合后做集合差分，产出 ADDED / ODDS_CHANGED / LABEL_CHANGED / STATUS_CHANGED / SUSPENDED / REMOVED / NAVIGATED 七类事件。本次联调发现并修复的关键缺陷具有教科书意义：**逐条发送事件时，驱动切换产生的 REMOVED(旧驱动)+ADDED(新驱动) 会与后台的驱动上下文采纳发生竞态**，导致旧驱动信号被静默 remove() 而非 driveEnded() 撤销；桥接层现以 40ms 合并窗将一个切换原子化为单批消息，后台在任何批次内先采纳盘口当前驱动上下文再处理撤销。

适配器采用授权门控模型：demobook（合成夹具）是唯一开启的适配器，DraftKings / FanDuel / Polymarket 均以特性开关关闭的骨架形式存在——启用是运维动作（书面授权 + 30 份快照选择器验证 + 误解析炮弹测试 + kill-switch 版本接线 + 灰度），绝非代码默认值。选择器集合带版本号并贯穿到撤销原因中，设计目标是"坏选择器必须响亮地失败（撤卡）而非安静地失败（错价）"。Polymarket 优先走已授权的 Gamma/CLOB API 而非 DOM。

## E — 安全、隐私与合规

安全模型的支点是**处处 fail-closed**，不存在任何 fail-open 路径：会员资格不可验证 → 会话签发 503、无模型数据；作用域令牌过期/篡改/撤销 → 市场路由 401、面板锁定 SESSION_EXPIRED；服务端 `EXTENSION_KILL_SWITCH=1` → 健康报告 disabled、受保护路由全部 503；报价超过新鲜度上限（实盘 20 秒）→ STALE 撤销；市场停牌 → SUSPENDED 撤销；驱动结束 → 该驱动全部信号撤销；适配器置信度低于 0.6 → UNVERIFIED、永不报警。会话令牌为 HMAC-SHA256 签名（exp/iat/jti），15 分钟 TTL，按 jti 可撤销，签发前必须通过服务端 Whop 权益校验，签发按主体限流（滑动窗 10 次/分钟，429）。生产环境未配置 `EXTENSION_SESSION_SECRET` 时签发 503——绝不静默降级。

隐私面：观察到的市场 DOM 与信号快照**从不离开浏览器、从不落盘**；唯一凭据是用户主动粘贴的 PropStein 会员令牌（仅在 HTTPS 下向自家 API 换取作用域令牌，绝不进 URL 查询串）；无遥测、无崩溃上报、无第三方脚本。权限清单按 Chrome Web Store 审核标准逐项论证（storage/scripting/tabs/sidePanel），host 权限**安装时零申请**，运行时按源经用户动作授予。内容桥对所有页面数据按不可信输入处理：长度钳制、控制字符剥离、200 事件上限、字段级消毒。合规姿态与上游一致：DK/FD 球员道具数据在本仓库中本就经由授权的 PropLine 商业 API 获取，DOM 适配器仅为"用户正在看的那个价格"的显示上下文增强，且处于授权门控之下。

## F — 测试证据

测试金字塔共 163 个自动化用例，全部在本环境实测通过：

| 套件 | 数量 | 覆盖 |
|---|---|---|
| 单元（node --test，TS 原生） | 109 | 赔率数学精确值（38.46%/+14.4% 等）、归一化、匹配、DRIVE-REC-V1 数值、新鲜度、状态机全部转移路径、生命周期滞回/去重 |
| 集成（linkedom 夹具） | 24 | 可见性过滤、自适应批处理、七类变更事件差分、DemoBook 解析表 |
| 端到端（Playwright + 真实 Chromium 加载真实 MV3 扩展） | 6 | 规范 §15 关键场景：+160→+115 重算转 BELOW_THRESHOLD、停牌撤销、驱动结束全量失效（四卡渲染 DRIVE ENDED）；另含面板引导与停止监测 |
| 服务端（pytest） | 24 | Whop 三路径、令牌篡改/过期/错计划/撤销、kill switch、限流、覆盖诚实性、与 TS 核心的公式奇偶校验、附加挂载验证 |

四个关键场景在单元与端到端两层均有断言，且端到端层验证的是**真实浏览器、真实扩展加载、真实 DOM 变更**下的行为（含发现的桥接合并缺陷的回归覆盖）。对既有测试零回归：`tests/` 目录 70 通过 + 2 跳过 + 7 失败，经 stash 对照验证该 7 项失败为沙箱缺少 langgraph 等重型依赖的预存环境问题，与本分支无关。

## G — 交付物使用与路线图

**运行**：`cd extensions && npm install && npm run typecheck && npm run test:core`；`npm run build` 产出 `dist/propstein-chrome`（生产清单）、`dist/propstein-chrome-dev`（含 localhost host 权限，供演示与 e2e）、`dist/propstein-web-companion`。`npm run demo` 起 4173 合成盘口；`APP_ENV=development PROPWIRE_ALLOW_DEV_AUTH_BYPASS=1 uvicorn api.main:app` 起开发后端；`chrome://extensions` → 加载已解压扩展 → 打开夹具页 → 侧栏 SIGN IN（开发旁路接受任意非空令牌）→ START MONITORING。生产部署需配置 `WHOP_API_KEY`、`EXTENSION_SESSION_SECRET`，并把打包后的 `chrome-extension://<id>` 源加入 `ALLOWED_ORIGINS`（审计 S-5 运维动作）。

**Phase 2（生产接线）**：后台的 `RemoteApiModelProvider` 与新端点契约已逐字段对齐，剩余工作是将会话令牌接入 `getSessionToken` 并以远程覆盖替换演示模型——一天量级的接线，不涉及新设计。**Phase 3（授权实盘）**被两个只有所有者能解的外部依赖阻塞：获得 possession 级 NFL 实时数据源（或书面确认以 DK/FD 页面观测为模型输入），以及对页面级 DOM 检测的书面授权；在此之前真实书源一律 NO MODEL COVERAGE，这正是诚实性设计的用意。**Safari**：转换指南（`docs/LIVE_SNIPER_SAFARI.md`）列明 API 兼容清单、`storage.session` 垫片与侧栏替代（伴侣页复用同一面板 bundle），核心/检测/UI 三包零平台依赖，转换风险集中在后台垫片一项。**质量路线**：校准语料到达后跑 DRIVE-REC-V1 的 Brier/log-loss/可靠性曲线（模块已内置，200 样本门限强制生效），选择器验证按 `docs/LIVE_SNIPER_ADAPTERS.md` 清单执行。
