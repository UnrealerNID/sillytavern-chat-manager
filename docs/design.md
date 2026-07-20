# 长聊天与备份识别优化扩展设计

## 1. 文档状态

- 目标版本：SillyTavern 1.18.0
- 扩展形态：纯前端第三方扩展
- 暂定名称：Chat Archive Optimizer（聊天归档优化器）
- 设计原则：不修改 SillyTavern 源码，不拦截原生保存流程，不在后台重命名、删除或覆盖现有聊天与备份
- 核心目标：可靠识别备份归属；安全分割过大的单聊和群聊记录

## 2. 需求定义

### 2.1 必须实现

1. 列出当前账号可见的原生聊天备份
2. 识别每个备份所属的角色卡或群聊，并尽可能定位原聊天文件
3. 不确定时明确显示候选项与原因，不得仅凭消息显示名自动归属
4. 支持分割当前聊天和选中的原生备份
5. 按消息边界分割，不拆开单条消息，不丢失 Swipe、思维链字段、附件引用及其他消息扩展字段
6. 默认保留原文件，只新增分卷
7. 写入后回读分卷并验证消息数量、顺序和摘要哈希
8. 任何一步失败时保留原文件，并清楚列出已成功和失败的分卷

### 2.2 非目标

1. 不修补服务端将中文备份名替换为下划线的逻辑
2. 不保证恢复已被同名覆盖或被轮换删除的备份
3. 不自动删除、截断或替换原聊天
4. 不改变模型上下文、提示词构造或生成流程
5. 不把“页面分页”当作“文件分割”；两者是不同功能

## 3. 已确认的原生行为

### 3.1 备份命名

单聊保存时，服务端以角色卡头像文件名（去掉 `.png`）作为备份名称来源；群聊以群聊聊天 ID 作为来源。随后名称会经过：

```js
sanitize(name).replace(/[^a-z0-9]/gi, '_').toLowerCase()
```

因此中文、日文、韩文、空格和大部分符号都会变成下划线。不同角色卡可能生成相同前缀。实现位置见 [`SillyTavern/src/endpoints/chats.js`](../../SillyTavern/src/endpoints/chats.js)。

原生备份格式为：

```text
chat_<ASCII 清理后的名称>_<YYYYMMDD-HHmmss>.jsonl
```

### 3.2 备份读取

下划线名称不影响读取。前端先取得服务器实际文件名，再把该文件名原样传给下载接口：

- `POST /api/backups/chat/get`
- `POST /api/backups/chat/download`

下载接口只要求目标存在于当前账号备份目录并以 `chat_` 开头。扩展必须使用列表接口返回的 `file_name`，不能用推断出的中文名请求文件。

### 3.3 聊天 JSONL

第一行是聊天头：

```json
{
  "chat_metadata": {},
  "user_name": "unused",
  "character_name": "unused"
}
```

后续每行是一条完整消息。当前版本的 `user_name` 和 `character_name` 不能用于识别归属；优先使用 `chat_metadata.integrity`、角色卡头像文件名、群聊聊天 ID 和消息指纹。

### 3.4 原生完整保存

单聊保存会把完整消息数组重新序列化并写入 JSONL；设置页面加载消息数量只能降低 DOM 渲染压力，不会缩小文件。因此本扩展的“分割”必须生成多个独立 JSONL，而不是仅隐藏旧消息。

## 4. 扩展协议

### 4.1 目录结构

```text
Chat-Archive-Optimizer/
├─ manifest.json
├─ index.js
├─ style.css
├─ settings.html
├─ modules/
│  ├─ api.js
│  ├─ backup-reader.js
│  ├─ backup-resolver.js
│  ├─ canonical-json.js
│  ├─ chat-splitter.js
│  ├─ chat-writer.js
│  ├─ integrity-verifier.js
│  ├─ local-index.js
│  └─ ui.js
└─ i18n/
   ├─ zh-cn.json
   └─ en.json
```

