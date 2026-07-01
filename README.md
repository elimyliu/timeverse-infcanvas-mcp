# Timeverse InfCanvas MCP Server

本地无限画布的 **MCP Server**，让 AI 客户端（Claude Desktop / Cursor 等）通过 [Model Context Protocol](https://modelcontextprotocol.io) 直接读写本地画布数据。

## 项目结构

```
timeverse-InfCanvas-mcp/
├── mcp-server/          ← MCP 协议服务（核心）
│   ├── server.mjs           MCP Server 主入口
│   ├── canvas-store.mjs     画布数据读写
│   ├── image-generator.mjs  大模型生图
│   ├── fractional-indexing.mjs  z-order 排序
│   ├── overlap-detector.mjs    碰撞检测
│   ├── seed-demo.mjs        演示数据生成
│   ├── test.mjs             冒烟测试
│   ├── package.json         依赖声明
│   └── node_modules/
├── web-server/          ← HTTP 可视化服务
│   └── web-server.mjs      画布浏览器查看 + 编辑 API
├── client/              ← React + tldraw 编辑器
│   ├── src/                 React 源码
│   ├── dist/                构建产物
│   └── package.json
├── canvas/              ← 画布数据目录
├── package.json             根项目脚本
├── LICENSE
└── README.md
```

## 架构

```
AI 客户端 ──(stdio JSON-RPC)──> mcp-server/server.mjs
                                    │
                                    ├── canvas-store.mjs     canvas/*.json
                                    ├── image-generator.mjs  模型 API
                                    ├── fractional-indexing.mjs
                                    └── overlap-detector.mjs

浏览器    ──(HTTP)──> web-server/web-server.mjs
                          │
                          ├── canvas/*.json   (读取画布)
                          └── client/dist/    (前端静态文件)
```

三个模块，各司其职：

| 模块 | 职责 | 技术栈 |
|------|------|--------|
| **mcp-server** | MCP 协议通信，AI 调用工具读写画布 | Node.js ESM, `@modelcontextprotocol/sdk` |
| **web-server** | HTTP 可视化，浏览器实时查看/编辑画布 | Node.js 原生 http 模块（零依赖） |
| **client** | 前端编辑器（可选），tldraw 专业图形界面 | React 18, tldraw 5, Vite |

## 安装

```bash
# 克隆项目
git clone <repo-url>
cd timeverse-InfCanvas-mcp

# 安装 MCP Server 依赖
cd mcp-server && npm install

# （可选）构建前端编辑器
cd ../client && npm install && npm run build
```

## 在 AI 客户端中配置

MCP Server 通过 **stdio 协议**与 AI 客户端通信，配置时指向 `mcp-server/server.mjs`。

### Claude Desktop

编辑 `claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "infcanvas": {
      "command": "node",
      "args": ["D:/path/to/timeverse-InfCanvas-mcp/mcp-server/server.mjs"],
      "env": {
        "INF_CANVAS_DIR": "D:/path/to/your-project",
        "REPLICATE_API_KEY": "r-xxxxx"
      }
    }
  }
}
```

### Cursor

编辑 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "infcanvas": {
      "command": "node",
      "args": ["D:/path/to/timeverse-InfCanvas-mcp/mcp-server/server.mjs"]
    }
  }
}
```

### 自研客户端

支持以下方式集成：

**方式一：JSON 配置（适用于支持 MCP 配置文件的客户端）**

```json
{
  "mcpServers": {
    "infcanvas": {
      "command": "node",
      "args": ["D:/path/to/timeverse-InfCanvas-mcp/mcp-server/server.mjs"],
      "env": {
        "INF_CANVAS_DIR": "D:/my-project"
      }
    }
  }
}
```

**方式二：通过 npx（无需本地安装，自动从 npm 拉取）**

```json
{
  "mcpServers": {
    "infcanvas": {
      "command": "npx",
      "args": ["-y", "timeverse-infcanvas-mcp"],
      "env": {
        "INF_CANVAS_DIR": "D:/my-project"
      }
    }
  }
}
```

> 注意：`timeverse-infcanvas-mcp` 尚未发布到 npm，发布后方可使用此方式。

**方式三：代码中通过 stdio 启动子进程**

```js
const { spawn } = require('node:child_process')
const cp = spawn('node', ['D:/path/to/mcp-server/server.mjs'], {
  env: { ...process.env, INF_CANVAS_DIR: 'D:/my-project' },
  stdio: ['pipe', 'pipe', 'pipe'],
})
// 通过 stdin/stdout 收发 JSON-RPC 2.0 消息
```

## 暴露的 MCP 工具

所有数据操作工具都需要 `projectDir` 参数（指定项目目录，在其下创建 `canvas/` 文件夹）：

| 工具 | 用途 | 必填参数 |
|------|------|---------|
| `get_canvas_snapshot` | 获取画布全量数据 | `projectDir` |
| `get_selection` | 读取当前用户选区 | `projectDir` |
| `list_pages` | 列出所有页面 | `projectDir` |
| `create_page` | 新建页面 | `projectDir` |
| `switch_page` | 切换当前页面 | `projectDir`, `pageId` |
| `create_ai_image_holder` | 创建 AI 图片占位框 | `projectDir` |
| `insert_image` | 插入图片（本地路径或 URL） | `projectDir`, `sourcePath` |
| `fill_ai_holder` | 把已有 asset 填入占位框 | `projectDir`, `holderId`, `assetId` |
| `update_shape` | 更新 shape 位置/属性 | `projectDir`, `shapeId` |
| `update_shape_status` | 流式更新生成状态与进度 | `projectDir`, `shapeId`, `status` |
| `delete_shapes` | 删除多个 shape | `projectDir`, `shapeIds` |
| `generate_image` | 大模型生图并直接填入画布 | `projectDir`, `prompt` |
| `start_web_server` | 启动 HTTP 可视化服务（无 projectDir 也可调用） | — |

### start_web_server

AI 调用此工具后，会在本地启动 HTTP 服务，打开浏览器即可实时查看/操作画布：

```json
{
  "name": "start_web_server",
  "arguments": { "port": 3000 }
}
```

返回 `{ "url": "http://localhost:3000", "status": "started" }`。重复调用不会重复启动，浏览器打开 [http://localhost:3000](http://localhost:3000) 即可查看画布。

## 手动启动

```bash
# MCP Server（stdio 交互，通常由 AI 客户端自动拉起）
npm start

