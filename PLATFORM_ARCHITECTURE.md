# SillyTavern 商业化平台架构方案

## 一、背景与核心矛盾

### 1.1 SillyTavern 原生现状

- **前端**：纯 JavaScript（229 个 JS 文件），基于 jQuery，无框架（非 React/Vue/TS）
- **后端**：纯 JavaScript（95 个 JS 文件），基于 Express.js，Node.js 运行
- **前后端契约**：约 200 个 API 路由，分布在 45 个 endpoint 文件中
- **数据存储**：全部基于本地文件系统（`data/` 目录下的 JSON/JSONL 文件）
- **关键事实**：prompt 引擎（Prompt Manager、宏替换、世界书注入、instruct 格式化等约 1.5 万行核心逻辑）全部运行在前端，后端仅做 LLM API 透传代理

### 1.2 商业化需求

- 平台使用 TypeScript 全栈作为技术栈
- 需要自有的用户管理、计费、大厅等平台功能
- 需要降低用户使用门槛：隐藏 99% 的原生按钮，只保留核心对话体验
- 需要保留 ST 完整的 prompt 引擎能力（世界书、宏替换、预设等）
- 后续能渐进式开放更多 ST 原生功能
- 数据统一迁移至 Supabase

### 1.3 核心矛盾

ST 原生代码量巨大（前后端合计数万行），无法也不应该直接改写。但 prompt 引擎在前端，抛弃前端就丢失核心能力；保留前端又要面对巨大的维护复杂度。

**解决思路**：将 ST 视为一个完整的子系统，通过进程隔离（后端）和 iframe 隔离（前端）与自有平台共存，互不侵入。

---

## 二、整体架构

### 2.1 架构总览

```
┌─────────────────────────────────────────────────────┐
│                    用户浏览器                         │
│                                                      │
│  ┌──────────────────────┐  ┌──────────────────────┐  │
│  │   你的前端页面         │  │   iframe（ST 前端）   │  │
│  │   (TS + React/Vue)   │  │   (原生 JS + jQuery) │  │
│  │                      │  │                      │  │
│  │  ┌────────────────┐  │  │  ┌────────────────┐  │  │
│  │  │ 大厅 / 角色选择 │  │  │  │ 对话消息列表    │  │  │
│  │  │ 个人中心       │  │  │  │ 输入框         │  │  │
│  │  │ 计费 / 订单    │  │  │  │ 流式渲染       │  │  │
│  │  │ 自定义功能按钮  │  │  │  │ swipe 切换     │  │  │
│  │  └────────────────┘  │  │  └────────────────┘  │  │
│  │           │           │  │          ▲           │  │
│  └───────────┼───────────┘  └──────────┼───────────┘  │
│              │ postMessage             │              │
│              └─────────────────────────┘              │
└──────────────────────┬──────────────────────────┬─────┘
                       │                          │
              ┌────────▼────────┐       ┌─────────▼────────┐
              │  nginx (:443)   │       │                  │
              │  反向代理        │       │                  │
              ├─────────────────┤       │                  │
              │ /             → 你的前端静态资源             │
              │ /tavern/      → ST 前端 (:8000)            │
              │ /api/platform/→ 你的 TS 后端 (:3000)       │
              │ /api/         → ST 后端 (:8000)            │
              └────────┬──────────────────┬────────────────┘
                       │                  │
              ┌────────▼────────┐  ┌──────▼──────────┐
              │ 你的 TS 后端     │  │ ST 原生后端      │
              │ (:3000)         │  │ (:8000)         │
              │                 │  │                 │
              │ 用户管理         │  │ ~200 个 API 路由 │
              │ 计费系统         │  │ 角色卡 CRUD      │
              │ 推荐算法         │  │ 聊天记录管理     │
              │ 平台特有功能     │  │ LLM API 代理    │
              └────────┬────────┘  └──────┬──────────┘
                       │                  │
                       │    ┌─────────┐   │
                       └───►│Supabase │◄──┘ (ST 通过同步层)
                            │ (共享)  │
                            └─────────┘
```

### 2.2 四层隔离设计

| 层级 | 隔离方式 | 说明 |
|------|---------|------|
| 后端进程 | 两个独立 Node.js 进程 | 你的 TS 后端 (:3000) + ST 后端 (:8000)，通过 nginx 统一入口 |
| 前端运行时 | iframe 隔离 | 你的页面和 ST 前端运行在不同的浏览器上下文中，互不污染 |
| 数据存储 | 同一个 Supabase 项目，职责分区 | 平台表由你的后端读写，ST 数据通过同步层写入 |
| 网络入口 | nginx 反向代理 | 对外一个域名，按路径分发到不同后端 |