### 4.2 `manifest.json`

```json
{
  "display_name": "Chat Archive Optimizer",
  "loading_order": 100,
  "requires": [],
  "dependencies": [],
  "js": "index.js",
  "css": "style.css",
  "author": "Local",
  "version": "0.1.0",
  "minimum_client_version": "1.18.0",
  "auto_update": false,
  "i18n": {
    "zh-cn": "i18n/zh-cn.json",
    "en": "i18n/en.json"
  }
}
```

扩展由 SillyTavern 通过 `manifest.json` 加载 ES module 入口。运行时优先使用 `SillyTavern.getContext()`，仅在上下文没有暴露所需能力时，从酒馆原生模块导入已导出的函数。

### 4.3 使用的上下文能力

| 能力 | 用途 |
| --- | --- |
| `chat`、`chatMetadata`、`chatId` | 读取当前聊天快照及身份信息 |
| `characters`、`characterId` | 获取角色显示名和稳定的头像文件名 |
| `groups`、`groupId` | 获取群组及其聊天 ID 列表 |
| `getRequestHeaders()` | 调用当前账号下的原生 API |
| `eventSource`、`eventTypes` | 在聊天切换、消息变更后更新大小统计 |
| `uuidv4()` | 为每个新分卷生成独立 `integrity` |
| `saveSettingsDebounced()` | 保存少量扩展设置 |
| `Popup`、`t()` | 使用原生弹窗和国际化能力 |

建议监听以下事件：

- `APP_READY`
- `CHAT_CHANGED`
- `CHAT_CREATED`
- `MESSAGE_SENT`
- `MESSAGE_RECEIVED`
- `MESSAGE_EDITED`
- `MESSAGE_DELETED`
- `MESSAGE_SWIPED`

事件只触发重新统计和刷新 UI，不触发自动分割或自动写入。

## 5. 原生接口清单

| 接口 | 方法 | 用途 | 是否写入 |
| --- | --- | --- | --- |
| `/api/backups/chat/get` | POST | 获取备份列表、文件大小、消息数和末条消息时间 | 否 |
| `/api/backups/chat/download` | POST | 按服务器实际文件名流式读取备份 | 否 |
| `/api/files/sanitize-filename` | POST | 复现服务端第一阶段文件名清理 | 否 |
| `/api/characters/chats` | POST | 按角色头像列出聊天；传 `metadata: true` 读取 `integrity` | 否 |
| `/api/chats/get` | POST | 读取指定角色的指定聊天 | 否 |
| `/api/chats/group/get` | POST | 读取指定群聊聊天 | 否 |
| `/api/chats/save` | POST | 为目标角色写入独立分卷 | 是，新增文件 |
| `/api/chats/group/save` | POST | 写入群聊分卷 | 是，新增文件 |
| `/api/groups/edit` | POST | 将新群聊分卷登记到目标群组 | 是，更新群组聊天列表 |
| `/api/chats/delete` | POST | 仅用于用户确认后的失败分卷回滚 | 是，删除本次新文件 |
| `/api/chats/group/delete` | POST | 仅用于用户确认后的群聊失败分卷回滚 | 是，删除本次新文件 |

禁止调用原生备份删除接口。扩展不重命名原生备份。

### 5.1 本地源码依据

