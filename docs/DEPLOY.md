# 部署与运维

## 1. 前置条件

- 一台能运行 Docker 24+ 的 Linux 主机（推荐 2C4G 起），或 Windows/macOS 上的 Docker Desktop 用于试用。
- 目标机为 Linux，已启用 sshd，发布账号对目标目录有写权限，并能执行发布脚本。
- 目标机需要 `tar` 与 `gzip`（主流发行版自带），用于解压发布包。
- 服务容器需要能访问 Git 仓库与目标机的 SSH 端口（默认 22）。
- 目标机无需安装 agent，但需要 `bash`（发布命令通过 `bash -lc` 执行）。
- 宿主机/镜像内的 Git 版本需 2.31+（容器自带 2.54）；HTTPS Token 通过 Git 配置环境变量传递。

## 2. 使用 Docker Compose 部署

```bash
git clone <你的仓库地址> myJenkins
cd myJenkins
cp .env.example .env
```

编辑 `.env`：

```dotenv
APP_SECRET=<至少 32 位随机字符串>
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<初始密码，或留空由系统生成>
HOST_PORT=8080
TZ=Asia/Shanghai
```

`APP_SECRET` 用于派生凭据加密密钥。生成方式示例：

```bash
openssl rand -hex 32
```

启动：

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f myjenkins
```

访问 `http://<服务器IP>:8080`。

> 数据保存在宿主机的 `./data` 目录（SQLite、日志、工作区、主密钥）。容器以 uid 1000 的 `node` 用户运行；在 Linux 上如果 `./data` 属主不是 1000，需要：
>
> ```bash
> mkdir -p data && sudo chown -R 1000:1000 data
> ```

首次登录：

- 设置了 `ADMIN_PASSWORD`：使用 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登录。
- 未设置：`docker compose logs myjenkins | grep 初始密码`，日志中只打印一次。

登录后请立即在「账号设置」中修改密码。

## 3. 准备目标机

1. 确认 SSH 可用：

   ```bash
   ssh -p 22 deploy@10.0.0.12 'id && uname -a'
   ```

2. 准备发布目录并授权：

   ```bash
   sudo mkdir -p /opt/apps/order-service
   sudo chown -R deploy:deploy /opt/apps/order-service
   ```

3. 如果发布命令需要重启服务，建议配置最小化免密 sudo，例如：

   ```bash
   # /etc/sudoers.d/myjenkins
   deploy ALL=(ALL) NOPASSWD: /usr/bin/systemctl restart order-service
   ```

   然后在项目的发布命令中使用 `sudo systemctl restart order-service`。

4. 在 myJenkins 的「服务器」页面添加该机器：
   - 填地址、端口、用户、密码或私钥；
   - 保存后点「测试连接」；
   - 核对返回的指纹与目标机一致：

     ```bash
     ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
     # 或 ssh-keyscan -p 22 10.0.0.12 | ssh-keygen -lf -
     ```

   - 点「信任并保存指纹」。未信任的服务器不会被执行发布。

## 4. 反向代理与 HTTPS

