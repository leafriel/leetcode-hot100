# LeetCode Hot 100 刷题（本地版）

纯静态网页应用：100 道题、核心代码 / ACM 双模式判题（Python + JavaScript + C++）、错题复习、知识补充、AI 助手问答。无需安装依赖、无需构建，整个文件夹拷贝即可带走。

## 一键启动

| 系统 | 方式 |
|---|---|
| macOS | 双击 `一键启动(MACOS).command`（首次如被拦截：系统设置 → 隐私与安全性 → 仍要打开） |
| Windows | 双击 `一键启动（WIN）.bat` |
| Linux / 终端 | `bash start.sh` |

Windows：双击 `一键启动（WIN）.bat`，同时在后台启动网页服务（`127.0.0.1:8931`）和 AI 代理（`127.0.0.1:8966`），检查成功后打开浏览器。需要安装 Node.js 18+。重复双击会复用已运行的服务；端口被其他程序占用时会显示错误。关闭浏览器不停止服务，重启电脑后需再次双击启动。日志位于项目根目录的 `server.log`、`server-error.log`、`proxy.log` 和 `proxy-error.log`。

macOS / Linux：脚本会自动选择空闲端口（8931 起）、启动本地服务器并打开浏览器。停止：按 `Ctrl+C` 或关闭窗口。

macOS / Linux 要求：电脑上装有 **Python 3** 或 **Node.js** 之一。

> 注意：不能直接双击 `index.html` 打开——浏览器的 ES Module 和 Worker 在 `file://` 协议下无法工作，必须通过上面的本地服务器访问。

## 换电脑 / 迁移数据

进度、草稿、错题、偏好都保存在当前浏览器的 localStorage 中，**不会随文件夹自动带走**。迁移方法：

1. 旧电脑：题库首页 →「导出备份」，得到 JSON 文件。
2. 新电脑：题库首页 →「导入备份」，选择「完整替换」。

## 网络要求

**JavaScript / Python 判题完全离线可用。** 以下运行时均已自托管到 `vendor/`（共约 25MB），断网也能正常使用：

- `vendor/pyodide/`（约 12MB）：Python 判题环境。
- `vendor/monaco/`（约 13MB）：代码编辑器（语法高亮、错误标红）。

**C++ 判题需联网**：浏览器无法本地编译 C++，提交后会发送到免费的公共远程编译服务（Judge0，不可达时自动回退 Wandbox）编译执行；代码会离开本机，请勿粘贴敏感内容。断网时 C++ 会提示需要联网，Python / JavaScript 不受影响。

`vendor/` 目录缺失或损坏时，两者都会自动回退 CDN 加载（需联网）；编辑器加载彻底失败时还会降级为普通文本框，不影响判题。

> **源码仓库说明**：GitHub 仓库不含 `vendor/`（体积大且为第三方构建产物，`.gitignore` 已排除）。克隆后直接启动即可正常使用（编辑器和 Python 判题走 CDN 回退，需联网）；需要完全离线时把 `vendor/` 放回项目根目录即可。

### AI 助手（可选，需联网）

点击屏幕右边缘的「AI 助手」竖条即可向大模型提问；在题目页 / 知识文章页会默认附带当前内容（含你的草稿代码）作为上下文，输入框上方可取消勾选。

- 支持任意 **OpenAI 兼容 API**：内置 Kimi (Moonshot)、DeepSeek、OpenAI 预设，也可填自定义接口地址。
- API Key 只保存在当前浏览器的 localStorage 中，**不会随备份导出**（「替换现有数据」方式导入备份会将其清除，需重新填写）。
- 浏览器直连 API 取决于服务商的跨域策略；Moonshot / DeepSeek / OpenAI 官方端点均支持浏览器直接调用。
- 个别端点（如 Kimi 编程套餐的 `https://api.kimi.com/coding/v1`）不支持浏览器跨域：直接填进配置即可，程序会**自动改走本地 CORS 代理**（`tools/cors-proxy.mjs`，仅监听 127.0.0.1:8966，只转发到该目标地址）。一键启动脚本在有 Node.js 时会自动拉起该代理；手动启动：`node tools/cors-proxy.mjs`。

## 常见问题

- **端口被占用**：Windows 会复用已运行的服务；若被其他程序占用，请先关闭该程序。macOS / Linux 脚本会自动尝试 8931–8951。
- **Python 一直加载中**：检查网络能否访问 jsDelivr CDN；或切换到 JavaScript 语言继续刷题。
- **想恢复出厂**：清除浏览器该站点的网站数据即可（localStorage）。

## 开发校验

```bash
npm test   # manifest 检查 + 单元测试 + 100 题六套参考答案全量校验
```

全量校验需要本机有 `python3`（校验 Python 参考代码）和 `g++`（校验 C++ 参考代码；缺失时 C++ 校验自动跳过并打印警告）。

## 免责声明

- 本项目为个人学习用途的非官方项目，与 LeetCode / 力扣 无任何隶属或授权关系；"LeetCode" 及相关题目内容（题名、题面、示例）的版权归 LeetCode 所有，仅作个人学习参考，请勿用于商业用途。如有版权问题请联系删除。
- 项目自有代码以 [MIT License](LICENSE) 发布；`vendor/` 内第三方组件（Monaco Editor、Pyodide）的许可见其各自的声明文件 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
