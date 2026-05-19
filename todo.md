# Sub Magic 实施方案

## 1. 项目基础搭建 ✅

- [x] **更新 wrangler.jsonc**
  - 添加 `kv_namespaces` 绑定 (`SUB_MAGIC`)
  - 添加 `PASSWORD` 环境变量占位 (默认 `admin`)
- [x] **安装依赖**
  - `npm install yaml` - YAML 解析/序列化
- [x] **更新 worker-configuration.d.ts**
  - `npm run cf-typegen` 重新生成类型
- [x] **初始化 KV 配置**
  - `src/config.ts` 中 `initConfigIfEmpty` 在 Worker 启动时自动写入默认配置和 access_key

## 2. 后端核心功能 ✅

### 2.1 配置管理 (`src/config.ts`) ✅

- [x] `getConfig(env)` - 从 KV 读取配置文本
- [x] `saveConfig(env, yaml)` - 写入配置到 KV
- [x] `getParsedConfig(env)` - 解析为结构化对象
- [x] `saveParsedConfig(env, config)` - 序列化并保存
- [x] `initConfigIfEmpty(env)` - 首次部署自动初始化

### 2.2 认证模块 (`src/auth.ts`) ✅

- [x] `verifyPassword(env, password)` - 常量时间比较验证密码
- [x] `generateAccessKey()` - 生成随机订阅 key (UUID)
- [x] `verifyAccessKey(env, key)` - 验证订阅 key
- [x] Session 管理: Cookie-based, 7 天有效期, KV 存储

### 2.3 API 路由 (`src/api.ts`) ✅

- [x] 认证: `POST /api/login`, `POST /api/logout`, `GET /api/check`
- [x] 配置: `GET /api/config`, `PUT /api/config`
- [x] 订阅源: CRUD `/api/config/proxy-providers/:name?`
- [x] 代理组: CRUD `/api/config/proxy-groups/:name?`
- [x] 规则: CRUD `/api/config/rules/:index?`
- [x] 订阅 Key: `GET /api/access-key`, `POST /api/access-key/rotate`
- [x] GeoSite: `POST /api/geosite/parse` - 转发 geosite.dat 给浏览器解析

### 2.4 订阅生成 (`src/subscribe.ts`) ✅

- [x] 从 KV 读取完整配置返回
- [x] Content-Type: `text/yaml; charset=utf-8`
- [x] ETag/If-None-Match 304 缓存支持

### 2.5 YAML 工具 (`src/yaml.ts`) ✅

- [x] `parseConfig` / `serializeConfig` 基于 `yaml` npm 包
- [x] `parseRule` / `serializeRule` 规则字符串解析
- [x] 类型定义: `ProxyProvider`, `ProxyGroup`, `Rule`, `ClashConfig`, `GeneralConfig`, `GeoxUrl`

## 3. 前端管理界面 (`public/`) ✅

### 3.1 页面结构 ✅

- [x] `public/index.html` - SPA 入口
- [x] `public/app.js` - 完整前端逻辑 (原生 JS, 无框架)
- [x] `public/style.css` - 暗色主题样式

### 3.2 功能页面 ✅

- [x] **登录页**: 密码输入,回车登录
- [x] **仪表盘**: 订阅链接展示(复制按钮), Key 轮换, 配置概览
- [x] **订阅源管理**: 列表展示, 添加/编辑表单 (名称、URL、类型、间隔、健康检查、前缀), 删除确认
- [x] **代理组管理**: 列表展示, 添加/编辑 (名称、类型选择、proxies 列表、include-all、filter), 动态显示 url-test 的 tolerance 选项
- [x] **规则管理**: 列表展示 (带类型标签), 添加/编辑 (规则类型选择、参数、代理组、no-resolve), 删除确认
- [x] **文本编辑**: 等宽字体文本框编辑完整 YAML, 保存校验

### 3.3 GeoSite 解析 ✅

- [x] 后端代理下载 geosite.dat (经 geox-url 配置)
- [x] 浏览器端解析 v2fly domain-list-community 格式
- [x] 搜索与分类选择, 自动填入 GEOSITE 规则

## 4. 依赖安装 ✅

- [x] `yaml` - YAML 解析/序列化

## 5. 测试 ✅

- [x] `test/index.spec.ts` - 22 个测试用例
  - YAML 工具测试 (5)
  - 认证测试 (3)
  - 订阅端点测试 (3)
  - API 端点测试 (11)

## 6. 待完成

- [x] **部署**: `npm run deploy`
- [x] **绑定 KV**: Dashboard → Worker → Settings → Variables → KV Namespace Bindings → 添加 `SUB_MAGIC`
- [x] **创建密码**: `npx wrangler secret put PASSWORD`
- [x] 验证完整流程: 部署 → 登录 → 配置 → 获取订阅 → Clash 客户端拉取
- [x] 前端 GeoSite 分类解析增强 (更精确的 protobuf 解析)
- [x] 规则拖拽排序功能 (HTML5 Drag & Drop, PUT /api/config/rules 持久化)
- [x] 代理组 proxies 拖拽排序 (按组内拖拽排序, PUT /api/config/proxy-groups/{name} 持久化)
- [x] 配置历史版本管理 (KV 存储, 列表/查看/恢复/删除, 前端 `save version` + 版本管理界面)
