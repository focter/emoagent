# AI 心理健康觉察对话 Demo

一个使用 React + Vite 和 Node.js + Express 实现的网页端 Demo。它通过自然对话帮助用户整理情绪、压力和身心变化，不提供医疗诊断、心理治疗或药物建议。

> **项目状态：本地演示 / 研究原型。** 当前可以无密钥运行和测试，但专业知识审校、危机升级、隐私合规与生产运维尚未完成，不应直接面向公众部署。请先阅读 [项目进展与已知缺口](PROJECT_STATUS.md) 和 [安全与隐私说明](SECURITY.md)。

## 当前状态速览

- 已完成前后端聊天链路、流式输出、OpenAI-compatible 接入、无密钥 mock、本地知识匹配、高风险规则分流、基础限流与自动评测。
- 45 条运行时知识仍全部待专业审校；规则评测通过不代表临床有效或合规。
- 当前没有真人危机升级、地区化资源维护、身份认证、生产级配额与监控。
- `.env` 默认不会进入 Git，CI 和 `npm run check:secrets` 会检查准备提交的文件；真实密钥绝不能放进前端 `VITE_*` 变量。

## 功能

- 简洁的介绍首页和响应式聊天页面
- 聊天记录仅保存在当前浏览器的 `sessionStorage`
- `POST /api/chat` 普通聊天接口和 `POST /api/chat-stream` 流式聊天接口
- OpenAI-compatible Chat Completions API
- 前端实时追加流式内容，流失败时自动回退普通接口
- 可配置的单进程内存限流
- 未配置 API Key 时自动使用知识库驱动的 mock 回复
- 本地 JSON 知识库支持问题类型识别、信息充分度判断、心理机制选择和动态 prompt
- 后端高风险关键词优先分流，不将明显风险内容交给普通对话 prompt
- 一键清空当前会话

## 运行环境

- Node.js 22 LTS 或 24 LTS（推荐 24；`.nvmrc` 已固定主版本）
- npm 10+

## 本地启动

```bash
npm install
npm run dev
```

浏览器打开 <http://localhost:5173>。开发模式会同时启动：

- Vite 前端：`http://localhost:5173`
- Express 后端：`http://localhost:3001`

没有 `.env` 或没有填写 `OPENAI_API_KEY` 时，接口会自动返回 mock 内容，可以直接演示首页、聊天、知识库分类、自然追问和高风险安全提示。

## 配置模型

复制环境变量示例：

```bash
copy .env.example .env
```

macOS / Linux 使用：

```bash
cp .env.example .env
```

编辑 `.env`：

```dotenv
OPENAI_API_KEY=your-api-key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o-mini
OPENAI_TEMPERATURE=0.4
OPENAI_TIMEOUT_MS=30000
PORT=3001
ENABLE_SAFE_LOG=true
RATE_LIMIT_ENABLED=true
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=20
```

接口使用 OpenAI-compatible 的 `POST {OPENAI_BASE_URL}/chat/completions` 格式。基础地址不要包含 `/chat/completions`。

- OpenAI：`OPENAI_BASE_URL=https://api.openai.com/v1`，模型名填写账号可用的模型。
- DeepSeek：`OPENAI_BASE_URL=https://api.deepseek.com`，`OPENAI_MODEL` 填写 DeepSeek 当前支持的兼容模型名。
- 其他兼容服务：填写服务商提供的 OpenAI-compatible 基础地址、模型名和 API Key。

`OPENAI_TEMPERATURE` 默认 `0.4`，`OPENAI_TIMEOUT_MS` 默认 `30000`。原有的 `LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL`、`LLM_TEMPERATURE` 和 `LLM_TIMEOUT_MS` 仍可使用；同一配置同时存在时优先使用 `OPENAI_*`。

`.env` 已加入 `.gitignore`，不要提交真实密钥。

## 本地知识库

知识库位于 `server/knowledge/`，2.0 继续使用本地 JSON 文件，不需要数据库或向量服务。

来源原文、证据卡和决策卡位于 `knowledge_sources/` 与 `knowledge/`，它们是内容治理主线；`server/knowledge/` 是实际聊天使用的投放层。扩充顺序、质量门槛和当前缺口见 [`docs/knowledge-expansion-roadmap.md`](docs/knowledge-expansion-roadmap.md)。