---

## 三、后端架构详解

### 3.1 两个后端进程并行

**为什么不合并成一个后端？**

ST 后端有 95 个 JS 文件、45 个 endpoint 模块、约 200 个 API 路由。如果要合并到你的 TS 后端中，意味着要么把 ST 的 JS 代码全部改写为 TS，要么在一个项目中混用 JS/TS。两者都会导致巨大的工程量和后续维护噩梦。保持两个独立进程，ST 代码零修改，可以直接跟随社区版本升级（`git pull`）。

**进程 1：你的 TS 后端 (:3000)**

```
负责：
  ├── 用户注册 / 登录 / 鉴权
  ├── 计费 / 订单 / 套餐管理
  ├── 大厅推荐算法
  ├── 平台运营后台
  └── 其他 ST 没有的业务功能
```

**进程 2：ST 原生后端 (:8000)**

```
负责（不做任何修改，原样运行）：
  ├── 角色卡 CRUD      POST /api/characters/*
  ├── 聊天记录管理      POST /api/chats/*
  ├── LLM 生成代理     POST /api/backends/*/generate
  ├── 预设管理         POST /api/presets/*
  ├── 世界书管理       POST /api/worldinfo/*
  ├── TTS / 图片生成   POST /api/extra/*
  └── 其他 ~200 个原生路由
```

### 3.2 nginx 反向代理配置

```nginx
server {
    listen 443 ssl;
    server_name your-platform.com;

    # 你的前端静态资源
    location / {
        root /path/to/your/frontend/dist;
        try_files $uri $uri/ /index.html;
    }

    # ST 前端（iframe 加载用）
    location /tavern/ {
        proxy_pass http://127.0.0.1:8000/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # 你的后端 API
    location /api/platform/ {
        proxy_pass http://127.0.0.1:3000/;
    }

    # ST 后端 API
    location /api/ {
        proxy_pass http://127.0.0.1:8000/api/;
    }
}
```

### 3.3 鉴权拦截

nginx 层或你的 TS 后端做统一鉴权。用户未登录时，两个后端的 API 都不可达：

```
用户请求 → nginx → 检查登录态（JWT/Cookie）
  ├── 未登录 → 拒绝，重定向到登录页
  ├── 已登录 → 按路径转发到对应后端
```

ST 的原生用户系统可以直接复用，不需要自己再建一套。

### 3.4 数据存储方案（Supabase）

**为什么不直接改 ST 的存储层？**

ST 的所有数据操作都是 `fs.readFileSync` / `fs.writeFileSync`，散布在 45 个 endpoint 文件里。如果逐一改成 Supabase SDK 调用，侵入性极强，ST 每次升级都会产生大量合并冲突。

**方案：同步层（ST 代码零修改）**

```
ST 后端 ←→ 本地 data/ 目录（照常读写，零修改）
                    ↕
             同步服务（你写的）
                    ↕
              Supabase 数据库
```

同步服务 watch `data/` 目录的文件变化，将增量同步到 Supabase。你的平台后端直接读 Supabase。

**Supabase 表的职责分区**：

```
Supabase（一个项目）
  │
  ├── 平台业务表（你的 TS 后端直接读写）
  │     users, billing, orders, recommendations ...
  │
  ├── ST 数据表（通过同步层写入，两边都可以读）
  │     characters, chats, presets, worldinfo ...
  │
  └── 共享表
        users 是典型 — 平台写入注册信息，ST 读取做鉴权
```

---

## 四、前端架构详解

### 4.1 为什么必须保留 ST 前端

ST 的 prompt 引擎核心逻辑全在前端（`public/` 目录），包括：

| 模块 | 文件 | 代码行数 | 功能 |
|------|------|---------|------|
| 主生成函数 | `script.js` Generate() | ~1500 行 | 组装完整 prompt，协调所有模块 |
| 宏替换 | `script.js` substituteParams() | ~400 行 | `{{char}}`、`{{user}}` 等变量替换 |
| 世界书 | `world-info.js` | 6289 行 | 关键词触发、条目注入、深度控制 |
| Prompt 排版 | `PromptManager.js` | 2144 行 | prompt 顺序编排、token 预算分配 |
| OpenAI 格式化 | `openai.js` | 7249 行 | messages 数组构建、system/user/assistant 角色分配 |
| instruct 模式 | `instruct-mode.js` | - | 不同模型的指令格式适配 |