| 能力 | 本地实现 |
| --- | --- |
| 扩展清单发现、加载顺序、依赖与最低版本检查 | [`SillyTavern/public/scripts/extensions.js`](../../SillyTavern/public/scripts/extensions.js) |
| `SillyTavern.getContext()` 暴露的前端能力 | [`SillyTavern/public/scripts/st-context.js`](../../SillyTavern/public/scripts/st-context.js) |
| 可订阅的聊天与消息事件 | [`SillyTavern/public/scripts/events.js`](../../SillyTavern/public/scripts/events.js) |
| 备份列表、下载和删除路由 | [`SillyTavern/src/endpoints/backups.js`](../../SillyTavern/src/endpoints/backups.js) |
| 单聊读取、保存、导入、导出与群聊聊天路由 | [`SillyTavern/src/endpoints/chats.js`](../../SillyTavern/src/endpoints/chats.js) |
| 角色聊天列表接口 | [`SillyTavern/src/endpoints/characters.js`](../../SillyTavern/src/endpoints/characters.js) |
| 群组登记接口 | [`SillyTavern/src/endpoints/groups.js`](../../SillyTavern/src/endpoints/groups.js) |
| 原生备份浏览器的请求方式 | [`SillyTavern/public/scripts/chat-backups.js`](../../SillyTavern/public/scripts/chat-backups.js) |

实现阶段应以这些本地导出和路由为准；不得假设其他 SillyTavern 版本拥有相同接口签名。

## 6. 备份归属识别

### 6.1 识别结果模型

```ts
type BackupResolution = {
    backupFileName: string;
    ownerType: 'character' | 'group' | 'unknown';
    ownerId?: string;          // 角色头像文件名或群组 ID
    ownerDisplayName?: string;
    sourceChatId?: string;
    confidence: 'verified' | 'strong' | 'ambiguous' | 'unknown';
    evidence: string[];
    candidates: Candidate[];
};
```

UI 只有在 `verified` 时默认选中归属；`strong` 必须展示证据并让用户确认；`ambiguous` 和 `unknown` 禁止自动写入目标角色。

### 6.2 第一阶段：文件名候选

1. 从末尾解析固定时间戳，取得备份名称段
2. 对每个角色卡头像文件名去掉 `.png`
3. 调用 `/api/files/sanitize-filename`，再应用与服务端相同的 ASCII 替换和小写规则
4. 将结果与备份名称段比较
5. 对每个群组的 `chats[]` 中的聊天 ID 执行相同比较

此阶段只能生成候选集，不能单独证明归属。两个中文角色很可能得到相同候选前缀。

### 6.3 第二阶段：聊天完整性标识

流式读取备份第一行并提取 `chat_metadata.integrity`。然后：

1. 对文件名候选角色调用 `/api/characters/chats`，参数包含 `metadata: true`
2. 比较每个聊天的 `chat_metadata.integrity`
3. 群聊优先用备份名称段直接匹配群组 `chats[]` 中的聊天 ID；必要时读取候选群聊头

`integrity` 相等可以把备份关联到同一聊天谱系，但分支和检查点可能复制元数据，因此仍需消息指纹消除多候选。

### 6.4 第三阶段：消息指纹

对消息对象做递归键排序后再 `JSON.stringify`，数组顺序保持不变，使用 Web Crypto 计算 SHA-256。禁止只对 `mes` 文本哈希，因为 Swipe、`extra`、附件、推理内容和角色字段也是记录的一部分。

验证规则：

1. 备份消息序列与候选聊天等长且总摘要相同：精确快照匹配
2. 备份消息序列是候选聊天的完整前缀：历史备份匹配
3. `integrity` 相同但消息已被编辑：同聊天谱系匹配，降级为 `strong`
4. 多个候选均满足：保持 `ambiguous`，要求用户选择

只对前两种结果标记 `verified`。

### 6.5 旧备份与缺失源聊天

旧备份可能没有 `integrity`，原聊天也可能已经删除。此时允许使用以下辅助证据缩小候选：

- 唯一的头像文件名清理结果
- AI 消息 `name` 与角色显示名的一致性
- 群聊消息中的多个成员名组合
- 用户曾经确认并保存在本地索引中的绑定

这些证据不能把结果提升到 `verified`。扩展必须允许用户手动绑定，并记录“手动确认”而不是伪装成自动验证。

### 6.6 无法恢复的情况

若不同中文卡生成了同一备份路径并在同一时间戳下发生覆盖，磁盘上只剩最后写入的内容。前端扩展无法恢复被覆盖的数据。若文件已被备份轮换删除，同样无法识别或分割。