| 路径 | 作用 |
| --- | --- |
| `issue_types/` | 定义问题类型、常见表达、优先追问、相关机制和升级信号 |
| `mechanisms/` | 定义心理机制、适用与不适用条件、通俗解释和安全小行动 |
| `interventions/` | 定义最多注入一个的心理教育式微干预及其安全边界 |
| `safety/` | 定义 level_0 至 level_4 风险等级和分级危机回应 |
| `source_registry.json` | 登记来源 ID、类型、链接、用途和最后检查日期 |
| `index.json` | 定义知识库版本、集合位置和最低数量 |
| `question_strategy.json` | 定义信息不足时的判断依据、追问优先级和问题数量限制 |
| `response_rules.json` | 定义对话风格、身份边界、禁止表达和建议约束 |

`server/knowledgeLoader.js` 负责自动扫描目录、校验必填字段和跨条目引用，并按文件修改时间缓存知识库。开发过程中修改 JSON 后，下次请求会自动重新加载；旧版访问对象形状仍保留兼容。

`server/prompt.js` 使用可解释的关键词评分和上下文匹配：最多选择两个相关问题类型；只有用户描述足够具体时，才最多选择两个心理机制。它不会把整份知识库全部放入 prompt，也不会把内部分类结果展示给用户。

### 扩展知识库

增加问题类型、机制或微干预时：

1. 在对应目录增加一条具有唯一 `id` 的 JSON 记录。
2. 为记录添加具体、克制的 `keywords`，避免使用过宽的单字词。
3. 补全对应类型的必填字段、`source_level` 和 `review_status`。
4. 问题类型与机制、机制与微干预之间使用已登记的 ID 关联。
5. 在 `server/knowledge.test.js` 中增加正例、容易误判的反例和安全边界测试。
6. 运行 `npm run knowledge:audit`、`npm test` 和 `npm run eval`。

### 知识库审校检查

```bash
npm run knowledge:audit
```

该命令以只读方式检查知识库目录结构、`review_status`、`source_level`、来源 ID 引用、问题类型与机制关联、微干预中的明显治疗承诺，以及 level_2 至 level_4 的必要安全要素。它会输出条目数量、审校状态分布、来源层级分布和问题列表；结构、安全或无效引用问题会返回退出码 1，尚未审校的条目只产生 WARN。

此脚本不是心理学、医学、法律或产品安全的专业审查，也不能证明知识内容有效。它只用于发现结构、来源登记和明显风险表达问题，正式使用前仍需合格专业人员逐条审校。

JSON 关键词匹配只是第一版可解释基线。正式产品应使用经过审核的数据集持续评估召回率和误报率，而不是单纯增加关键词数量。

## 请求处理流程

```text
用户最新消息
  → safety_rules.json 高风险检查
  → 高风险：直接返回固定安全回应
  → 非高风险：加载本地知识库
  → 判断描述是否笼统并选择问题类型、心理机制
  → 构建本轮动态 system prompt
  → 有 API Key：调用兼容模型
  → 无 API Key：使用同一分类结果生成 mock 回复
```

安全检查位于普通知识检索和模型调用之前。明显高风险输入不会进入普通心理机制分析。

## 接口

### `POST /api/chat`

请求示例：

```json
{
  "messages": [
    { "role": "user", "content": "我最近很烦" }
  ]
}
```

普通响应：

```json
{
  "reply": "我听见你最近不太好受……",
  "safety": false,
  "mode": "mock"
}
```

当最新一条用户消息命中高风险规则时，后端直接返回安全回应，`safety` 为 `true`，不会加载普通对话知识或调用外部模型。

### `POST /api/chat-stream`

请求体与 `/api/chat` 相同，但响应使用 `application/x-ndjson` 流。后端把 OpenAI-compatible API 的 SSE 统一转换为以下事件：

```json
{"type":"meta","safety":false,"mode":"mock"}
{"type":"delta","content":"我听见"}
{"type":"delta","content":"你最近……"}
{"type":"done"}
```