**后端只做透传**：收到前端组装好的完整 prompt → 转发给 LLM API → 返回结果。

如果抛弃 ST 前端，这 1.5 万行 prompt 引擎全部需要自己重写。这是不可接受的工程量，而且丢失了 ST 社区多年打磨的 prompt 优化经验。

### 4.2 iframe 隔离方案

**为什么用 iframe 而不是直接混合两套前端代码？**

- ST 前端是原生 JS + jQuery，你的平台是 TS + React/Vue，技术栈完全不同
- 如果混在一个项目中，你开发自己页面时必须考虑 ST 前端的构建、依赖、全局变量污染等问题
- iframe 提供天然的运行时隔离：两套前端各自独立，互不影响

**为什么不自己重写聊天界面？**

对话界面不是一个简单的按钮，而是一个复杂的运行时环境：

- 消息列表实时滚动
- 流式输出逐字渲染
- swipe 左右滑切换不同回复
- 输入框监听快捷键
- 消息编辑、删除、复制
- 生成过程中按钮状态联动（发送 ↔ 停止）
- prompt 引擎在生成过程中实时读取和操作 DOM 状态

这些交互状态高度耦合在 ST 前端代码中。如果自己重写聊天界面，就必须把这些状态管理和 prompt 引擎的 DOM 交互全部重新实现。iframe 直接复用 ST 原生对话界面，零成本获得这一切。

### 4.3 iframe 的具体实现

**大厅页面预加载（一次性加载成本）**：

```js
// 用户打开大厅时，后台静默预加载 iframe
window.onload = () => {
  const iframe = document.createElement('iframe')
  iframe.id = 'st-iframe'
  iframe.src = '/tavern/'
  iframe.style.display = 'none'  // 先隐藏
  document.body.appendChild(iframe)
}
```

**为什么在大厅就预加载？**

加载 ST 前端（几万行 JS + jQuery + 插件）需要一定时间。如果等用户进入聊天页才加载，会有明显的等待。在大厅预加载，用户浏览角色卡的时间足够 iframe 完成加载。进入聊天页时 iframe 已就绪，零等待直接显示。整个用户生命周期只有一次加载耗时，发生在大厅阶段，用户无感知。

**进入聊天页时显示 iframe**：

```js
// 用户选完角色，进入聊天页
function enterChat() {
  const iframe = document.getElementById('st-iframe')
  iframe.style.display = 'block'
  // 通过 postMessage 告诉 ST 切换到选定的角色
  iframe.contentWindow.postMessage({
    action: 'selectCharacter',
    characterId: selectedCharId
  }, '*')
}
```

**ST 端的 user.css（隐藏多余 UI）**：

```css
/* 隐藏所有不需要的 UI 元素 */
#top-bar { display: none; }           /* 顶栏 */
#left-nav-panel { display: none; }    /* 左侧导航 */
#right-nav-panel { display: none; }   /* 右侧面板 */
#form_sheld { display: none; }        /* 设置面板 */
#options_button { display: none; }    /* 选项按钮 */
/* ... 其他需要隐藏的元素 ... */

/* 只保留对话核心区域 */
#chat { display: block; }             /* 消息列表 */
#send_form { display: block; }        /* 输入框 + 发送按钮 */
```

### 4.4 两种按钮映射关系

在你的平台中，所有按钮分为两类：

**第一类：postMessage（按钮 → 按钮）**

你的页面上的按钮通过 postMessage "遥控" iframe 里 ST 的原生按钮。ST 的完整链路（prompt 引擎 → 后端 API → LLM）自动执行，你不需要写任何后端代码。

```
你的按钮 → postMessage → iframe 里 ST 的按钮 → ST 自己跑完整链路
```

适用于所有复用 ST 原生功能的场景。

**第二类：HTTP 请求（按钮 → API）**

你的页面上的按钮通过 HTTP 请求调用你自己的 TS 后端 API。这是 ST 没有的平台自有功能。

```
你的按钮 → fetch('/api/platform/...') → 你的 TS 后端
```

适用于计费、用户管理、推荐等平台功能。

**为什么不需要第三种（直接调 ST 后端 API）？**

理论上存在第三种：前端直接调 ST 后端的 HTTP API（如 `POST /api/characters/all`）。但因为大厅页面已经预加载了 iframe，所有 ST 相关操作都可以统一走 postMessage，不需要区分"这个操作要不要经过 prompt 引擎"。统一走 postMessage 让前端开发更简单，不需要判断每个功能该走哪条路。