## 7. 大聊天检测

### 7.1 指标

- 消息数量
- 实际 UTF-8 JSONL 字节数
- Swipe 总数量及字节数
- 最大单条消息字节数
- 当前页面已渲染消息节点数

字节统计使用 `TextEncoder`，包括聊天头、每条 JSON 和换行符。不能只用 JavaScript 字符串长度估算中文文件大小。

### 7.2 默认阈值

默认值仅用于提示，均可配置：

- 提醒：800 条消息或 8 MiB
- 建议分割：1500 条消息或 16 MiB
- 默认分卷目标：每卷不超过 500 条消息且尽量不超过 8 MiB

阈值命中只显示提示，不自动执行分割。

## 8. 分割设计

### 8.1 支持来源

1. 当前已打开的单聊
2. 当前已打开的群聊
3. 备份浏览器中已达到 `verified` 的备份
4. 用户手动确认归属的 `strong`、`ambiguous` 或 `unknown` 备份

对未确认归属的备份，只允许导出本地分卷，不允许直接写入某个角色或群组。

### 8.2 边界算法

1. 第一行聊天头不计入消息数量，但计入每卷字节数
2. 逐条累计消息的实际 JSONL UTF-8 字节数
3. 达到消息上限或加入下一条后超过字节上限时结束当前卷
4. 单条消息本身超过字节上限时单独成卷，并在预览中警告
5. 不修改消息对象，不在分卷之间添加重复上下文消息
6. 不插入 AI 总结；总结属于后续可选功能，不属于无损分割

因此将所有分卷去掉各自聊天头后按序拼接，应与原消息序列完全一致。

### 8.3 分卷聊天头

每卷复制原 `chat_metadata`，但必须生成新的 `integrity`，并加入命名空间元数据：

```json
{
  "chat_metadata": {
    "integrity": "每卷独立 UUID",
    "chat_archive_optimizer": {
      "schema": 1,
      "sourceType": "chat-or-backup",
      "sourceChatId": "原聊天 ID",
      "sourceBackupFileName": "可选，服务器实际备份名",
      "sourceIntegrity": "原 integrity",
      "sourceDigest": "原消息序列 SHA-256",
      "partIndex": 1,
      "partCount": 4,
      "messageStart": 0,
      "messageEnd": 499,
      "partDigest": "本卷消息序列 SHA-256",
      "createdAt": "ISO-8601"
    }
  },
  "user_name": "unused",
  "character_name": "unused"
}
```

原元数据中的世界书状态、作者注释、总结和检查点字段默认保留。扩展只覆盖 `integrity` 和自己的命名空间。

### 8.4 输出命名

```text
<原聊天名> [分卷 001-of-004]
<原聊天名> [分卷 002-of-004]
```

正式写入前必须查询目标角色或群组的现有聊天名；冲突时追加短 UUID，不得覆盖已有文件。

### 8.5 两种输出模式

#### 本地导出

- 生成独立 JSONL 下载文件
- 不写入 SillyTavern 数据目录
- 适用于归属尚未验证或用户只想离线归档

#### 安装为酒馆聊天

- 仅在用户明确确认后执行
- 单聊使用原生 `/api/chats/save`
- 群聊使用原生 `/api/chats/group/save`，并通过群组编辑接口登记新聊天 ID
- 原聊天保持不变
- 写入过程逐卷串行执行，禁止并发保存

调用保存接口可能触发酒馆现有的自动备份副作用；预览页必须提前说明。插件不暂停、关闭或修改原生备份配置。

### 8.6 写后验证

每卷保存后立即通过原生读取接口回读，并验证：

1. 新文件确实存在
2. `partIndex`、`partCount` 和消息范围正确
3. 消息数量正确
4. 本卷规范化摘要等于计划中的 `partDigest`
5. 将全部分卷消息按原顺序重新送入同一规范化字节流后，重新计算出的摘要等于 `sourceDigest`