- 无 API Key 时，mock 回复会被拆成短文本片段并以小间隔发送，用于本地演示逐步显示效果。
- 有 API Key 时，后端以 `stream=true` 请求模型，并转发模型的增量内容。
- 高风险输入不会调用模型，固定安全回应也通过同一流协议返回。
- 流建立前的错误使用普通 JSON 和对应 HTTP 状态返回；流建立后的中断通过 `error` 事件返回。

网页默认优先使用流式接口，把内容实时追加到当前 AI 气泡。如果流式请求、解析或连接中断，网页会自动调用 `/api/chat` 获取完整回复；429 限流响应不会重复请求，而是直接提示用户稍后再试。

### `GET /api/health`

返回服务状态、模型是否配置、模型名、是否为 mock、流式能力、限流开关以及知识库加载状态。不会返回 API Key 或 Base URL。

## 测试、构建与生产运行

```bash
npm test
npm run check:secrets
npm run knowledge:audit
npm run build
npm start
```

构建后 Express 会同时提供 `dist` 静态页面和 API，默认访问 <http://localhost:3001>。

### Knowledge context diagnostics

The read-only knowledge context path is guarded by environment variables and is disabled by default:

```dotenv
KNOWLEDGE_CONTEXT_ENABLED=false
KNOWLEDGE_CONTEXT_DEBUG=false
KNOWLEDGE_CONTEXT_PROMPT_ENABLED=false
```

Useful development checks:

```bash
npm run eval:knowledge
npm run eval:knowledge:integration
npm run eval:knowledge:manual
npm run eval:knowledge:prompt-boundary
npm run check:mojibake
```

`KNOWLEDGE_CONTEXT_PROMPT_ENABLED` should stay off by default. When enabled, prompt context is allowed only for non-high-risk context with `ordinary_interventions_allowed=true`; high and critical context remain debug-only and existing safety routing remains authoritative.

## 目录结构

```text
.
├─ server/
│  ├─ knowledge/
│  │  ├─ issue_types/
│  │  ├─ mechanisms/
│  │  ├─ interventions/
│  │  ├─ safety/
│  │  ├─ index.json
│  │  ├─ source_registry.json
│  │  ├─ question_strategy.json
│  │  ├─ response_rules.json
│  │  └─ 旧版兼容 JSON
│  ├─ index.js             # Express、模型调用和请求流程
│  ├─ knowledgeLoader.js   # JSON 读取、校验和缓存
│  ├─ knowledge.test.js    # 知识库与分流测试
│  ├─ logger.js            # 字段白名单式脱敏日志
│  ├─ modelConfig.js       # 统一模型配置和旧变量兼容
│  ├─ mock.js              # 知识库驱动的 mock 回复
│  ├─ prompt.js            # 分类、充分度判断、机制选择和动态 prompt
│  ├─ rateLimiter.js       # 进程内请求来源限流
│  ├─ safety.js            # 安全规则读取与高风险分流
│  └─ streaming.js         # NDJSON 输出和模型 SSE 解析
├─ evals/
│  ├─ cases.json
│  ├─ model-smoke-cases.json
│  ├─ run-evals.js
│  ├─ run-model-smoke.js
│  ├─ human-review-template.md
│  └─ human-review-sample.json
├─ scripts/
│  ├─ audit-knowledge.js   # 只读知识库结构、来源与风险表达检查
│  └─ check-secrets.js     # 不回显值的提交候选敏感信息扫描
├─ src/
│  ├─ App.jsx
│  ├─ main.jsx
│  └─ styles.css
├─ .env.example
├─ PROJECT_STATUS.md
├─ SECURITY.md
├─ index.html
├─ package.json
└─ vite.config.js
```

## 基础限流

公开试用会面临误操作、自动脚本和短时间重复提交。基础限流可以减少模型费用失控和单一来源占满服务的风险，但不能替代网关、防火墙或成熟的滥用防护。

本项目使用进程内内存按请求来源计数，不需要数据库。`/api/chat` 和 `/api/chat-stream` 共享同一个计数窗口：

```dotenv
RATE_LIMIT_ENABLED=true
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=20
```

上述配置表示每个请求来源每分钟最多发起 20 次聊天请求。超过限制返回 HTTP 429 和温和提示。设为 `RATE_LIMIT_ENABLED=false` 或不配置时关闭限流。