**汇总**：

| 按钮类型 | 映射方式 | 到达 | 需要你写后端吗 |
|---------|---------|------|--------------|
| 复用 ST 功能（切角色、换预设、重新生成等） | postMessage（按钮→按钮） | iframe 里 ST 的原生按钮 | 不需要 |
| 平台功能（登录、计费、推荐等） | HTTP 请求（按钮→API） | 你的 TS 后端 | 需要 |

### 4.5 postMessage 通信协议

**你的页面 → ST iframe**（操作指令）：

```js
// 通用格式
iframe.contentWindow.postMessage({
  action: 'click',           // 操作类型
  target: '#option_regenerate' // ST 原生按钮的 CSS 选择器
}, '*')

// 更多示例
{ action: 'click', target: '#option_start_new_chat' }  // 新对话
{ action: 'click', target: '#option_regenerate' }       // 重新生成
{ action: 'selectCharacter', characterId: 'xxx' }       // 切换角色
{ action: 'changePreset', presetName: 'xxx' }           // 切换预设
```

**ST iframe 端的监听插件**（注入到 ST 中，几十行代码）：

```js
// 作为 ST 插件注入，放在 ST 的 extensions 目录
window.addEventListener('message', (e) => {
  const { action, target, characterId, presetName } = e.data

  switch (action) {
    case 'click':
      // 遥控点击 ST 原生按钮
      document.querySelector(target)?.click()
      break
    case 'selectCharacter':
      // 触发角色切换逻辑
      // ...调用 ST 内部函数
      break
    case 'changePreset':
      // 触发预设切换逻辑
      // ...调用 ST 内部函数
      break
  }
})
```

**ST iframe → 你的页面**（状态回传，按需添加）：

```js
// ST 插件中，监听关键事件，回传给父页面
import { eventSource, event_types } from '../script.js'

// 生成开始
eventSource.on(event_types.GENERATION_STARTED, () => {
  window.parent.postMessage({ event: 'generationStarted' }, '*')
})

// 生成完成
eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => {
  window.parent.postMessage({ event: 'messageReceived', messageId }, '*')
})
```

### 4.6 统一调用层封装

为了让前端开发者不用关心按钮走哪条路，封装一个统一的调用层：

```ts
// platform-actions.ts（一两百行代码）

const iframe = () => document.getElementById('st-iframe') as HTMLIFrameElement

// 统一入口，前端开发只调这个
export async function platformAction(action: string, params?: any) {
  // ST 功能 → postMessage
  const stActions: Record<string, () => void> = {
    'regenerate': () => iframe().contentWindow.postMessage(
      { action: 'click', target: '#option_regenerate' }, '*'),
    'newChat': () => iframe().contentWindow.postMessage(
      { action: 'click', target: '#option_start_new_chat' }, '*'),
    'selectCharacter': () => iframe().contentWindow.postMessage(
      { action: 'selectCharacter', characterId: params.id }, '*'),
    // ... 更多 ST 功能
  }

  // 平台功能 → HTTP API
  const platformActions: Record<string, () => Promise<any>> = {
    'getBilling': () => fetch('/api/platform/billing').then(r => r.json()),
    'login': () => fetch('/api/platform/auth/login', {
      method: 'POST', body: JSON.stringify(params)
    }).then(r => r.json()),
    // ... 更多平台功能
  }

  if (stActions[action]) {
    stActions[action]()
  } else if (platformActions[action]) {
    return platformActions[action]()
  }
}
```

前端开发者使用时完全不用关心底层路由：

```ts
// 这些调用看起来格式完全一致
platformAction('regenerate')                          // 走 postMessage
platformAction('selectCharacter', { id: 'xxx' })      // 走 postMessage
platformAction('getBilling')                           // 走 HTTP API
platformAction('login', { user: 'xxx', pass: 'xxx' }) // 走 HTTP API
```

---

## 五、用户体验流程

### 5.1 完整用户动线

```
1. 用户打开平台首页
   → 加载你的前端页面
   → 后台静默预加载 ST iframe（hidden）

2. 用户浏览大厅
   → 角色卡列表通过 postMessage 从 iframe 获取
   → 此时 ST iframe 已完成加载

3. 用户选择角色卡
   → postMessage 通知 iframe 切换角色
   → iframe 从隐藏变为显示
   → 用户看到简洁的对话界面（只有消息列表 + 输入框）

4. 用户聊天
   → 直接在 iframe 中交互
   → 打字、发送、流式输出、swipe 全部是 ST 原生体验
   → prompt 引擎（世界书、宏替换、预设排版）全力运转
   → 用户完全无感知底层复杂度

5. 用户使用平台功能
   → 点你页面上的按钮（计费、设置等）
   → 调你的 TS 后端 API

6. 用户返回大厅
   → iframe 隐藏
   → 回到你的大厅页面，选择下一个角色
```