全部通过后才显示“分割完成”。如果中途失败：

- 停止写入后续分卷
- 保留原聊天
- 列出成功写入的分卷
- 提供“保留已完成分卷”与“删除本次新建分卷”两个选择
- 删除只允许作用于本次运行记录的精确文件名，并再次确认

## 9. 流式读取与内存控制

备份可能很大，禁止默认使用 `response.text()` 一次性复制整个文件。`backup-reader.js` 应使用 `ReadableStream`、`TextDecoder` 和残留行缓冲逐行解析。

识别模式分两档：

- 快速识别：读取聊天头和有限消息样本后主动中止响应
- 完整验证或分割：顺序读取全文件并增量计算摘要、构建分卷

分割备份时，每完成一卷即可释放上一卷的消息数组。当前聊天已经由酒馆完整加载在内存中，则先创建不可变快照，避免分割期间收到新消息导致计划变化。

在生成进行中、流式输出未结束或聊天正在切换时禁用“开始分割”。

## 10. 本地索引

大量识别记录不写入 `extension_settings`，避免账号设置膨胀。使用 IndexedDB 保存：

```ts
type BackupIndexEntry = {
    cacheKey: string;          // file_name + file_size + last_mes
    resolution: BackupResolution;
    headerIntegrity?: string;
    sampleDigest?: string;
    manualBinding?: boolean;
    scannedAt: string;
};
```

服务器列表中的文件大小或末条消息时间变化后，缓存自动失效。用户可以单独清除识别缓存；清理缓存不调用任何服务器删除接口。

## 11. 用户界面

### 11.1 设置抽屉

- 大聊天提醒开关
- 消息数和 MiB 阈值
- 默认分卷消息数和 MiB
- 是否显示页面渲染消息数量
- 清除本地识别缓存

### 11.2 状态入口

在扩展设置和聊天菜单提供入口，显示：

- 当前聊天大小
- 风险等级
- “制定分割计划”按钮
- “打开备份识别器”按钮

### 11.3 备份识别器

列表列：

- 识别后的角色或群聊名称
- 原始服务器文件名
- 可能的原聊天名
- 文件大小和消息数
- 识别等级及证据
- 查看、手动绑定、本地分割、安装分卷按钮

`ambiguous` 必须显示全部候选，不允许用第一项静默兜底。

### 11.4 分割向导

1. 选择来源
2. 查看归属证据
3. 设置消息和字节上限
4. 预览每卷范围、大小、名称和超大单消息警告
5. 选择本地导出或安装为酒馆聊天
6. 二次确认
7. 显示逐卷写入与校验进度
8. 输出完成报告

## 12. 模块职责

| 模块 | 职责 |
| --- | --- |
| `api.js` | 封装原生接口、状态码和中止信号 |
| `backup-reader.js` | 流式解析 JSONL，区分聊天头与消息 |
| `backup-resolver.js` | 文件名候选、`integrity` 和消息指纹匹配 |
| `canonical-json.js` | 递归键排序、UTF-8 字节计算和 SHA-256 |
| `chat-splitter.js` | 生成无损分割计划，不执行网络写入 |
| `chat-writer.js` | 串行写入单聊/群聊分卷并登记群组 |
| `integrity-verifier.js` | 回读分卷并验证摘要和范围 |
| `local-index.js` | IndexedDB 缓存、失效与手动绑定 |
| `ui.js` | 设置、识别列表和分割向导 |

业务算法与 DOM 分离，便于单元测试。

## 13. 错误处理