内存限流只适合单进程 Demo：服务重启后计数会清空，多进程或多实例之间也不共享状态。部署在反向代理后，需要根据实际网络结构正确处理可信代理和客户端 IP，不能直接信任客户端提供的任意转发头。

完整运行 40 条本地评测时，应使用 `RATE_LIMIT_ENABLED=false` 启动测试后端，避免评测请求触发公开试用的每分钟上限。

## 自动评测与人工复核

自动评测和人工复核解决的问题不同，不能相互替代：

- `npm run eval` 会调用真实 `/api/chat`，批量检查禁止表达、高风险分流、笼统输入追问、问题数量和回复长度等可程序化规则。它适合频繁回归和后续 CI。
- `npm run eval:safety` 专门检查 level_1 至 level_4、伤人风险和技术/作业夸张表达误报；level_3 与 level_4 还会强制检查立即安全确认、可信任的人、紧急服务和远离危险物品。
- `npm run eval:model` 专门检查真实 OpenAI-compatible 模型。它会先确认健康检查显示真实模型已配置；未配置时直接以非零状态退出，不会把 mock 结果当成通过。
- `npm run review:human:score` 会为 [人工复核样例](evals/human-review-sample.json) 填入自动规则检查和产品体验初筛分，但不会生成专业审校结论。
- [人工复核模板](evals/human-review-template.md)把复核拆成三层：自动规则检查、产品体验初筛、专业审校必填项。普通试用者不应被要求给临床准确性、危机干预充分性或合规性打分。
- [人工复核样例](evals/human-review-sample.json)提供 10 条覆盖笼统输入、自责、焦虑、家庭压力、亲密关系和高风险内容的代表性记录。`professional_review_required` 中的字段在公开试用前仍需合格专业人员复核。

运行自动评测前先启动后端：

```bash
npm run dev:server
npm run eval
npm run eval:safety
# 配置真实模型并重启后端后：
npm run eval:model
```

`npm run eval` 是稳定、可重复的 mock/普通接口基线；`npm run eval:model` 会产生真实模型调用费用，回复也可能随模型版本发生波动。真实模型 smoke test 只检查明显边界和接入状态，不代表心理专业质量评估。

建议在修改知识库、prompt、安全规则或模型配置后先跑自动评测，再从 `eval:model` 输出中选择代表性回复，复制到 `evals/human-review-sample.json` 对应记录的 `model_response`，然后运行 `npm run review:human:score`。脚本结果只能作为初筛；涉及心理学准确性、安全风险、危机回应、隐私和合规的结论必须留给专业复核。人工材料必须去除真实姓名、电话、住址、学校、公司等身份信息。

## 最小脱敏日志

在 `.env` 中显式配置以下内容后，后端会为每次 `POST /api/chat` 或 `POST /api/chat-stream` 输出一行结构化 JSON：

```dotenv
ENABLE_SAFE_LOG=true
```

未配置或设为 `false` 时，不输出请求脱敏日志。日志仅包含：

- 时间以及 `/api/chat` 或 `/api/chat-stream` 路由；
- 是否为流式请求；
- 是否命中 safety；
- 匹配到的问题类型 ID 和心理机制 ID；
- `mock` 或 `api` 运行模式；
- 响应耗时、是否被限流和是否报错。

日志不记录完整用户输入、完整模型回复、API Key、姓名、联系方式或其他用户身份信息。问题类型和机制 ID 仍属于可能需要保护的产品数据；正式部署时应继续设置最短保留期限、访问权限和安全的日志存储位置。

## 安全边界

当前高风险识别是关键词分流，适合 Demo，不应被视为完整的危机识别系统。它可能出现漏报，也可能在否定表达中误报。真实模型测试通过也不代表医学或心理专业审核通过。正式上线前至少还需要：专业人员审核知识内容和回复样例、经过标注的风险测试集、上下文语义分类、不同地区求助资源适配、人工升级路径、安全测试、隐私政策和合规评估。

## 许可证

本项目尚未选择代码许可证。公开到 GitHub 不等于自动授予复制、修改或再分发许可；在仓库所有者明确添加许可证前，请先联系所有者确认。`knowledge_sources/raw/` 的本地第三方网页快照默认不会提交，来源登记中的外部资料仍受各自条款约束，不因未来的代码许可证而改变。
