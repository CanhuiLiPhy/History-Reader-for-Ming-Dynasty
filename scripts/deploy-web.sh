#!/usr/bin/env bash
# 中文：把前端和后端部署到网站服务器，并修好 nginx 需要的读权限。
#
# Deploy the built frontend and the backend sources to the web server.
#
# Two things here are load-bearing, both learned the hard way:
#
#   1. The permission fix-up. `rsync -a` preserves the macOS source modes
#      (700/600), which leaves /var/www/mingshi/frontend/dist unreadable by
#      nginx's www-data user and makes every static asset 404.
#
#   2. Running that fix-up even when rsync fails. It runs from an EXIT trap
#      rather than inline, because `set -e` used to abort the script at a failed
#      rsync and skip the fix entirely — leaving the site broken rather than
#      merely un-updated.
#
# 用法 / Usage:
#   bash scripts/deploy-web.sh            # 前端 + 后端
#   bash scripts/deploy-web.sh frontend   # 只传前端
#   bash scripts/deploy-web.sh backend    # 只传后端（会重启服务）
set -euo pipefail

# 私钥位置。2026-08-18 从 ~/Downloads 移到了 ~/.ssh —— 那才是它该待的地方。
# Private key location. Moved out of ~/Downloads on 2026-08-18; the old path is
# still probed so an un-migrated machine keeps working.
DEFAULT_KEY="$HOME/.ssh/LightsailDefaultKey-ap-northeast-1.pem"
LEGACY_KEY="$HOME/Downloads/LightsailDefaultKey-ap-northeast-1.pem"
if [[ -n "${MINGSHI_SSH_KEY:-}" ]]; then
  KEY="$MINGSHI_SSH_KEY"
elif [[ -f "$DEFAULT_KEY" ]]; then
  KEY="$DEFAULT_KEY"
elif [[ -f "$LEGACY_KEY" ]]; then
  KEY="$LEGACY_KEY"
  echo "提示：私钥仍在 ~/Downloads，建议移到 ~/.ssh/ 并 chmod 600。"
else
  echo "找不到 SSH 私钥。请放到 $DEFAULT_KEY，或用 MINGSHI_SSH_KEY 指定。" >&2
  exit 1
fi

HOST="${MINGSHI_HOST_SSH:-ubuntu@54.150.201.100}"
DEST=/var/www/mingshi
SSHCMD="ssh -i $KEY -o BatchMode=yes -o ServerAliveInterval=30"
WHAT="${1:-all}"

cd "$(dirname "$0")/.."

# 传输是否成功由这个变量记录，EXIT trap 据此决定要不要重启后端。
UPLOADED_BACKEND=0

# 中文：rsync 重试。到东京的连接会被远端不定时掐断，单次失败不代表真的传不了。
#
# rsync with retries. The link to Tokyo drops mid-transfer often enough that a
# single failure says nothing about whether the transfer is possible: on
# 2026-08-10 every one of three deploys needed two or three attempts. Retrying
# is the difference between a deploy that works and one that needs babysitting.
#
# Args:
#   $1 (string): source directory (trailing slash matters, as always with rsync)
#   $2 (string): destination path on $HOST
# Returns:
#   0 on success, 1 after exhausting all attempts.
rsync_retry() {
  local src="$1" dst="$2" attempt
  for attempt in 1 2 3 4 5; do
    if rsync -az --exclude=.DS_Store --exclude=__pycache__ -e "$SSHCMD" "$src" "$HOST:$dst"; then
      [[ $attempt -gt 1 ]] && echo "   （第 $attempt 次尝试成功）"
      return 0
    fi
    echo "   传输中断，5 秒后重试（第 $attempt/5 次）…"
    sleep 5
  done
  echo "   ✗ 连续 5 次失败，放弃。" >&2
  return 1
}

# 中文：修权限 + 预压缩。无论前面成功与否都要跑 —— 半路失败留下的 700 权限
# 会让整站静态资源 404，比"没更新成功"严重得多。
#
# Fix permissions and pre-compress. Runs from an EXIT trap so a mid-transfer
# failure cannot leave the site serving 404s for every asset.
finalize() {
  local rc=$?
  echo "==> 修复权限 + 预压缩静态资源"
  $SSHCMD "$HOST" 'bash -s' <<'REMOTE' || echo "   ✗ 权限修复失败，请手动检查 /var/www/mingshi/frontend/dist 权限。" >&2
set -e
D=/var/www/mingshi/frontend/dist
chmod 755 /var/www/mingshi /var/www/mingshi/frontend "$D" 2>/dev/null || true
find "$D" -type d -exec chmod 755 {} +
find "$D" -type f -exec chmod 644 {} +
# WOFF2 内部已是 Brotli，再 gzip 无益；只预压缩文本资源和作为兜底的 TTF。
# WOFF2 is already Brotli-compressed; only pre-gzip text assets and the TTF
# fallbacks so nginx's gzip_static can serve them without re-compressing.
cd "$D"
find . \( -name '*.js' -o -name '*.css' -o -name '*.svg' -o -name '*.ttf' -o -name '*.TTF' \) \
  ! -name '*.gz' -print0 | xargs -0 -P 2 -I{} sh -c 'pigz -9 -k -f "{}"' 2>/dev/null || true
REMOTE

  if [[ $UPLOADED_BACKEND -eq 1 ]]; then
    echo "==> 重启后端"
    $SSHCMD "$HOST" 'sudo systemctl restart mingshi && sleep 15 && systemctl is-active mingshi'
  fi

  echo "==> 冒烟测试"
  curl -s -o /dev/null -w "登录页 %{http_code}\n" https://mingshi.giize.com/login || true
  if [[ $rc -eq 0 ]]; then echo "完成。"; else echo "部署未全部成功（退出码 $rc），但权限已修复。" >&2; fi
  exit $rc
}
trap finalize EXIT

if [[ "$WHAT" == "all" || "$WHAT" == "frontend" ]]; then
  echo "==> 构建前端"
  npm --prefix frontend run build

  echo "==> 上传 frontend/dist"
  rsync_retry frontend/dist/ "$DEST/frontend/dist/"
fi

if [[ "$WHAT" == "all" || "$WHAT" == "backend" ]]; then
  echo "==> 上传 backend/src"
  rsync_retry backend/src/ "$DEST/backend/src/"
  UPLOADED_BACKEND=1
fi
