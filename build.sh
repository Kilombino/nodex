#!/bin/sh
# Builds web/src -> web/dist with esbuild inside a node container (nice, max 3 CPUs).
# The live site switches to the new build atomically (dist is replaced by rename).
set -eu
cd "$(dirname "$0")"
V=$(cat web/src/*.js web/src/*.css web/src/*.html | sha256sum | cut -c1-10)
rm -rf web/dist.new && mkdir -p web/dist.new/assets
nice -n 10 docker run --rm --cpus 3 --user "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_cache=/tmp/.npm \
  -v "$PWD/web:/w" -w /w node:22-slim sh -c "
    npx -y esbuild@0.24.0 src/app.js --bundle --minify --format=esm --target=es2020 --outfile=dist.new/assets/app.js &&
    npx -y esbuild@0.24.0 src/app.css --minify --outfile=dist.new/assets/app.css"
sed "s/__V__/$V/g" web/src/index.html > web/dist.new/index.html
cp web/src/favicon.svg web/dist.new/favicon.svg
printf 'User-agent: *\nAllow: /\n' > web/dist.new/robots.txt
# Swap contents (keep the dist directory inode: it is bind-mounted into nodex-web)
mkdir -p web/dist
rm -rf web/dist.old && mkdir web/dist.old
cp -a web/dist/. web/dist.old/ 2>/dev/null || true
rsync -a --delete web/dist.new/ web/dist/
rm -rf web/dist.new
echo "built version $V"