推荐放在 Nginx 之后并启用 HTTPS。SSE 日志流必须关闭代理缓冲：

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name ci.example.com;

    ssl_certificate     /etc/nginx/certs/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/privkey.pem;

    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # 让 /api/builds/:id/events 实时输出
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
}
```

对应 `.env`：

```dotenv
COOKIE_SECURE=true
TRUST_PROXY=true
```

说明：

- `COOKIE_SECURE=true` 时 Cookie 只会在 HTTPS 下发送；纯 HTTP 访问会表现为「登录后又跳回登录页」。
- `TRUST_PROXY=true` 让服务从 `X-Forwarded-*` 读取真实 IP 与协议。
- 若使用 CDN/负载均衡，同样需要关闭对 SSE 路径的缓冲。

## 5. 数据备份、恢复与升级

所有持久化数据都在 `data/`：

- `data/myjenkins.db`：用户、项目、凭据密文、发布记录；
- `data/logs/`：发布日志；
- `data/workspaces/`：发布工作区（可丢弃）；
- `data/master.key`：未设置 `APP_SECRET` 时自动生成的主密钥（**必须与数据库一起备份**）。

> 使用仓库自带的 `docker-compose.yml` 时，`workspaces` 与 `pnpm-store` 挂载为 named volume（`myjenkins_workspaces`、`myjenkins_pnpm-store`），位于 Docker 的 Linux 文件系统上以避免 Windows bind mount 的小文件 I/O 开销。两者都是可丢弃的缓存，不需要备份；`data/` 下保留数据库、日志与主密钥。

备份：

```bash
tar czf myjenkins-data-$(date +%F).tgz data/
```

恢复：

```bash
docker compose down
rm -rf data && tar xzf myjenkins-data-2026-10-23.tgz
sudo chown -R 1000:1000 data
docker compose up -d
```

升级：

```bash
git pull
docker compose up -d --build
```

服务启动时会自动执行数据库结构迁移；升级前建议先备份 `data/`。

## 6. 扩展构建工具链

运行镜像基于 `node:24-alpine`，自带 git、ssh 客户端、curl、tini、Node.js 与 pnpm。若项目需要 Maven、JDK、Python 等，在构建镜像时追加 Alpine 系统包：

```bash
docker build --build-arg EXTRA_APK_PACKAGES="maven openjdk17" -t myjenkins:jdk .
```

或写一个派生 Dockerfile：

```dockerfile
FROM myjenkins:0.1.0
USER root
RUN apk add --no-cache maven openjdk17
USER node
```

然后在 `docker-compose.yml` 中把 `build:` 换成 `image: myjenkins:jdk`。

> 不要为了在容器内构建而挂载 `/var/run/docker.sock`，这等同于把宿主机 root 权限交给发布任务。

## 7. 本地自测（无真实服务器）

仓库自带一个 SSH 目标机 compose：

```bash
docker compose -f docker-compose.yml -f docker-compose.test.yml up -d
```

- 地址：`127.0.0.1`，端口 `2222`，用户 `deploy`，密码见 `.env` 的 `SSH_TARGET_PASSWORD`（默认 `deploy-pass-123`）。
- 用户家目录 `/config`，建议远程目录填 `/config/app`。
- 发布命令示例：

  ```bash
  echo "deployed at $(date)" > /config/app/deploy.log
  ```

验证文件是否上传：

```bash
docker exec myjenkins-ssh-target ls -la /config/app
```

## 8. 监控与日志

- 健康检查：`curl -f http://127.0.0.1:8080/api/health`（镜像已配置 HEALTHCHECK）。
- 服务日志：`docker compose logs -f --tail=200 myjenkins`。
- 队列与运行信息：登录后「账号设置」页面展示队列长度、并发上限、数据目录与版本。
- 磁盘占用主要来自 `data/logs` 与工作区/依赖缓存（compose 部署时为 `myjenkins_workspaces`、`myjenkins_pnpm-store` 两个卷）；日志按 `LOG_RETENTION_DAYS` 自动清理，失败保留的工作区需人工清理，例如 `docker exec myjenkins sh -c 'rm -rf /data/workspaces/p-*'`。

## 9. 故障排查

| 现象 | 可能原因与处理 |
| --- | --- |
| 登录成功后仍跳回登录页 | `COOKIE_SECURE=true` 但正在用 HTTP 访问；改为 HTTPS 或临时设为 false |
| 反向代理后登录 IP 都是代理地址 | 设置 `TRUST_PROXY=true` 并确认代理传了 `X-Forwarded-For` |
| 日志不实时刷新，结束时才一次性出现 | Nginx 未关闭 `proxy_buffering`；按第 4 节配置 |
| 测试连接提示「主机指纹不匹配」 | 目标机重装或更换过 host key。核对后在服务器页重新测试并信任 |
| 发布提示「尚未信任主机指纹」 | 先去服务器页测试连接并点「信任并保存指纹」 |
| Git 认证失败 | Token 权限不足/过期；SSH 私钥是否带口令、公钥是否已加入仓库账号；检查网络与代理 |
| Git 提示主机指纹变化 | Git 服务器重装或更换了 SSH 主机密钥。确认无误后备份并删除 `data/git_known_hosts`，下次发布会重新记录 |
| Git 提示 `spawn EPERM` | 仅出现在本机沙箱/受限账户运行服务时；Docker 部署不会出现 |
| 发布命令报 `bash: command not found` | 目标机缺少 bash 或命令不在非交互 PATH 中；改用绝对路径或安装缺失组件 |
| 上传报创建目录失败 | 远程目录父级无写权限，或目标路径是文件；用发布账号手工 `mkdir -p` 验证 |
| 发布命令超时 | 调大项目「远程命令超时」；或检查命令是否等待交互输入 |
| 容器启动报 8080 被占用 | 修改 `.env` 的 `HOST_PORT`，或停止占用端口的进程 |
| `data/` 读写失败 | Linux 下 `chown -R 1000:1000 data`；SELinux 环境可临时 `chcon -Rt container_file_t data` |
| 凭据突然无法解密 | `APP_SECRET` 被更换且未使用 `data/master.key`；恢复原密钥，或重新填写凭据 |

## 10. 安全清单

- [ ] 使用 HTTPS，`COOKIE_SECURE=true`、`TRUST_PROXY=true`。
- [ ] `APP_SECRET` 使用 32 位以上随机值，并与数据库一起纳入密钥管理。
- [ ] 管理员使用强密码，离职人员及时禁用/删除。
- [ ] 只给发布账号必要的目录权限与最小化 sudo 规则。
- [ ] 定期备份 `data/`，并验证恢复流程。
- [ ] 不要把 Docker Socket、宿主机根目录挂载给发布容器。
- [ ] 生产环境保持 `ALLOW_FILE_REPOS=false`。
- [ ] 对公网暴露时限制来源 IP，或只在内网/VPN 访问。
