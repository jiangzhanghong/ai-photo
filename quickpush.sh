#!/bin/bash

# 默认提交信息
DEFAULT_MSG="quick commit"

# 获取提交信息（如果没有参数则使用默认值）
if [ $# -eq 0 ]; then
    msg="$DEFAULT_MSG"
else
    # 将所有参数拼接为一条消息，支持带空格的内容
    msg="$*"
fi

echo "▶ 添加所有变更：git add ."
git add .
if [ $? -ne 0 ]; then
    echo "❌ git add . 失败"
    exit 1
fi

# 检查暂存区是否有内容（避免无意义提交）
if git diff --cached --quiet; then
    echo "✨ 没有需要提交的变更，脚本结束。"
    exit 0
fi

echo "▶ 提交变更：git commit -m \"$msg\""
git commit -m "$msg"
if [ $? -ne 0 ]; then
    echo "❌ 提交失败"
    exit 1
fi

echo "▶ 推送到远程 main 分支：git push origin main"
git push origin main
if [ $? -ne 0 ]; then
    echo "❌ 推送失败"
    exit 1
fi

echo "✅ 完成！已提交并推送到 origin/main"
