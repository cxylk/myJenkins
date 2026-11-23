# 架构设计

## 1. 总览

```
浏览器（React + Ant Design）
   │  HTTP / SSE（Cookie 会话）
   ▼
Fastify（单进程）
   ├── 认证与权限
   ├── 项目 / 凭据 / 服务器 / 用户 API
   ├── 发布调度器（内存队列 + 数据库状态）
   │      └── 执行器：git → 构建 → 产物 → SFTP → SSH 命令
   ├── SQLite（data/myjenkins.db，WAL）
   ├── 日志（data/logs/<buildId>.log）
   └── 工作区（data/workspaces/p-<id>/b-<编号>）
        │
        └── SSH/SFTP ──▶ Linux 目标机 1..N
```

整个系统是一个 Node.js 进程：API、静态页面、调度器与执行器同进程。发布任务由数据库持久化，进程重启后排队任务会继续执行，执行中的任务标记为中断失败。

## 2. 代码模块

| 模块 | 位置 | 职责 |
| --- | --- | --- |
| 配置 | `src/config.ts` | 环境变量、数据目录、默认值 |
| 数据库 | `src/db.ts` | `node:sqlite` 封装、建表迁移（`PRAGMA user_version`）、事务 |
| 加密 | `src/lib/crypto.ts` | scrypt 密码哈希、AES-256-GCM 密钥盒、主密钥加载 |
| 认证 | `src/auth/*` | 会话、Cookie、登录限流、管理员校验 |
| 路由 | `src/routes/*` | 凭据、服务器、项目、发布、用户、系统接口 |
| Git | `src/git.ts` | 分支列举、浅克隆、凭据注入、命令脱敏 |
| SSH | `src/ssh.ts` | 连接与主机指纹、远程执行、SFTP 上传 |
| 调度 | `src/pipeline/scheduler.ts` | 队列、并发、项目串行、取消、清理 |
| 执行 | `src/pipeline/runner.ts` | 单次发布的全部步骤与状态落库 |
| 产物 | `src/pipeline/artifact.ts` | 目录/文件/glob 解析、排除规则、路径越界防护 |
| 日志 | `src/pipeline/log.ts` | 写日志、脱敏、大小上限、增量读取 |

## 3. 数据模型

| 表 | 说明 |
| --- | --- |
| `users` | 用户、scrypt 密码哈希、角色（admin/member）、是否禁用 |
| `sessions` | 会话 Token 的 SHA-256、过期时间、最后活跃时间 |
| `git_credentials` | Git 凭据；`secret_enc` / `passphrase_enc` 为 AES-GCM 密文 |
| `servers` | SSH 目标机；加密的密码/私钥、已信任的主机指纹 |
| `projects` | 仓库、凭据、构建命令、产物路径、超时、失败策略 |
| `project_members` | 普通成员与项目的授权关系 |
| `project_targets` | 每台目标机的远程目录、发布后命令、启用状态与顺序 |
| `builds` | 发布记录：编号、分支、提交、状态、耗时、错误、日志大小 |
| `build_targets` | 一次发布中各目标的快照与结果（文件数、字节数、错误） |

删除项目会级联删除发布记录；删除凭据/服务器前会检查是否被项目引用。用户删除后，其历史发布记录的 `triggered_by` 置空。

## 4. 发布流水线

### 4.1 步骤

1. **准备**：删除并重建 `data/workspaces/p-<projectId>/b-<number>`。
2. **拉取**：维护每项目一份裸仓库缓存 `data/cache/git/p-<id>.git`。首次按分支执行 `git clone --bare --depth 1 --single-branch`；后续执行 `git fetch --depth 1 origin <branch>` 只拉增量，再通过 `git worktree add` 检出到本次独立工作区；随后读取提交 SHA 与标题写入发布记录。
3. **构建**（项目启用时）：在工作区用 `sh -lc`（Windows 开发机为 `cmd /c`）执行构建命令，stdout/stderr 实时写日志；超时或取消会杀掉整个进程树。
4. **产物**：解析产物配置：
   - 目录：上传目录内容并保留相对结构；
   - 单文件：上传到远程目录根；
   - glob：按第一个通配符前的静态前缀计算相对路径；
   - 始终忽略 `**/.git/**`，并应用项目的排除规则；符号链接跳过；匹配 0 个文件视为失败。
5. **发布**：按顺序逐台目标：
   - 在服务端把产物打包成 `tar.gz`（`tar -C <产物基目录> -T <文件清单>`，避免上千个文件的参数长度问题）；
   - 校验服务器已信任主机指纹；
   - SSH 连接（keepalive 10s，连接超时 15s）；
   - 逐级创建远程目录；
   - SFTP 上传单个压缩包，保留可执行位；
   - 在远程目录执行 `tar -xzf` 解压并全量覆盖同名文件，成功后删除压缩包；
   - 若配置了发布命令，则在远程目录下执行 `bash -lc 'cd <dir> && <script>'`，流式回显；超时关闭通道，退出码非 0 视为失败。
6. **收尾**：写入最终状态、耗时、错误；按 `keep_workspace` 决定失败时是否保留工作区；成功时删除工作区。

### 4.2 状态机

- 发布：`queued → running → success | failed | cancelled`
- 目标：`queued → running → success | failed | skipped | cancelled`

失败策略：

- `abort`：当前目标失败后，把剩余目标标记为 `skipped`，发布失败；
- `continue`：继续执行其余目标，最终汇总失败。

### 4.3 并发与取消

- 全局并发上限 `MAX_CONCURRENCY`（默认 2），同一项目通过锁串行。
- 取消通过 `AbortController` 贯穿 Git 子进程、构建进程树、SFTP 上传循环与 SSH 命令；未开始的发布直接从队列移除并标记取消。
- 服务启动时：`running` 记录改为失败（原因「服务重启，发布被中断」），`queued` 重新入队。

