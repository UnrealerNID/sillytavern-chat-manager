# SillyTavern 聊天文件管理扩展设计

## 1. 项目范围

- 目标版本：SillyTavern 1.18.0
- 扩展名称：SillyTavern Chat Manager（聊天管理）
- 扩展形态：纯前端第三方扩展
- 设计原则：不修改 SillyTavern 源码，不依赖服务端插件，不接管原生保存流程

扩展只提供三项用户功能：

1. 随时查看并打开全部有效聊天
2. 识别指定聊天对应的原生备份
3. 按消息楼层分割指定聊天

缓存、分页、流式读取和 DOM 防重复注入仅是内部实现手段，不作为用户功能，也不声称优化 SillyTavern 核心。

## 2. 明确不做

- 不修改服务端中文备份名变成下划线的规则
- 不修改聊天保存时完整重写 JSONL 的逻辑
- 不自动删除、截断、替换或分割聊天
- 不改变模型上下文、提示词或生成流程
- 不提供大文件警告、风险等级或后台监控
- 不提供高级排序、内容深度搜索或批量操作
- 不提供设置面板、缓存管理或本地分卷导出
- 不处理无法归属到现有角色或群组的根级孤立聊天
- 不恢复已被覆盖、轮换删除或物理丢失的备份

## 3. 界面结构

### 3.1 统一入口

原生“聊天文件”菜单项为 `#option_select_chat`。扩展在其后插入唯一入口：

```html
<a id="chat_manager_open">
    <i class="fa-lg fa-solid fa-folder-tree"></i>
    <span>聊天管理</span>
</a>
```

插入方式：

```js
document
    .querySelector('#option_select_chat')
    ?.insertAdjacentElement('afterend', entry);
```

点击“聊天管理”打开扩展自己的全局聊天面板。桌面端和移动端使用同一个入口，不创建顶栏按钮、浮动按钮或设置页备用入口。

### 3.2 原生聊天文件列表增强

原生聊天文件列表保留原有数据、布局和操作。扩展仅在每条记录的操作区末尾增加两个按钮：

```text
导出 JSONL　导出 TXT　删除　备份　分割
```

使用的原生选择器：

| 用途 | 选择器 |
| --- | --- |
| 聊天列表 | `#select_chat_div` |
| 聊天行 | `.select_chat_block_wrapper` |
| 精确文件名 | `.select_chat_block[file_name]` |
| 行操作区 | `.select_chat_actions` |

每个增强过的聊天行添加 `data-chat-manager-enhanced="true"`，避免面板重新渲染后重复插入按钮。按钮使用事件委托，不覆盖原生事件；点击时阻止冒泡，不能同时触发打开、导出或删除聊天。

### 3.3 最终交互

```text
聊天选项菜单
├─ 聊天文件
└─ 聊天管理

原生聊天文件列表
└─ 当前角色或群组的聊天：备份｜分割

聊天管理面板
└─ 全部有效聊天：打开｜备份｜分割
```

## 4. 扩展协议

### 4.1 文件结构

```text
.
├─ manifest.json
├─ index.js
├─ style.css
├─ modules/
│  ├─ api.js
│  ├─ chat-list.js
│  ├─ backup-matcher.js
│  ├─ chat-splitter.js
│  ├─ verifier.js
│  ├─ native-chat-panel.js
│  └─ ui.js
└─ i18n/
   ├─ zh-cn.json
   └─ en.json
```

### 4.2 `manifest.json`

