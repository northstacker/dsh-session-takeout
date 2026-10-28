# dsh-session-takeout

[English](README.md) · **简体中文**

把一段 DeepSeek Harness 对话打包成单个 ZIP，拷到另一台电脑上接着聊。

```bash
plugin_manager → install_bundle → target: <本目录>
```

输入框下方会多出两个小按钮：

- **导出会话 / Export session** — 把当前对话打包成一个 ZIP 放进 `~/Downloads`，
  并在 Finder 里定位到它。
- **导入会话包 / Import bundle** — 在本机恢复这样的 ZIP，打开它，然后继续聊。

## 为什么由 Host 干活

对话不只是浏览器里的文字。durable 事件日志、附件对象库、工作区注册表都在运行
Host 的那台机器上，所以客户端只负责按两个路由：

| 路由 | 用途 |
| --- | --- |
| `POST /session-takeout/export` | `{ sessionId }` → 写出并定位 ZIP，返回它的路径 |
| `POST /session-takeout/import` | 原始 ZIP 字节 → 恢复会话，返回新的会话 id |
| `POST /session-takeout/reveal` | `{ path }` → 在 Finder 中定位该路径 |

## 压缩包里有什么

```
manifest.json          格式标记、会话摘要、条数、校验和
session/header.json    SessionHeader + inheritedEventCount
session/events.jsonl   完整事件日志，一行一个 JSON 对象
attachments/<id>      对话里用到的每个图片或文件的原始字节
plugin/<file>          插件自身源码，好让这个包能装上它自己
README.md              给人看的说明
```

容器就是普通 ZIP（deflate、UTF-8 文件名、不用 ZIP64），用 `node:zlib` 加一张本地
CRC-32 表写成，没有引入任何依赖。Finder、资源管理器、`unzip` 都能打开；不装这个
插件，对话本身也照样可读。

`manifest.json` 里的 `format` 标记刻意保持为 `dsh-session-bundle`：压缩包格式与项目
名字分开版本化，所以早期版本导出的包在改名之后依旧能导入。

## 导出求稳，导入求稳

- **导出**先通过 sessions 服务把活会话 flush 一遍，否则还在写入的对话会少事件。
  然后读 durable 日志，只拷贝事件真正引用到的附件。
- **导入**在压缩包被完整解析、每个条目 CRC 校验通过之前，绝不动本机的存储。之后它：
  - 把附件恢复进按内容寻址的对象库（已存在的对象直接复用），
  - 按**本机**的会话格式版本写入日志，
  - 把恢复出的会话 `cwd` 指到一个新目录，
  - 如果源 id 在本机已存在，就新铸一个 session id，
  - 把该目录注册成工作区，并把会话挂上去。

因此恢复出来的对话落在 `~/Documents/DeepSeek Harness/<title>-<shortid>/`，这个目录
就是它的工作区——导出方的绝对路径永远不会被复用。

## 拿到一台从没装过这个插件的电脑上

每个导出的 ZIP 都在 `plugin/` 下带着插件自己的源码，所以新机器除了这个压缩包什么
都不需要：

1. 把 ZIP 拷过去并解压。
2. 把 `plugin/` 安装成 bundle（`plugin_manager → install_bundle → <解压目录>/plugin`）。
   在从没跑过这个插件的机器上，让它的 agent 来做这一步即可——agent 也可以直接把 ZIP
   投给路由，完全不用打开任何对话框：
   `curl -X POST http://127.0.0.1:<port>/session-takeout/import --data-binary @bundle.zip`
3. 点 **导入会话包 / Import bundle** 选那个 ZIP（或者让 agent 的请求做同一件事），
   恢复出来的对话会直接打开、可以继续。

## 需要知道的边界

- 附件对象在导出方缺失的，会列进 `manifest.json` 的 `missingAttachments` 里，就是
  不随包走。
- 从别的对话 fork 出来的会话会保留它的 `inheritedEventCount`；父对话的前缀不在本包
  里，所以只会带来存在这份日志里的那一段。
- `agentPreset` 以一个 id 的形式旅行。目标机没装那个预设的话，会话会用默认 agent 打开。

## 安装

```
plugin_manager → install_bundle → target: <本目录>
```

bundle patch 只插入一行，profile 里其他东西都不用改。重启 Web UI（或让客户端插件热
更新），两个按钮就出现在输入框下方。

## 测试

```bash
node test/bundle.test.mjs   # 48 项检查，跑在假服务和一次性 HOME 上
```

## 许可证

MIT