| 场景 | 行为 |
| --- | --- |
| 备份列表接口失败 | 显示 HTTP 状态，不使用旧列表执行写入 |
| 下载返回 404 | 标记备份已不存在并使缓存失效 |
| JSONL 某行损坏 | 停止分割，报告行号；允许只读查看已解析部分 |
| 无法验证归属 | 只允许本地导出或用户手动绑定 |
| 文件名冲突 | 重新生成目标名，禁止覆盖 |
| 保存中断 | 停止后续卷并进入部分成功状态 |
| 回读摘要不符 | 标记失败，禁止建议删除原文件 |
| 单条消息超过限制 | 单独成卷并警告，不截断消息 |
| 页面刷新或关闭 | 当前任务中止；再次打开后从本地任务记录检查部分输出 |

## 14. 验收标准

### 14.1 备份识别

1. 两张纯中文卡产生相同下划线前缀时，扩展不能仅凭前缀误归属
2. 有唯一 `integrity` 和消息前缀匹配时，显示 `verified`
3. 分支复制相同 `integrity` 时，必须通过消息指纹继续区分
4. 原聊天删除且证据不足时，显示 `ambiguous` 或 `unknown`
5. 手动绑定后刷新页面仍能显示绑定，并明确标记为手动确认
6. 识别过程不重命名、不删除、不修改备份

### 14.2 聊天分割

1. 单聊、群聊和备份来源均能生成正确计划
2. 中文、Emoji、Swipe、附件引用、推理字段和扩展字段完整保留
3. 拼接全部分卷消息后与原消息序列的规范化摘要一致
4. 每卷拥有独立 `integrity`
5. 原聊天在成功、失败和取消情况下均保持不变
6. 目标名已存在时绝不覆盖
7. 中途保存失败后不会继续写入，且能精确报告部分输出
8. 大文件使用流式解析，识别时不会因一次性 `response.text()` 产生额外完整副本

## 15. 测试计划

### 15.1 单元测试

- 备份文件名时间戳解析
- 与服务端一致的候选 Slug 生成
- 规范化 JSON 与摘要稳定性
- UTF-8 字节边界，覆盖中文和 Emoji
- 按消息数、字节数及双重条件分割
- 单条超大消息
- 相同 `integrity` 的分支消歧
- 缓存失效键

### 15.2 集成测试

- 单角色多聊天、多角色同下划线前缀
- 单聊分卷写入和回读
- 群聊分卷登记和回读
- 旧备份无 `integrity`
- 已删除源聊天的备份
- 保存接口 400、404、500 和网络中止
- 分割过程中切换聊天或开始生成

### 15.3 手工验证

- 在桌面和移动布局检查设置与向导
- 以 10 MiB、50 MiB 和 100 MiB JSONL 检查内存峰值与交互响应
- 确认扩展禁用后酒馆所有原生功能保持原状

## 16. 实施阶段

### 阶段一：只读识别

- 扩展骨架和设置 UI
- 备份列表与流式读取
- 文件名候选、`integrity`、消息指纹解析
- IndexedDB 缓存和手动绑定

### 阶段二：无损分割与本地导出

- 大小统计
- 分割计划和预览
- JSONL 本地分卷导出
- 摘要验证报告

### 阶段三：安装为原生聊天

- 单聊串行写入和回读验证
- 群聊串行写入、登记和回读验证
- 部分失败恢复流程

### 阶段四：体验优化

- 页面性能提示
- 搜索、筛选、证据详情
- 国际化和大文件性能测试

阶段一和阶段二不产生服务器写入，适合作为首个可用版本。阶段三必须保留明确确认和完整校验，不与只读扫描混在一次操作中。

## 17. 关键结论

1. 纯前端扩展可以读取下划线备份，因为接口按服务器实际文件名定位文件
2. 纯前端扩展不能修复已发生的服务端覆盖，也不能让不充分证据变成确定归属
3. 正确识别必须采用候选 Slug、`integrity` 和消息指纹的组合，并允许“无法确定”
4. 过大聊天可以通过原生接口分割成新的单聊或群聊文件，无需修改酒馆源码
5. 分割必须默认非破坏、写后回读、摘要一致后才算完成