### 5.2 渐进式功能开放

第一版只保留最少的按钮：

```
V1：发送、重新生成、新对话
V2：+ 预设切换、角色卡编辑
V3：+ 世界书管理、正则脚本
V4：+ 分组聊天、多角色协作
...
```

每个版本的开放方式：
- 在 `user.css` 中把对应按钮的 `display:none` 去掉
- 在你的页面上添加对应的遥控按钮 + postMessage 映射
- ST 后端和 prompt 引擎无需任何改动，功能本来就在

---

## 六、维护成本分析

### 6.1 你需要维护的

| 内容 | 代码量 | 说明 |
|------|-------|------|
| 你的前端页面（大厅、个人中心等） | 几千行 | 完全自主控制 |
| postMessage 通信协议 + 统一调用层 | 一两百行 | 按钮→按钮的映射 |
| user.css 样式覆盖 | 几百行 | 控制 ST 界面显隐 |
| ST 插件（消息监听 + 指令响应） | 几十行 | 注入到 ST 的 extensions 目录 |
| 你的 TS 后端 | 按业务需求 | 平台自有功能 |
| 数据同步服务 | 几百行 | watch data/ 目录 → 同步到 Supabase |

### 6.2 你不需要维护的

| 内容 | 代码量 | 由谁维护 |
|------|-------|---------|
| ST 前端（prompt 引擎、对话界面） | ~数万行 | ST 社区 |
| ST 后端（200 个 API 路由） | ~数万行 | ST 社区 |
| ST 升级 | - | `git pull` 即可 |

### 6.3 ST 升级策略

因为你对 ST 的代码零修改（只有 user.css + 一个插件），升级流程极其简单：

```bash
cd SillyTavern
git pull
npm install  # 如果有新依赖
# 重启 ST 进程
```

唯一需要检查的：如果 ST 改了 DOM 结构，你的 `user.css` 选择器和 postMessage 的 `target` 选择器可能需要适配。但这属于小范围修改，不影响架构。

---

## 七、技术风险与注意事项

### 7.1 许可证

SillyTavern 采用 AGPL 协议。确认已解决许可证问题后再推进商业化。

### 7.2 iframe 跨域

如果你的平台域名和 ST 不在同源下，postMessage 可以正常工作，但需要注意：
- `postMessage` 第二个参数指定目标 origin，不要用 `'*'`（生产环境）
- 通过 nginx 把 ST 挂在同一个域名的子路径下（`/tavern/`），可以避免跨域问题

### 7.3 多租户 / 并发

当前方案每个 ST 实例是单用户模式。如果多用户同时使用，需要考虑：
- 每个用户独立的 ST 数据目录（或通过 ST 的多用户功能隔离）
- API Key 按用户分配

### 7.4 性能

- iframe 预加载策略确保用户只承受一次加载延迟
- ST 前端加载完成后，后续所有操作都是即时的
- 后端两个进程各自独立，不会互相阻塞

---

## 八、第一版 MVP 清单

### 8.1 需要开发的

1. **你的前端**：大厅页面 + 聊天容器页（包含 iframe）
2. **你的 TS 后端**：用户登录 + 基础计费
3. **postMessage 通信层**：5-10 个核心操作的映射
4. **user.css**：隐藏 ST 多余 UI
5. **ST 插件**：监听 postMessage 指令
6. **nginx 配置**：反向代理规则
7. **数据同步服务**：data/ → Supabase

### 8.2 不需要开发的

- ST 的 prompt 引擎 — 原样使用
- ST 的后端 API — 原样使用
- ST 的对话界面 — 原样使用（仅 CSS 隐藏）
- LLM 对接 — ST 已经支持所有主流模型

### 8.3 第一版需要对接的 ST API（通过 postMessage）

| 功能 | 触发的 ST 按钮/函数 |
|------|-------------------|
| 发消息 | `#send_but` click 或 Generate() |
| 重新生成 | `#option_regenerate` click |
| 开新对话 | `#option_start_new_chat` click |
| 切换角色 | 角色选择相关内部函数 |
| 停止生成 | `#mes_stop` click |

5 个 postMessage 映射，就够第一版跑起来了。
