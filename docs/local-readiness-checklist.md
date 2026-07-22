# 本地完善清单

这份清单用于在不上 GitHub、不触发真实模型费用的前提下，把项目从“能演示”推进到“更接近可内测”。它不能替代心理、医学、法律或产品安全审查。

## 当前本地状态（2026-07-22）

- `npm run preflight:local`：已通过；其中敏感信息扫描、28 个单元测试、生产构建、普通对话 40 条评测和安全 24 条评测均通过。
- `npm run e2e:browser`：已通过，当前 Chromium 6/6 个浏览器用例。
- Playwright 依赖和 Chromium 浏览器二进制已在本机安装；换新机器或清理缓存后仍需重新安装浏览器二进制。
- 首页和聊天页已展示本地会话、真实模型转发、默认不保存对话正文、非诊断/非治疗和紧急危险边界。
- `docs/review/knowledge-review.*` 已导出知识审校工作表；当前 45/45 条仍为 `unreviewed`。
- `eval:model` 本次未运行；文档保留的上一次结果为 12/12 通过，再次运行仍需要真实 API Key，并可能产生费用。

当前阻塞公开试用的主要事项仍是：专业知识审校、真实模型样例人工复核、隐私/数据处理决策、人工升级路径和部署运维设计。

## 本地预检

运行：

```bash
npm run preflight:local
```

该命令会：

- 使用 `.env.example` 和空 API key 强制启动 mock 后端。
- 关闭限流，避免评测流量被 20 次/分钟规则截断。
- 运行乱码扫描、知识库结构检查、知识库审计、知识匹配评测、知识上下文边界评测、人工体验用例评测、单元测试和生产构建。
- 启动生产构建后的本地服务，检查首页 HTML、JS/CSS 资源、SPA fallback、普通聊天 API 和流式 NDJSON 合同。
- 自动启动本地 mock API，并跑普通对话评测和安全评测。

该命令不会：

- 调用真实 OpenAI-compatible 模型。
- 证明知识内容有效。
- 证明危机识别足够可靠。
- 覆盖真实浏览器交互、移动端视觉和可访问性；这些仍需要 Playwright 或等价浏览器 E2E。
- 处理部署、隐私政策、数据保留或人工升级流程。

## 每次改动后的最低检查

小改动，例如文案、CSS、单条知识卡：

```bash
npm run check:secrets
npm run check:mojibake:strict
npm run knowledge:all:check
npm test
npm run build
```

涉及知识匹配、prompt、安全规则、mock 回复或模型配置：

```bash
npm run preflight:local
```

涉及真实模型：

```bash
npm run eval:model
```

`eval:model` 可能产生费用，并且结果会随模型版本和服务商变化。运行前应确认 `.env` 中的 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 和 `OPENAI_MODEL` 是本次想测试的配置。

## 浏览器 E2E

当前浏览器 E2E 脚手架位于：

```text
playwright.config.js
tests/e2e/chat.spec.js
scripts/start-e2e-server.js
```

运行命令：

```bash
npm run e2e:browser
```

该命令需要先安装 Playwright 依赖和浏览器二进制：

```bash
npm install -D @playwright/test
npx playwright install chromium
```

这些安装步骤需要网络，并且会下载较大的浏览器文件。E2E 服务会自动使用 mock 模式、关闭限流，并在运行前构建生产产物。

当前 E2E 覆盖：

- 首页隐私和安全边界提示。
- 首页进入聊天。
- 发送消息并渲染流式 mock 回复。
- 流式请求失败时回退到普通 `/api/chat`。
- 429 限流响应不重复请求普通接口。
- 清空当前浏览器会话。
- debug payload 不写入 `sessionStorage`。

这仍不等同于专业可用性测试。移动端视觉、可访问性、跨浏览器差异和真实模型输出仍需要单独检查。

## 上线前必须补的人工工作

1. 知识内容审校

   `npm run knowledge:audit` 只能检查结构和明显边界。正式使用前，`server/knowledge` 里的 issue types、mechanisms、interventions 和 safety 内容需要由合格专业人员逐条审阅，并记录审阅人、日期、结论和修改意见。

   本地审校材料可以这样维护：

   ```bash
   npm run review:knowledge:export
   npm run review:knowledge:validate
   npm run review:knowledge:validate:strict
   ```

   `review:knowledge:export` 生成 `docs/review/knowledge-review.json`、`.csv` 和摘要；JSON 是可校验的主工作表，CSV 适合表格查看。`validate` 允许仍有未审校条目但会提示；`validate:strict` 会把任何未填写的审校决定、审校人、日期、检查项或必要修改说明视为失败。

2. 回复样例人工复核

   使用 `evals/human-review-template.md` 复核代表性回复，重点看：

   - 是否过度分析或像报告。
   - 是否暗示诊断、治疗或效果承诺。
   - 是否尊重用户边界和精力。
   - 高风险回复是否足够直接、具体、可执行。
   - 是否需要补充地区化求助资源。

3. 标注风险测试集

   现有安全评测是规则回归集，不是完整危机识别评估。后续需要扩展标注数据，至少覆盖：

   - 明确自伤、自杀、伤人和无法保证安全。
   - 否定表达，例如“我没有自杀想法”。
   - 口语夸张和技术语境误报。
   - 多轮对话里逐渐出现的风险。
   - 不同地区、年龄段和表达习惯。

4. 隐私和数据处理

   当前前端把会话存在 `sessionStorage`，后端安全日志只记录白名单字段。公开试用前仍需明确：

   - 是否保存服务端对话正文。
   - 日志保留期限和访问权限。
   - 是否用于模型训练或质量分析。
   - 用户如何清除、导出或撤回数据。
   - 未成年人和高风险场景的处理边界。

5. 人工升级路径

   这个项目目前没有真人介入能力。公开使用前需要明确：

   - 高风险时是否只展示紧急资源，还是允许转人工。
   - 谁接收升级通知。
   - 响应时限和责任边界。
   - 不同地区紧急电话、热线和医院急诊信息如何维护。

6. 部署和运维

   当前限流是单进程内存限流，只适合 Demo。公开部署至少还需要：

   - 网关或反向代理层限流。
   - 正确的可信代理和客户端 IP 处理。
   - 健康检查、错误率、延迟和费用监控。
   - API key 轮换和权限隔离。
   - 安全日志存储和告警策略。

## 本地状态记录模板

每次准备内测前，建议记录一次：

```text
日期：
代码版本或压缩包名称：
运行命令：
preflight:local 结果：
知识库 audit 警告：
真实模型配置：
eval:model 是否运行：
人工复核样例数量：
阻塞问题：
允许进入下一阶段：是 / 否
负责人：
```
