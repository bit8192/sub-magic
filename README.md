# Sub Magic

Sub Magic 是一个运行在 Cloudflare Workers 上的 Mihomo/Clash Meta 配置管理工具。它提供 Web 管理界面、受 Key 保护的订阅分发接口，以及一个配套浏览器扩展，用于快速查看当前站点的路由链路并回写规则。

## 功能概览

- 订阅配置托管：完整配置保存在 Cloudflare KV，通过 `/sub/{key}` 输出 YAML 订阅。
- Web 管理后台：基于密码登录，支持 SPA 管理界面。
- 订阅源管理：管理 `proxy-providers`，支持增删改、UA 设置、健康检查字段、用量查询与刷新。
- 代理组管理：管理 `proxy-groups`，支持 `select`、`url-test`、`fallback`、`load-balance`、`relay`，支持显式成员、`use` provider、`include-all` 系列与过滤项。
- 规则管理：管理 `rules`，支持拖拽排序、常见规则类型、逻辑规则、`RULE-SET`、`SUB-RULE`、`MATCH` 等。
- GeoSite / GeoIP 选择器：浏览器端解析 `geosite.dat` / `geoip.dat`，辅助回填规则。
- YAML 文本编辑：直接编辑完整配置文本。
- 历史版本管理：保存、查看、恢复、删除配置快照。
- 订阅 Key 管理：查看与轮换访问 Key。
- 浏览器扩展：查询当前页面命中的路由链路，并调用后端 API 快速新增/更新规则。

## 当前界面能力

管理后台包含以下页面：

- 首页：订阅链接、Key 轮换、配置概览、历史版本计数。
- 订阅源：列表、表单编辑、单源刷新、批量刷新、用量进度条与到期信息。
- 代理组：列表、表单编辑、显式 `proxies` 拖拽排序。
- 规则：列表、表单编辑、拖拽排序、GeoSite/GeoIP 选择器。
- 文本编辑：直接修改完整 YAML。
- 历史版本：保存、查看、恢复、删除。

## 架构

```text
浏览器 / 浏览器扩展
        │
        ▼
Cloudflare Worker
  ├─ 管理界面静态资源
  ├─ API
  └─ /sub/{key} 订阅输出
        │
        ▼
Cloudflare KV
  ├─ config
  ├─ access_key
  ├─ session:*
  └─ versions:*
```

## 技术栈

- Cloudflare Workers
- Cloudflare KV
- 原生 ES Modules 前端
- `yaml`
- Vitest + `@cloudflare/vitest-pool-workers`
- Firefox Manifest V3 浏览器扩展

## 快速开始

### 前置要求

- Node.js 18+
- Cloudflare 账户
- Wrangler CLI

### 安装依赖

```bash
npm install
```

### 配置 Cloudflare

1. 创建 KV Namespace。
2. 在 `wrangler.jsonc` 中绑定 `SUB_MAGIC`。
3. 设置后台密码：

```bash
npx wrangler secret put PASSWORD
```

4. 如果你修改了 `wrangler.jsonc` 中的绑定，重新生成类型：

```bash
npm run cf-typegen
```

### 本地开发

```bash
npm run dev
```

常用命令：

```bash
npm run dev
npm run deploy
npm run test
npm run cf-typegen
```

### 部署

```bash
npm run deploy
```

首次启动时，Worker 会在 KV 中自动初始化默认配置和访问 Key。

## 使用说明

### 登录后台

部署后访问 Worker 域名，使用 `PASSWORD` 登录。

### 订阅链接

首页会显示当前订阅链接：

```text
https://your-worker.example.com/sub/{key}
```

可直接填入 Mihomo / Clash Meta 客户端。

订阅接口支持标准 `ETag / If-None-Match` 条件请求：

- 普通客户端请求 `/sub/{key}` 时，Worker 会立即返回结果。
- 配置未变化时返回 `304 Not Modified`。
- 配置有变化时返回 `200` 和最新 YAML 内容。

