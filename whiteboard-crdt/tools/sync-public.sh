#!/bin/sh
# 把同构内核从 lib 拷贝到浏览器可访问的 public/lib
cp "$(dirname "$0")/lib/"*.js "$(dirname "$0")/public/lib/"
echo "synced lib -> public/lib"
