# Knowledge Sources 资料收集区

本目录用于收集 AI 心理健康觉察 Demo 后续可能使用的原始资料，并登记资料的来源、用途、限制和本地保存位置。它是独立的资料治理层，不参与当前聊天运行流程。

## 当前阶段范围

- 本目录负责原始资料分类、来源登记、网页快照、中文摘要和收集工具。
- `knowledge/evidence_cards/` 与 `knowledge/decision_cards/` 已建立，但目前仍是机器草稿或待审状态，不能视为专业批准内容。
- `server/knowledge/` 是当前聊天实际使用的投放层；从来源到运行时知识仍需人工映射、审校和测试。
- `src/knowledge/` 的只读上下文路径是默认关闭的实验能力，只有显式启用环境变量时才可能参与 prompt。
- 当前不使用 RAG、向量检索或数据库；资料收集脚本只处理官方域名白名单，不自动生成专业结论。

完整的四层治理关系和当前数量见 [`../docs/knowledge-expansion-roadmap.md`](../docs/knowledge-expansion-roadmap.md)。

## Git 与第三方资料

`raw/` 中下载的 HTML、PDF、图片、脚本和样式默认被 `.gitignore` 排除，只提交目录骨架、来源登记和项目自己的摘要/卡片。这样可以避免在没有逐项确认来源条款时，把第三方网页快照直接再分发到公开仓库。

克隆仓库后如需本地核验原文，请根据登记表中的官方链接自行访问，或运行本目录后文的收集命令。下载和使用时仍应遵守来源网站的许可、版权、访问频率和使用限制；不要因为来源是政府或国际机构就假设内容自动属于开放许可。

## 来源优先级

优先收集：

1. 政府和国际官方机构资料；
2. 临床指南和公共卫生指南；
3. 心理学、精神医学等专业协会资料；
4. 大学、医院公开的专业教育资料；
5. 系统综述和高质量证据综述。

当前暂不使用：

- 公众号文章；
- 知乎、小红书等用户内容平台；
- 来源不明或版本无法核实的 PDF；
- 商业课程、营销材料和付费培训讲义。

## 登记要求

所有资料必须在 `registry/source_registry.csv` 和 `registry/source_registry.json` 中登记以下信息：

- `source_id`
- 标题
- 机构
- 年份
- 语言
- 资料类型
- 主题标签
- 优先级
- 项目用途
- 使用限制
- 原始链接
- 本地保存路径
- 收集状态
- 访问日期
- 是否完成摘要

`source_id` 必须稳定且唯一。原始文件放入 `raw/` 的对应分类目录；中文摘要写入 `notes/`。不要把来源不明的文件放入本目录后直接用于产品。

## 推荐人工流程

1. 从登记表中选择 `status=todo` 的高优先级来源。
2. 人工核实正式标题、发布机构、版本、年份和官方链接。
3. 将原始文件或网页存档保存到登记的 `file_path`（该本地文件默认不提交到 Git）。
4. 填写 `access_date`，把状态改为 `collected`。
5. 使用 `templates/source_note_template.md` 在对应 notes 文件中完成中文摘要。
6. 摘要完成后设为 `summarized`、`notes_done=yes`。
7. 由合适的专业人员复核后再标记 `needs_review` 或 `approved`。
8. 运行 `npm run knowledge:sources:check` 检查登记结构。

结构检查只能发现字段缺失、重复 ID 和非法状态，不能判断资料是否科学、是否适用于具体用户，也不能替代心理、医学、伦理、法律或隐私专业审查。

## 半自动收集命令

先预览，不发出网络请求或写文件：

```bash
npm run knowledge:sources:collect -- --dry-run
```

处理全部待收集记录：

```bash
npm run knowledge:sources:collect
```

只处理一个来源，或强制重新下载已收集/已摘要的来源：

```bash
node scripts/collect-knowledge-sources.js --id who_safety_planning
node scripts/collect-knowledge-sources.js --force
```

收集器只访问脚本中的官方域名白名单。成功保存后才会同步 JSON/CSV 并设为 `collected`；单条失败会写入 `registry/collection_report.md`，不会伪造成功或中断其他来源。`approved`、`deprecated` 和正在复核的记录不会被自动覆盖。自动收集不会生成专业摘要，也不会把资料接入聊天、prompt 或检索流程。

## 手动补录受限站点资料

如果官方站点阻止自动访问，请先用浏览器人工保存官方页面或 PDF，再运行：

```bash
npm run knowledge:sources:manual -- --id nhc_hotline_guide --file knowledge_sources/raw/safety/nhc_hotline_guide.html --url https://www.nhc.gov.cn/wjw/c100175/202101/ce4756ac40e742a48b00ff32d3807825.shtml
```

`--id`、`--file` 和 `--url` 均为必填。脚本只接受官方白名单中的 HTTPS URL，以及 `.pdf`、`.html`、`.htm`、`.txt` 本地文件。raw 目录外的文件会复制到该来源登记路径所在的分类目录；raw 目录内的文件直接登记。`summarized`、`needs_review`、`approved` 或 `deprecated` 状态默认受保护，必须显式添加 `--force` 才能覆盖；补录后统一设为 `collected`，不会自动设为 `approved`。

成功补录会同步 JSON/CSV、在 `collection_report.md` 末尾追加 `Manual Collection` 记录，并在缺少对应 notes 标题时追加待人工填写骨架。已有 notes 小节不会被覆盖。该命令只处理本地文件，不访问互联网，也不绕过官网限制。
