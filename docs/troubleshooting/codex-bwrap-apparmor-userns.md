# Codex Review 在 Ubuntu 上报 `bwrap: loopback: Failed RTM_NEWADDR`

## 症状

使用 Codex 作为 reviewer 时，Review session 无法读取源码或运行 Git，最终可能返回 `cannot-verify`。常见错误为：

```text
bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
```

也可能同时看到 Codex 的环境警告：

```text
Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces.
```

典型表现包括：

- `git status`、`git log`、`git diff`、文件读取或测试命令在真正启动前失败；
- 某些简单命令（例如 `pwd` 或 `rg`）仍可能成功；
- 实现 session 正常，只有 Codex Review session 失败；
- session 记录中可能没有对应的失败工具调用，只有环境 warning 或 reviewer 在最终回答中复述的错误。

简单命令成功不代表沙箱正常。Codex exec policy 可以让显式允许的命令绕过沙箱；其他命令仍会进入 Bubblewrap 并失败。

## 原因

Vibedeckx 让 reviewer 以只读模式运行，Codex 会为该模式启用 Linux Bubblewrap 沙箱。Bubblewrap 需要创建 user/network namespace，并在新的 network namespace 中配置 loopback 地址。

Ubuntu 24.04 默认可以通过 AppArmor 限制非特权 user namespace。如果限制已经开启，但 `/usr/bin/bwrap` 没有加载对应的 AppArmor profile，Bubblewrap 无法获得初始化 namespace 所需的能力，于是在配置 loopback 时返回 `RTM_NEWADDR: Operation not permitted`。Git 或文件读取命令此时尚未真正执行。

常见的触发组合是：

```text
Ubuntu 24.04
+ kernel.apparmor_restrict_unprivileged_userns = 1
+ /usr/bin/bwrap 已安装
+ AppArmor 已加载
+ bwrap-userns-restrict profile 未安装或未启用
```

这不是 Git 配置、项目源码或登录 shell 的问题。

## 确认问题

先记录系统和工具版本：

```bash
codex --version
bwrap --version
uname -a
. /etc/os-release && printf '%s\n' "$PRETTY_NAME"
```

检查 user namespace 和 AppArmor 状态：

```bash
sysctl kernel.unprivileged_userns_clone
sysctl kernel.apparmor_restrict_unprivileged_userns
sysctl user.max_user_namespaces
sudo aa-status
```

检查 Bubblewrap profile：

```bash
test -f /etc/apparmor.d/bwrap-userns-restrict \
  && echo "bwrap profile exists" \
  || echo "bwrap profile is missing"

sudo aa-status | grep -E 'bwrap|unpriv_bwrap'
```

直接运行 Codex 沙箱探针。不要用普通 `pwd` 工具调用代替，因为 exec policy 可能绕过沙箱：

```bash
codex sandbox /bin/true
codex sandbox /bin/pwd
```

如果探针复现相同的 `RTM_NEWADDR` 错误，即可确认故障位于 Codex/Bubblewrap 与宿主机安全策略之间，而不是被审查的仓库。

还可以直接验证底层限制：

```bash
unshare -Ur /bin/true
/usr/bin/bwrap \
  --ro-bind / / \
  --dev /dev \
  --proc /proc \
  --unshare-user \
  --unshare-net \
  /bin/true
```

在受影响的机器上，前者通常无法写入 `/proc/self/uid_map`，后者会报告 loopback `RTM_NEWADDR` 权限错误。

## 推荐修复：启用 Ubuntu 的 Bubblewrap AppArmor profile

该方案保留系统级的 user namespace 限制，只为系统安装的 `/usr/bin/bwrap` 加载专用 profile。请由机器管理员执行。

安装或更新所需软件包：

```bash
sudo apt update
sudo apt install apparmor apparmor-utils apparmor-profiles bubblewrap
```

Ubuntu 将该 profile 作为 extra profile 提供，默认不主动启用。将它持久化到 `/etc/apparmor.d`：