```json
{
  "display_name": "SillyTavern Chat Manager",
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

### 4.3 使用的原生前端能力

优先通过 `SillyTavern.getContext()` 使用：

- `characters`、`groups`
- `characterId`、`groupId`、`chatId`
- `chat`、`chatMetadata`
- `getRequestHeaders()`
- `selectCharacterById()`
- `openCharacterChat()`、`openGroupChat()`
- `uuidv4()`
- `Popup`、`t()`

打开群聊还需从原生 `group-chats.js` 导入 `openGroupById()`。

## 5. 原生接口

| 接口 | 用途 | 写入 |
| --- | --- | --- |
| `POST /api/chats/recent` | 枚举全部有效单聊和群聊 | 否 |
| `POST /api/characters/chats` | 读取指定角色的聊天列表和元数据 | 否 |
| `POST /api/chats/get` | 读取指定单聊 | 否 |
| `POST /api/chats/group/get` | 读取指定群聊 | 否 |
| `POST /api/backups/chat/get` | 获取原生备份列表 | 否 |
| `POST /api/backups/chat/download` | 按实际文件名读取备份 | 否 |
| `POST /api/files/sanitize-filename` | 复现服务端文件名清理 | 否 |
| `POST /api/chats/save` | 创建单聊分卷 | 是 |
| `POST /api/chats/group/save` | 创建群聊分卷 | 是 |
| `POST /api/groups/edit` | 把新群聊分卷登记到群组 | 是 |

本地源码依据：

- 扩展加载：[`SillyTavern/public/scripts/extensions.js`](../../SillyTavern/public/scripts/extensions.js)
- 前端上下文：[`SillyTavern/public/scripts/st-context.js`](../../SillyTavern/public/scripts/st-context.js)
- 全部聊天接口：[`SillyTavern/src/endpoints/chats.js`](../../SillyTavern/src/endpoints/chats.js)
- 角色聊天接口：[`SillyTavern/src/endpoints/characters.js`](../../SillyTavern/src/endpoints/characters.js)
- 群组接口：[`SillyTavern/src/endpoints/groups.js`](../../SillyTavern/src/endpoints/groups.js)
- 备份接口：[`SillyTavern/src/endpoints/backups.js`](../../SillyTavern/src/endpoints/backups.js)
- 原生备份浏览器：[`SillyTavern/public/scripts/chat-backups.js`](../../SillyTavern/public/scripts/chat-backups.js)
- 最近聊天界面：[`SillyTavern/public/scripts/welcome-screen.js`](../../SillyTavern/public/scripts/welcome-screen.js)
- 原生聊天行模板：[`SillyTavern/public/index.html`](../../SillyTavern/public/index.html)

## 6. 功能一：全部聊天

### 6.1 获取数据

调用 `POST /api/chats/recent` 时省略 `max`，取得当前账号全部有效单聊和群聊。接口返回：

- 实际聊天文件名
- 角色头像文件名或群组 ID
- 文件大小
- 消息数量
- 最后一条消息
- 最后消息时间

前端通过 `characters` 和 `groups` 补充角色或群组显示名。

无法匹配现有角色或群组的记录不展示，因为原生前端无法可靠打开它们。

### 6.2 面板内容

每条记录只显示：

- 角色或群组名称
- 聊天文件名
- 最后消息时间
- 文件大小
- 消息数量

操作只保留：

- 打开
- 备份
- 分割

面板提供一个输入框，只过滤角色名、群组名和聊天文件名。列表固定按最后消息时间倒序，不提供其他排序方式。

### 6.3 打开聊天

单聊：

1. 用 `avatar` 找到角色 ID
2. 调用 `selectCharacterById()`
3. 从 `file_name` 去掉 `.jsonl`
4. 调用 `openCharacterChat(chatName)`

群聊：

1. 调用 `openGroupById(groupId)`
2. 从 `file_name` 去掉 `.jsonl`
3. 调用 `openGroupChat(groupId, chatName)`

正在生成或流式输出时禁止切换聊天。

### 6.4 刷新与显示

- 第一次打开面板时请求全部聊天
- 同一次页面会话再次打开时复用内存数据
- 用户点击“刷新”时重新请求全部聊天
- 列表固定每页 50 条

不提供刷新数量、分页数量或缓存清理设置。

## 7. 功能二：对应备份

### 7.1 问题来源

原生备份使用：

```js
sanitize(name).replace(/[^a-z0-9]/gi, '_').toLowerCase()
```

中文角色卡可能得到相同的下划线前缀，因此不能只凭备份文件名判断归属。

### 7.2 读取方式

1. 调用 `/api/backups/chat/get` 获取服务器实际文件名
2. 将实际文件名原样传给 `/api/backups/chat/download`
3. 解析 JSONL 聊天头和消息

下划线不影响读取；它只导致文件名无法直接辨认。

### 7.3 匹配顺序

针对用户点击“备份”的精确聊天执行匹配：

1. 用角色头像文件名或群聊聊天 ID 生成备份前缀候选
2. 比较备份和目标聊天的 `chat_metadata.integrity`
3. 对规范化消息序列计算 SHA-256
4. 验证备份是目标聊天的完整快照或历史前缀

结果只显示三种状态：

- 已匹配：身份与消息序列均能验证
- 需要确认：证据相关但无法唯一验证
- 无法识别：没有足够证据

“需要确认”只在当前操作中由用户选择，不保存长期手动绑定。

### 7.4 展示与操作

从聊天行点击“备份”后，只展示与该聊天相关的备份候选，包括：

- 原始下划线文件名
- 备份时间
- 文件大小
- 消息数量
- 匹配状态

操作只保留查看内容和下载原始 JSONL。恢复、删除和批量管理继续使用酒馆原生功能。

### 7.5 限制

- 原聊天已删除且备份缺少 `integrity` 时可能无法唯一识别
- 分支或检查点可能共享 `integrity`，必须继续比较消息序列
- 被同名覆盖的旧内容无法恢复
- 被原生轮换删除的备份无法恢复
- 插件不修改今后生成的备份文件名

## 8. 功能三：按消息楼层分割

### 8.1 支持来源

分割只作用于全局聊天面板或原生聊天文件列表中选中的有效单聊、群聊。备份文件不参与分割。

原聊天在整个流程中只读并始终保留。插件只根据原记录快照创建新的酒馆聊天文件，不重命名、不截断、不删除原聊天，也不提供本地分卷导出。

### 8.2 楼层定义

使用 SillyTavern 原生 `mesid`：

- 第一条消息是 `#0`，对应 `chat[0]`
- 最后一条消息是 `#(N - 1)`
- JSONL 第一行聊天头不算楼层
- 系统消息和隐藏消息只要存在于聊天数组中就占用原生楼层
- 一个楼层的全部 Swipe 和附加字段整体保留

