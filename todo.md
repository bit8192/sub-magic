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

- [x] `public/index.html` - SPA 入口 (ES modules 加载)
- [x] `public/js/app.js` - 入口: 模块导入、全局函数注册、应用启动
- [x] `public/js/` - 14 个 JS 模块 (api, auth, router, state, utils, views/*, parsers/*)
- [x] `public/style.css` - Glassmorphism 暗色科技主题样式

### 3.2 功能页面 ✅

- [x] **登录页**: 密码输入,回车登录
- [x] **首页**: 订阅链接展示(复制按钮), Key 轮换, 配置概览
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

## 6. 部署与增强 ✅

- [x] **部署**: `npm run deploy`
- [x] **绑定 KV**: Dashboard → Worker → Settings → Variables → KV Namespace Bindings → 添加 `SUB_MAGIC`
- [x] **创建密码**: `npx wrangler secret put PASSWORD`
- [x] 验证完整流程: 部署 → 登录 → 配置 → 获取订阅 → Clash 客户端拉取
- [x] 前端 GeoSite 分类解析增强 (更精确的 protobuf 解析)
- [x] 规则拖拽排序功能 (HTML5 Drag & Drop, PUT /api/config/rules 持久化)
- [x] 代理组 proxies 拖拽排序 (按组内拖拽排序, PUT /api/config/proxy-groups/{name} 持久化)
- [x] 配置历史版本管理 (KV 存储, 列表/查看/恢复/删除, 前端 `save version` + 版本管理界面)

## 7. 订阅源用量查询与展示 ✅

- [x] **订阅源用量查询与展示**
  - **后端** (`src/subscription-info.ts`): 新增 `getSubscriptionInfo(env, name)` — 从 Worker 发起 HTTP 请求到 provider 的订阅 URL，解析 `subscription-userinfo` 响应头（upload/download/total bytes，expire Unix 时间戳），解析 `profile-update-interval` 和 `profile-web-page-url`。
  - **User-Agent 支持**: 默认 `clash-verge/v2.1.2`，支持 provider 配置中自定义 `ua` 字段，前端编辑表单已包含 UA 输入。
  - **响应头解析**: RFC 兼容解析器（分号分隔键值对），支持 `upload`、`download`、`total`、`expire`。
  - **代理组名称兜底匹配**: 当 `subscription-userinfo` 头缺失时，解析订阅返回的 YAML，用正则提取代理组名称中的剩余流量（`剩余\s*([\d.]+)(GB|MB|TB)`）、到期时间（`(\d{4}-\d{2}-\d{2})到期`）、总流量等，聚合结果标注「推断」来源。
  - **API 端点**: `POST /api/subscription-info` — 接收 `{ name: "provider1" }`，返回用量数据 `{ upload, download, total, expire, source, details, checkedAt }`。
  - **前端展示**: Provider 卡片内显示渐变进度条（已用/总量百分比）、到期倒计时、上次检查时间；手动刷新单源 / 批量刷新全部；可选自动定时刷新（5 分钟）。
  - **错误处理**: 请求失败/超时时显示错误状态，不阻塞正常流程。

## 8. 前端工程化 — JS 模块拆分 + Hash 路由 ✅

- [x] **app.js 按模块拆分为 14 个 JS 文件**（从 1252 行单文件拆分）:
  ```
  public/js/
  ├── app.js            # 入口: 初始化、全局函数注册、启动
  ├── api.js            # API 客户端 (get/post/put/del) + on401 回调注册
  ├── auth.js           # 登录/登出/checkAuth + onLoggedIn 回调
  ├── router.js         # Hash 路由: renderApp/switchView/hashchange 监听
  ├── state.js          # 全局共享状态 (currentView, groupsData, rulesData 等)
  ├── utils.js          # esc(), toast(), showModal(), closeModal()
  ├── views/
  │   ├── index.js     # 首页: 订阅链接、Key 轮换、配置概览
  │   ├── providers.js  # 订阅源管理: 列表/增删改/用量查询展示
  │   ├── groups.js     # 代理组管理: 列表/增删改/拖拽排序/multi-select
  │   ├── rules.js      # 规则管理: 列表/增删改/拖拽排序/GeoSite/GeoIP 选择器
  │   ├── editor.js     # YAML 文本编辑器
  │   └── versions.js   # 配置历史版本管理
  └── parsers/
      ├── geosite.js    # GeoSite.dat 二进制 protobuf 解析 (4 策略)
      └── geoip.js      # GeoIP.dat 二进制 protobuf 解析 (4 策略) + 国家名称映射
  ```
  - **加载方式**: ES modules (`<script type="module" src="/js/app.js">`)，Cloudflare Workers Assets 原生支持。
  - **全局状态收敛**: `state.js` 导出共享状态，各模块通过 import 共享，避免全局变量污染。
  - **向后兼容**: `app.js` 将视图函数注册到 `window` 对象，保留 inline `onclick` 处理器。

- [x] **Hash 路由实现**
  - `window.location.hash` 驱动: `#/dashboard`, `#/providers`, `#/groups`, `#/rules`, `#/editor`, `#/versions`, `#/login`
  - `hashchange` 事件监听，自动触发对应视图渲染
  - 编程式导航: `window.switchView('providers')` + `history.replaceState` 同步 hash
  - 导航守卫: `handleHashChange` 中调用 `/api/check`，未登录时渲染登录页
  - 浏览器前进/后退按钮原生可用
  - 防重入保护: `handling` 标志位防止 hashchange 循环触发
  - 顶栏导航按钮高亮当前激活项，绑定到 `switchView()`

## 9. UI 现代化美化 ✅

- [x] **UI 全面美化 — Glassmorphism 暗色科技主题**
  - **CSS 变量驱动**: `:root` 中定义全部设计 Token（15+ 变量），统一配色/间距/圆角/动效。
  - **配色方案**: 主背景 `#0a0a0f` + 径向渐变光晕，毛玻璃面板 `backdrop-filter: blur(16px)`，青紫渐变强调色 `#00d4ff → #7c3aed`，霓虹绿成功 `#00ff88`，玫红错误 `#ff3366`。
  - **排版**: 系统字体栈 (Inter, SF Pro, Segoe UI)，等宽 JetBrains Mono，行高 1.6，卡片圆角 12px，按钮圆角 8px。
  - **动效**:
    - fadeInUp: 页面/卡片淡入上移 (0.35s)
    - modalIn: 模态框弹簧缩放进入 (cubic-bezier 弹性缓动)
    - toastIn: Toast 从右侧滑入
    - shimmer: 进度条光泽流动动画
    - slideDown: 用量信息展开动画
  - **组件增强**:
    - 按钮: 渐变背景 + hover 发光阴影 + 上浮位移
    - 输入框: 聚焦时蓝光延展 (box-shadow glow)
    - 自定义 checkbox: CSS only，青紫渐变填充 + 对勾
    - 进度条: 渐变背景 + shimmer 光泽流动
    - 模态框: backdrop 模糊 + 弹簧缩放进入
    - 标签/徽章: 半透明背景 + 细边框 + 语义化颜色
    - Topbar: 毛玻璃导航栏，标题渐变色文字
    - 自定义滚动条: 细窄暗色
  - **响应式**: 移动端 topbar 纵向折叠、表单单列、模态框全宽、key-display 纵向排列。
  - **文件**: 重写 `public/style.css` (~350 行)，CSS 变量全量驱动。