```bash
sudo install -m 0644 \
  /usr/share/apparmor/extra-profiles/bwrap-userns-restrict \
  /etc/apparmor.d/bwrap-userns-restrict
```

检查语法并加载 profile：

```bash
sudo apparmor_parser -Q \
  /etc/apparmor.d/bwrap-userns-restrict

sudo apparmor_parser -r -W -T \
  /etc/apparmor.d/bwrap-userns-restrict
```

确认 `bwrap` 和 `unpriv_bwrap` 已加载：

```bash
sudo aa-status | grep -E 'bwrap|unpriv_bwrap'
```

该 profile 允许 Bubblewrap 初始化 namespace；进入 sandbox 的子进程会落入 `unpriv_bwrap` profile，避免把初始化能力直接传给被隔离的命令。

## 验收

先验证 Codex 的真实沙箱路径：

```bash
codex sandbox /bin/true
printf 'exit=%s\n' "$?"

codex sandbox /bin/pwd
codex sandbox /usr/bin/git --version
```

预期结果：

- `/bin/true` 无输出且退出码为 `0`；
- `/bin/pwd` 输出当前目录；
- Git 输出版本号；
- 不再出现 `bwrap: loopback: Failed RTM_NEWADDR`。

然后新建一个 Codex Review session，确认 reviewer 能独立运行：

```text
git status
git log
git diff
```

通常无需重启机器。若 worker 或上层服务缓存了旧的健康状态，重新连接或重启 Vibedeckx worker 后再创建 Review session。

## 回滚

如该 profile 与机器上的其他 Bubblewrap 使用方式不兼容，可以卸载当前加载的 profile 并删除持久化副本：

```bash
sudo apparmor_parser -R \
  /etc/apparmor.d/bwrap-userns-restrict

sudo rm /etc/apparmor.d/bwrap-userns-restrict
```

回滚后，系统级 user namespace 限制仍然保持开启，但 Codex 的 Bubblewrap 沙箱会再次失败，除非另行配置兼容方案。

## 不推荐的长期方案

### 全局关闭 AppArmor user namespace 限制

下面的命令通常能绕过问题，但会对整台机器放宽限制，而不只是允许 Bubblewrap：

```bash
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

不要把它作为共享 worker 或生产机器的默认修复。

### 使用 legacy Landlock

部分 Codex 版本可以通过以下配置绕过 Bubblewrap 后端：

```toml
[features]
use_legacy_landlock = true
```

该开关在 Codex 0.145.0 中已经标记为 deprecated，只适合作为修复宿主机前的临时兼容方案。升级 Codex 后应重新确认该选项是否仍然存在。

### 让 reviewer 使用 `danger-full-access`

不建议取消 reviewer 的只读隔离。Reviewer 与实现 session 共享 worktree；允许 reviewer 修改工作区会破坏独立审查的可信度。

## 维护说明

- `apparmor-profiles` 中的 extra profile 更新后，不会自动替换已经复制到 `/etc/apparmor.d` 的文件。升级 AppArmor 后应比较并重新同步该 profile，再运行验收探针。
- 如果 Codex 没有使用 `/usr/bin/bwrap`，先确认实际 Bubblewrap 路径；绑定到 `/usr/bin/bwrap` 的 profile 不会覆盖其他路径下的 vendored binary。
- 保存完整错误原文、Codex 版本、Bubblewrap 版本和上述探针结果，通常足以继续调查其他宿主机或 Codex 版本的兼容问题。

## 参考

- [Ubuntu Server: AppArmor](https://documentation.ubuntu.com/server/how-to/security/apparmor/)
- [AppArmor `bwrap-userns-restrict` profile](https://gitlab.com/apparmor/apparmor/-/blob/master/profiles/apparmor/profiles/extras/bwrap-userns-restrict)
- [Codex Linux sandbox](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/linux-sandbox/README.md)
- [Codex issue: Linux sandbox fails on Ubuntu with AppArmor userns restrictions](https://github.com/openai/codex/issues/15057)
