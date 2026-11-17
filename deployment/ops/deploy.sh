#!/usr/bin/env bash
# 把仓库里的页面和后端同步到线上目录，然后重启后端。
#
#   cd <仓库>/deployment/ops
#   bash deploy.sh
#
# 可用环境变量覆盖：
#   SITE=~/app/site     线上站点目录（public/ 和 schulte-server/ 的父目录）
#   REPO=...            仓库根目录（默认取脚本所在目录的上两级）
#   API_PORT=8097       后端端口（自检用）
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${REPO:-$(cd "$HERE/../.." && pwd)}"
SITE="${SITE:-$HOME/app/site}"
API_PORT="${API_PORT:-8097}"

say(){ printf '\n\033[1;36m%s\033[0m\n' "$*"; }
die(){ printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ -d "$REPO/deployment" ] || die "找不到仓库：$REPO"
[ -d "$SITE/public" ]     || die "找不到站点目录：$SITE/public（用 SITE=... 指定）"

say "1/5 拉代码"
if [ -d "$REPO/.git" ]; then
  git -C "$REPO" pull --ff-only
else
  echo "  跳过（$REPO 不是 git 仓库）"
fi

say "2/5 备份旧首页（放在 web 根目录之外）"
if [ -f "$SITE/public/index.html" ]; then
  cp "$SITE/public/index.html" "$SITE/index.old.html"
  echo "  → $SITE/index.old.html"
fi

say "3/5 同步页面"
cp "$REPO/deployment/index.html" "$SITE/public/"
for d in schulte stroop nback memory shared me; do
  [ -d "$REPO/deployment/$d" ] || continue
  rm -rf "$SITE/public/$d"
  cp -r "$REPO/deployment/$d" "$SITE/public/$d"
  echo "  ✓ public/$d"
done

say "4/5 同步后端并重启"
mkdir -p "$SITE/schulte-server"
cp -r "$REPO/deployment/server/." "$SITE/schulte-server/"
sudo systemctl restart schulte-api
sleep 1
journalctl -u schulte-api -n 15 --no-pager || true

say "5/5 自检"
if command -v curl >/dev/null 2>&1; then
  for u in /api/health /api/games; do
    printf "  %-14s " "$u"
    curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:$API_PORT$u"
  done
  printf "  首页标题: "
  curl -s "http://127.0.0.1:$API_PORT/" | grep -o "<title>[^<]*</title>" | head -1
else
  echo "  没有 curl，跳过"
fi

echo
echo "完成。打开 https://fishquito.site 看看。"
echo "回滚：cp $SITE/index.old.html $SITE/public/index.html && sudo systemctl restart schulte-api"
