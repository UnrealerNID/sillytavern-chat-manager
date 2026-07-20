# SillyTavern Chat Manager

面向 SillyTavern 的纯前端聊天文件管理扩展。

## 目标

- 随时查看并打开当前账号的全部有效聊天
- 未选择角色或群聊时，仍可从管理面板选择聊天并执行对应操作
- 识别指定聊天对应的原生备份
- 按消息楼层范围或固定楼层数生成新分卷
- 通过只读操作面板预览，确认后才创建分卷
- 原聊天始终保留，写入后回读校验新分卷
- 聊天正在生成时保持只读浏览，禁止切换聊天和分割写入
- 不修改或补丁化 SillyTavern 源码

## 已确认边界

- 分卷通过酒馆原生保存接口创建，因此会触发酒馆现有的聊天备份与轮换规则
- 备份文件可以流式读取；普通聊天读取接口仍会返回完整消息数组，纯前端扩展不能消除首次读取超大聊天的内存开销
- 文件名使用酒馆原生清理规则，冲突时追加短数字后缀；插件不主动覆盖已有聊天

## 当前状态与版本

当前扩展版本为 `0.1.4`，最低支持 SillyTavern 1.18.0。版本号同时记录在
`manifest.json` 和 `package.json`；发布时应同步递增两处版本。

## 安装

在 SillyTavern 的“扩展程序”中选择“安装扩展”，填写仓库地址：

```text
https://github.com/UnrealerNID/sillytavern-chat-manager
```

安装器会将仓库克隆到当前用户的扩展目录，使其出现在“已安装的扩展”列表中。
不要再复制到旧的 `public/scripts/extensions/third-party` 目录；当前酒馆的扩展发现接口不会把该目录作为用户扩展列出。

安装后刷新页面，在扩展管理中应能看到 **聊天文件管理** 和当前版本号。插件入口位于原生“聊天文件”菜单项之后。

## 更新

扩展清单已启用酒馆原生 `auto_update`。酒馆通过安装目录中的 Git 仓库比较当前提交与
`origin` 分支判断是否有更新，而不是单独比较版本字符串；因此每次发布必须将新提交推送到
GitHub。`manifest.json` 中的版本号用于扩展列表展示和发布辨识。

用户可在扩展管理中“检查更新”或点击该扩展的更新按钮。若修改的是清单、脚本或样式，更新后刷新页面生效。

## 开发验证

```bash
npm run check
npm test
```

完整方案见 [docs/design.md](docs/design.md)。

## 项目结构

```text
.
├─ docs/
│  └─ design.md
├─ manifest.json
├─ index.js
├─ style.css
├─ modules/
├─ i18n/
├─ scripts/
└─ test/
```

实现遵循 SillyTavern 前端第三方扩展协议，优先使用 `SillyTavern.getContext()` 和原生 API。