## 5. 日志与实时推送

- 每次发布一个纯文本日志：`data/logs/<buildId>.log`，行首带本地时间戳，阶段以 `===== [n/m] 标题 =====` 分隔。
- 写入前经过 `Redactor`：把本次发布解密出的 Token、密码、口令与 Base64 Basic 头替换为 `***`。
- 单次日志超过 `LOG_MAX_BYTES` 后追加截断提示并停止写入。
- 前端先 `GET /api/builds/:id/log?offset=0` 拉取首屏，再通过 `EventSource` 连接 `/api/builds/:id/events?offset=<next>`。
- 服务端每 350ms 读取新增字节，按换行对齐后以 JSON 形式推送，事件 `id` 为字节偏移；客户端重连时浏览器会带 `Last-Event-ID`，服务端据此续传。
- 发布进入终态且日志读完后推送 `event: end` 并关闭连接；每 15 秒发送一次注释帧保活。

## 6. 凭据与主机指纹

### 6.1 加密

- 主密钥来源：`APP_SECRET` 的 SHA-256，或首次启动生成的 `data/master.key`（32 字节，权限 0600）。
- 密文格式：`v1:<iv>:<authTag>:<ciphertext>`；AES-256-GCM 同时提供机密性与完整性。
- 接口永不返回明文，只返回是否已设置；更新时留空表示保持原值。

### 6.2 Git 凭据注入

- **HTTPS Token**：通过 `git -c http.extraHeader="Authorization: Basic ..."` 注入，避免写入 URL 或磁盘；日志中的该参数固定显示为 `http.extraHeader=***`。
- **SSH 私钥**：每次操作写入临时目录（0600），通过 `GIT_SSH_COMMAND` 指定；临时 `known_hosts` 使用 `StrictHostKeyChecking=accept-new`；有口令时通过 `SSH_ASKPASS` 传递。操作结束后删除临时目录。
- `GIT_TERMINAL_PROMPT=0` 确保认证失败立即报错而不是挂起等待输入。

### 6.3 SSH 主机指纹

- 采用 TOFU（Trust On First Use）：保存服务器后先「测试连接」拿到 `SHA256:...` 指纹，管理员人工核对并信任。
- 每次发布连接时用 `hostVerifier` 比对指纹；不一致立即断开并返回 `HOST_KEY_MISMATCH`，不执行任何上传或命令。
- 信任操作会重新连接并核对页面提交的指纹，避免中间人诱导信任。

## 7. 权限

| 能力 | 管理员 | 普通成员 |
| --- | --- | --- |
| 项目/服务器/凭据/用户管理 | ✅ | ❌ |
| 查看项目 | 全部 | 仅被授权项目 |
| 触发发布、查看日志、取消发布 | ✅ | 仅被授权项目 |
| 修改自己的密码 | ✅ | ✅ |

普通成员由管理员在项目「成员」页授权；管理员不需要单独授权。

## 8. HTTP API

| 分组 | 接口 |
| --- | --- |
| 认证 | `POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/me`、`PUT /api/auth/password` |
| 用户 | `GET/POST /api/users`、`PATCH/DELETE /api/users/:id`、`POST /api/users/:id/reset-password` |
| 凭据 | `GET/POST /api/credentials`、`PATCH/DELETE /api/credentials/:id` |
| 服务器 | `GET/POST /api/servers`、`PATCH/DELETE /api/servers/:id`、`POST /api/servers/:id/test`、`POST /api/servers/:id/trust` |
| 项目 | `GET/POST /api/projects`、`GET/PATCH/DELETE /api/projects/:id`、`PUT /api/projects/:id/members`、`GET /api/projects/:id/branches`、`POST /api/projects/:id/verify-repo` |
| 发布 | `POST /api/projects/:id/builds`、`GET /api/builds`、`GET /api/builds/:id`、`GET /api/builds/:id/log`、`GET /api/builds/:id/log/download`、`GET /api/builds/:id/events`、`POST /api/builds/:id/cancel` |
| 系统 | `GET /api/health`、`GET /api/system/info`、`GET /api/dashboard/recent` |

除 `login` 与 `health` 外都需要会话 Cookie。错误统一返回 `{ code, message, details? }`。

## 9. 设计取舍

- **使用 Node 内置 `node:sqlite` 而非 ORM**：零原生依赖，Windows 开发机与 Alpine/Debian 容器行为一致；表结构由版本化 SQL 迁移管理，查询集中在少量模块中。
- **单进程内队列**：与 SQLite 单写者模型匹配，不需要 Redis；通过数据库状态保证崩溃可恢复。横向扩容需要改成外部队列与共享数据库，不在 v1 范围。
- **SSE 而非 WebSocket**：日志是单向流，SSE 自带断线重连与事件 ID，代理配置更简单。
- **每次发布独立工作区 + 项目级裸仓库缓存**：工作区仍每次全新检出，避免残留污染；Git 对象只保留一份，后续发布只 fetch 增量，解决大仓库每次全量 clone 过慢的问题。
- **上传为合并语义**：不删除目标目录多余文件，避免误删生产数据；原子切换/回滚留给后续版本。

## 10. 扩展点

- 触发方式：在 `scheduler.enqueue` 之外增加 Webhook / 定时任务即可复用执行器。
- 构建隔离：将 `runLocalCommand` 替换为「启动一次性构建容器」，即可支持自定义构建镜像。
- 通知：在 `executeBuild` 收尾处增加企业微信/钉钉/邮件发送。
- 多实例：把队列与日志改为外部存储（Redis/对象存储），SQLite 换成 PostgreSQL/MySQL。