界面始终显示 `#mesid`，不引入从 1 开始的另一套编号。

### 8.3 模式 A：指定范围

用户填写起始楼层 `#S` 和结束楼层 `#E`，两端都包含：

```text
0 <= S <= E < N
```

输出一个包含 `#S..#E` 的新聊天。范围外消息不复制，仍完整保存在原聊天中。

### 8.4 模式 B：固定楼层数

用户填写每卷楼层数 `X`，输入框默认值为 500。

默认对完整聊天 `#0..#(N-1)` 分卷，也可以先填写 `#S..#E`，只处理指定范围。

示例：范围 `#100..#349`，每卷 100 层：

```text
#100..#199
#200..#299
#300..#349
```

最后不足 `X` 层的余数单独成为最后一卷。

### 8.5 分割操作面板与预览

点击“分割”只打开操作面板，不产生任何文件写入。操作面板按以下顺序工作：

1. 显示只读来源信息：角色或群组、聊天文件名、总楼层数
2. 选择“指定范围”或“固定楼层数”
3. 填写 `#S`、`#E`；固定量模式再填写 `X`
4. 点击“生成预览”计算分卷计划，此时仍不写入文件
5. 检查预览列表
6. 点击“确认分割”后才开始创建新聊天

预览列表显示：

```text
原聊天名 [分卷 001-of-003] [#100-#199]　100 层　预计大小
原聊天名 [分卷 002-of-003] [#200-#299]　100 层　预计大小
原聊天名 [分卷 003-of-003] [#300-#349]　 50 层　预计大小
```

面板按钮：

```text
取消　重新生成预览　确认分割
```

- “取消”关闭面板并丢弃计划，零写入
- 修改任何输入后，旧预览立即失效，必须重新生成
- 未生成有效预览时，“确认分割”不可用
- 确认前再次核对原聊天 `integrity` 和来源摘要；原聊天在预览后发生变化时中止，要求重新生成预览
- 只有“确认分割”可以调用写入接口

### 8.6 内容规则

- 只在消息对象之间切分
- 不拆开消息、Swipe、附件引用、推理字段或其他扩展字段
- 不插入总结
- 不复制范围外上下文
- 不修改原消息对象
- 不覆盖已有聊天文件

### 8.7 分卷元数据

每个分卷复制原 `chat_metadata`，但生成独立 `integrity`，并记录最小来源信息：

```json
{
  "chat_metadata": {
    "integrity": "独立 UUID",
    "chat_manager": {
      "schema": 1,
      "sourceChatId": "原聊天 ID",
      "sourceIntegrity": "原 integrity",
      "sourceStart": 100,
      "sourceEnd": 199,
      "messageDigest": "本卷消息 SHA-256",
      "createdAt": "ISO-8601"
    }
  },
  "user_name": "unused",
  "character_name": "unused"
}
```

### 8.8 输出命名

```text
<原聊天名> [分卷 001-of-003] [#100-#199]
<原聊天名> [分卷 002-of-003] [#200-#299]
<原聊天名> [分卷 003-of-003] [#300-#349]
```

指定范围只生成一个新聊天时使用 `<原聊天名> [#S-#E]`，不添加分卷序号。

写入前查询已有聊天名。若目标名称已存在，则追加短 UUID 形成不冲突的名称。任何情况下都不覆盖已有文件。

