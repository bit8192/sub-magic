# Sub Magic

Sub Magic 是一个运行在 Cloudflare Workers 上的自定义 Clash 订阅管理工具。它提供了一个 Web 管理界面,让您能便捷地管理 Clash 订阅配置、代理组和路由规则,并自动生成带认证密钥的订阅链接供客户端使用。

## 功能

- **订阅管理**: 在 Web UI 中管理 `proxy-providers`,支持添加/编辑/删除多个远程订阅源
- **代理组管理**: 可视化编辑 `proxy-groups`,支持 `select`、`url-test`、`fallback`、`load-balance` 等类型
- **路由规则管理**: 管理 `rules` 的增删改,支持 `GEOIP`、`GEOSITE`、`MATCH`、`DOMAIN-SUFFIX`、`DOMAIN-KEYWORD` 等规则类型
- **GeoSite 解析**: 当配置了 `geox-url` 时,可在浏览器端下载并解析 `geosite.dat` 文件,辅助配置 `GEOSITE` 规则
- **文本编辑器**: 支持直接修改完整的配置文件 YAML 文本内容
- **密钥认证**: 通过环境变量配置访问密码,管理页面需登录后使用
- **自动生成订阅链接**: 管理后台自动生成带唯一 Key 的订阅 URL,可直接填入 Clash 客户端使用

## 架构

```
用户浏览器  ──▶  Cloudflare Worker  ──▶  Cloudflare KV (配置存储)
                    │
                    ▼
               Clash 客户端 (通过订阅链接拉取配置)
```

- **Cloudflare Workers**: 核心服务,处理管理界面、API 请求和订阅生成
- **Cloudflare KV**: 持久化存储配置文件、访问密钥等数据
- **静态资源**: `public/` 目录中的前端页面通过 Workers Assets 直接托管

## 快速开始

### 前置要求

- Node.js >= 18
- 一个 Cloudflare 账户
- 已安装并配置好 Wrangler CLI (`npm install -g wrangler`)

### 安装

```bash
git clone <repo-url>
cd sub-magic
npm install
```

### 配置

1. 创建 KV 命名空间:
   ```bash
   npx wrangler kv:namespace create SUB_MAGIC
   ```

2. 更新 `wrangler.jsonc`,添加 KV 绑定:
   ```jsonc
   "kv_namespaces": [
     {
       "binding": "SUB_MAGIC",
       "id": "<your-kv-namespace-id>"
     }
   ]
   ```

3. 创建管理后台密码:
   ```bash
   npx wrangler secret put PASSWORD
   ```

4. (可选) 修改 `default.conf` 作为初始配置模板

5. 生成类型定义:
   ```bash
   npm run cf-typegen
   ```

### 本地开发

```bash
npm run dev
```

访问 `http://localhost:8787` 进入管理界面。

### 部署

```bash
npm run deploy
```

## 使用说明

### 管理界面

部署后访问 Worker 域名,使用配置的密码登录。

### 订阅链接

登录后可在首页获取订阅链接,格式为:

```
https://your-worker.example.com/sub/{key}
```

将链接填入 Clash 客户端即可。

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `PASSWORD` | 是 | 管理后台登录密码 |
| `SUB_MAGIC` | 是 | KV 命名空间绑定,用于存储配置 |

## 配置参考

配置遵循 Clash Meta 内核格式:

- [General](https://wiki.metacubex.one/config/general/)
- [Proxy Providers](https://wiki.metacubex.one/config/proxy-providers/)
- [Proxy Groups](https://wiki.metacubex.one/config/proxy-groups/)
- [Rules](https://wiki.metacubex.one/config/rules/)

## License

MIT
