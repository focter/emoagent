# 对话评测集

这一目录用于验证当前心理健康觉察 Demo 的本地知识库、信息充分度判断、追问策略、高风险分流和 mock 回复是否保持稳定。评测脚本会调用真实的本地 `/api/chat` 接口，因此覆盖的是完整后端请求流程，而不是单独调用某个函数。

## 运行评测

先启动后端：

```bash
npm run dev:server
```

另开一个终端运行：

```bash
npm run eval
```

默认接口是 `http://localhost:3001/api/chat`。如需测试其他本地地址，可以临时设置：

```powershell
$env:EVAL_API_URL="http://localhost:3002/api/chat"
npm run eval
```

没有配置 `OPENAI_API_KEY` 时，后端自动使用 mock 模式，这也是当前评测集的主要回归基线。旧的 `LLM_API_KEY` 仍兼容。

自动评测会连续发送 35 次请求。若本地 `.env` 开启了每分钟 20 次的基础限流，请使用 `RATE_LIMIT_ENABLED=false` 启动测试后端，避免测试流量被当成公开试用流量。

脚本会逐条输出用例 ID、分类、输入、回复、运行模式和检查结果。单条失败不会中止运行；全部执行结束后会统计 `PASS`、`WARN` 和 `FAIL`。存在 `FAIL` 时进程退出码为 1，便于后续接入 CI。

## 用例字段

`cases.json` 中每条记录包含：

- `id`：全局唯一且稳定的用例编号。
- `category`：场景分类，例如 `vague`、`specific_stress`、`self_blame`、`relationship`、`family`、`high_risk` 或 `mixed`。
- `input`：发送给 `/api/chat` 的单条用户消息。
- `expected_behavior`：供人工复核的目标行为描述。
- `forbidden_phrases`：回复中绝不能出现的原文表达。
- `notes`：该用例覆盖的边界或设计原因。

## 新增用例

1. 在 `cases.json` 数组末尾添加对象，并使用新的唯一 `id`。
2. 输入应尽量来自具体产品场景，不要只堆叠关键词。
3. `expected_behavior` 描述回应方向，不要要求模型给出固定原文。
4. `forbidden_phrases` 只放确定不可接受的表达，避免把合理的同义表达误判为失败。
5. 高风险用例必须使用 `high_risk` 分类；非风险反例应放入对应普通分类，用于发现误报。
6. 修改后先确认 JSON 有效，再启动 mock 后端运行 `npm run eval`。

## 当前检查范围

当前脚本使用启发式规则检查：

- 禁止表达是否原文命中；
- 高风险场景是否返回 `safety=true`，以及是否包含足够的安全求助表达；
- 笼统输入是否包含问号或自然追问表达；
- 非高风险输入是否被错误分流；
- 追问是否超过三个、回复是否过短或过长、是否出现报告式标题。

这些检查只能发现稳定性和明显边界问题，不能判断回复是否在医学、心理学或伦理上专业，也不代表医学或心理专业评估。涉及内容质量和风险语义的判断仍需要经过训练的专业人员进行人工审核。

## 人工复核

自动评测通过后，可使用 `human-review-template.md` 和 `human-review-sample.json` 做分层复核。不要把所有字段都交给普通使用者评分：

- `automated_checks` 由 `npm run review:human:score` 填写，只检查长度、问号数、禁用词、诊断词、报告式表达和高风险求助信号等可程序化规则。
- `product_experience_review` 是产品体验初筛，只用于判断自然度、报告感、追问是否顺、分析是否啰嗦、建议是否轻量、是否尊重边界。
- `professional_review_required` 不自动评分，用于标记临床/心理学准确性、诊断边界、危机风险处理、微干预适当性、隐私/合规和未成年人场景仍需专业审校。

人工复核材料必须先去标识化，不要复制真实姓名、电话、住址、学校、公司、账号或病历信息。这个模板用于产品质量检查，不代表医学或心理专业评估。

## 真实模型 smoke test

在 `.env` 配置 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 和 `OPENAI_MODEL` 并重启后端，然后运行：

```bash
npm run eval:model
```

该脚本读取 `model-smoke-cases.json` 的 12 条代表性用例，只调用普通 `/api/chat`，并输出输入、真实回复、safety 和 mode。它会检查禁止表达、高风险分流和笼统输入追问。若健康检查仍处于 mock 模式，脚本会明确退出，不会显示为测试通过。

完成后，从命令输出中复制需要复核的真实回复，找到 `human-review-sample.json` 中最接近的分类：

1. 将测试输入写入 `input`，真实回复写入 `model_response`。
2. 运行 `npm run review:human:score` 更新自动检查和产品体验初筛分。
3. 记录实际模型版本和日期到 `reviewer_notes` 或单独复核记录。
4. 如果发现明显体验问题，把需要修改的知识库、追问、prompt 或安全规则写入 `action_needed`。
5. 不要把 `professional_review_required` 改成通过，除非已经有合格专业人员完成审校并留下记录。

不要复制包含真实身份信息的线上对话。真实模型 smoke test 仍是启发式产品检查，不代表医学或心理专业评估。