### 8.9 写入与验证

单聊使用 `/api/chats/save`。群聊使用 `/api/chats/group/save`，成功后通过 `/api/groups/edit` 登记新聊天 ID。

每个分卷写入后立即回读并验证：

1. 文件存在
2. 楼层范围和消息数量正确
3. 规范化消息摘要与预览计划一致
4. 固定量模式的所有分卷按顺序拼接后，与所选来源范围一致

任何分卷失败时停止后续写入。原聊天不受影响；界面列出已经创建的分卷，不自动删除。

## 9. 内部实现约束

这些约束不作为用户功能：

- 备份 JSONL 使用流式逐行解析，避免额外复制整个大文件
- 全部聊天列表使用固定 50 条分页
- 同一次页面会话复用已取得的聊天列表
- 原生聊天行注入必须幂等
- 网络请求支持 `AbortController`
- 业务算法与 DOM 操作分离

扩展不提供与这些实现细节相关的用户设置。

## 10. 错误处理

| 场景 | 行为 |
| --- | --- |
| 全部聊天接口失败 | 显示错误并保留当前面板状态 |
| 目标角色或群组不存在 | 禁止打开、备份匹配和分割 |
| 备份下载返回 404 | 显示备份已不存在 |
| 备份 JSONL 损坏 | 报告损坏，不继续匹配 |
| 备份证据不唯一 | 显示“需要确认”，不自动归属 |
| 楼层输入越界 | 阻止进入预览 |
| 每卷楼层数小于 1 | 阻止进入预览 |
| 原聊天在预览后发生变化 | 使预览失效并要求重新生成 |
| 目标文件名冲突 | 生成不冲突的新名称 |
| 写入失败 | 停止后续分卷，保留原聊天 |
| 回读摘要不符 | 标记失败，停止后续分卷 |
| 原生 DOM 选择器变化 | 禁用对应入口或行按钮并报告兼容错误 |

## 11. 验收标准

### 11.1 全部聊天

1. 不返回欢迎页也能打开“聊天管理”
2. 能列出全部有效单聊和群聊
3. 能按角色、群组或聊天文件名过滤
4. 默认按最后消息时间倒序
5. 能精确打开选中的单聊或群聊
6. 每页最多渲染 50 条记录

### 11.2 对应备份

1. 下划线前缀相同的两张中文卡不会仅凭文件名自动归属
2. `integrity` 和消息序列匹配时显示“已匹配”
3. 分支共享 `integrity` 时继续使用消息摘要消歧
4. 证据不足时显示“需要确认”或“无法识别”
5. 可以查看和下载仍然存在的备份
6. 不重命名、删除或修改原生备份

### 11.3 聊天分割

1. 指定范围包含 `#S` 和 `#E`
2. 指定范围不会复制范围外消息
3. 固定量模式每卷最多 `X` 层
4. 固定量模式完整保留最后余数卷
5. 限定范围后固定量分割不会越过 `#S` 或 `#E`
6. Swipe、附件引用、推理字段和其他消息字段完整保留
7. 原聊天在成功、失败和取消时均保持不变
8. 不覆盖已有聊天文件
9. 每个新分卷拥有独立 `integrity`
10. 写入后回读的数量和摘要验证通过
11. 打开操作面板和生成预览均不会写入文件
12. 取消操作不会产生任何分卷
13. 原聊天在预览后变化时不能使用旧计划写入

### 11.4 原生聊天文件列表

1. 每条聊天记录最多出现一个“备份”和一个“分割”按钮
2. 原生列表重新渲染后不会重复注入
3. 行按钮能取得当前所有者和精确聊天文件名
4. 点击扩展按钮不会同时触发其他原生操作
5. 行增强失效不影响原生聊天文件功能

## 12. 实施顺序

### 阶段一：扩展骨架与全部聊天

- `manifest.json`、入口和全局面板
- 全部聊天列表、简单过滤、固定分页
- 精确打开单聊和群聊
- 原生聊天行按钮注入

### 阶段二：对应备份

- 备份列表和按需下载
- 前缀、`integrity` 和消息指纹匹配
- 查看与下载

### 阶段三：聊天分割

- 指定范围和固定楼层数
- 只读操作面板、分割预览和确认门槛
- 单聊和群聊写入
- 回读验证和失败报告

## 13. 最终功能结构

```text
聊天管理
├─ 全部聊天：打开｜备份｜分割
├─ 备份：查看｜下载
└─ 分割：指定范围｜固定楼层数

原生聊天文件
└─ 当前聊天：备份｜分割
```