# Web 可视化服务
npm run web
# 浏览器打开 http://localhost:3000

# 前端开发模式
npm run dev:client

# 构建前端
npm run build:client
```

## 环境变量

| 变量 | 用途 | 必填 |
|------|------|------|
| `INF_CANVAS_DIR` | 兜底项目目录（不填则每次调用传 `projectDir`） | 否 |
| `OPENAI_API_KEY` | OpenAI API Key（DALL-E 3 生图） | 按需 |
| `OPENAI_API_ENDPOINT` | OpenAI 端点，默认 `https://api.openai.com/v1` | 否 |
| `REPLICATE_API_KEY` | Replicate API Token（Flux / SDXL 生图） | 按需 |
| `CUSTOM_API_ENDPOINT` | 自研模型 HTTP 端点 | 按需 |
| `CUSTOM_API_KEY` | 自研模型 API Key | 按需 |

## 大模型生图

支持的模型（通过环境变量路由）：

| model | 依赖 |
|-------|------|
| `dall-e-3` | `OPENAI_API_KEY` |
| `flux-schnell` | `REPLICATE_API_KEY` |
| `sdxl` | `REPLICATE_API_KEY` |
| `custom` | `CUSTOM_API_ENDPOINT` + `CUSTOM_API_KEY` |

工具参数中传 `endpoint` 和 `apiKey` 可临时覆盖环境变量。

## 测试

```bash
cd mcp-server
node test.mjs
```

冒烟测试会验证 MCP 协议通信、数据隔离、工具调用等核心功能。

## 画布数据格式

```
<project>/canvas/
├── canvas.json             画布索引（页面、shape 列表、资源）
├── selection.json          当前选区
├── view-state.json         视口状态（相机位置、当前页）
└── shapes/                 独立 shape 文件（每个 .json）
```

## 三方鸣谢

- **[tldraw](https://github.com/tldraw/tldraw)** — 前端编辑器基于 tldraw v5，提供专业级的无限画布交互体验
- **[Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk)** — MCP 协议实现
- **[React](https://react.dev)** + **[Vite](https://vite.dev)** — 前端工程化
- **[Replicate](https://replicate.com)** — Flux / SDXL 模型推理
- **[OpenAI](https://openai.com)** — DALL-E 3 图片生成

## 许可证

MIT © 2024-2026 TimeVerse Studio

完整许可见 [LICENSE](LICENSE)。