### Linux 自动更新

首页提供 Linux 安装命令，会安装一个 systemd 用户级定时器与更新脚本。

- 定时器固定每 `30s` 触发一次。
- 更新脚本请求订阅时会携带 `If-None-Match` 和专用请求头 `X-Sub-Magic-Long-Poll: 1`。
- Worker 仅对带该请求头的请求启用 KV 伪长轮询。
- 当客户端 `ETag` 与当前配置一致时，Worker 会每 `3s` 检查一次 KV，最多检查 `10` 次，总等待约 `30s`。
- 在等待期间如果检测到配置变化，会立即返回 `200` 和最新 YAML。
- 如果等待结束仍无变化，则返回 `304`，客户端在下一次定时触发时继续请求。

这种实现依赖 Cloudflare KV 读取来近似长轮询，适合个人使用场景；如果后续需要更稳定的“更新即返回”语义，可再迁移到 Durable Objects。

### 规则快速写入 API

除后台外，服务还提供两个给浏览器扩展使用的接口：

- `POST /api/rules/add`
- `POST /api/rules/update`

它们基于访问 Key 写入规则，无需后台会话。

## 浏览器扩展

仓库包含一个 Firefox 扩展，目录为 [browser-extension](./browser-extension)。

主要功能：

- 读取当前页面相关路由信息。
- 显示命中的规则链路与可选代理组。
- 调用 `add` / `update` 快速把规则写回 Worker。

构建扩展：

```bash
npm run build:extension
```

扩展内部单独构建：

```bash
cd browser-extension
npm install
npm run build
```

如需 Firefox 签名，可参考 [browser-extension/.env.example](./browser-extension/.env.example)。

## 项目结构

```text
src/
  api.ts                Worker API
  auth.ts               登录与会话
  config.ts             KV 配置/版本管理
  subscribe.ts          订阅输出
  subscription-info.ts  订阅源用量查询
  yaml.ts               配置与规则解析/序列化

public/
  index.html
  style.css
  js/
    app.js
    api.js
    auth.js
    router.js
    state.js
    utils.js
    views/
    parsers/

browser-extension/
  src/background/
  src/popup/
  src/options/
```

## API 概览

认证与会话：

- `POST /api/login`
- `POST /api/logout`
- `GET /api/check`

配置与订阅：

- `GET /api/config`
- `PUT /api/config`
- `GET /api/config/meta`
- `GET /sub/{key}`

订阅源：

- `GET/POST /api/config/proxy-providers`
- `PUT/DELETE /api/config/proxy-providers/{name}`
- `POST /api/subscription-info`

代理组：

- `GET/POST /api/config/proxy-groups`
- `PUT/DELETE /api/config/proxy-groups/{name}`

规则：

- `GET/POST/PUT /api/config/rules`
- `PUT/DELETE /api/config/rules/{index}`
- `POST /api/rules/add`
- `POST /api/rules/update`

版本与 Key：

- `GET/POST /api/config/versions`
- `GET/DELETE /api/config/versions/{id}`
- `POST /api/config/versions/{id}/restore`
- `GET /api/access-key`
- `POST /api/access-key/rotate`

## 配置格式参考

项目以 Mihomo 配置格式为准，可参考：

- [General](https://wiki.metacubex.one/config/general/)
- [Proxy Providers](https://wiki.metacubex.one/config/proxy-providers/)
- [Proxy Groups](https://wiki.metacubex.one/config/proxy-groups/)
- [Rules](https://wiki.metacubex.one/config/rules/)

本仓库还提供一个较完整的示例文件：[full-config-demo.yaml](./full-config-demo.yaml)。

## 测试

```bash
npm run test
```

如果你调整了 Worker 绑定或运行环境，测试依赖 Wrangler/Miniflare 的本地运行能力。

## License

MIT
