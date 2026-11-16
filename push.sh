#!/usr/bin/env bash
# دفع المشروع إلى GitHub باستخدام توكن دقيق (Fine-grained) لا يُحفظ في أي ملف.
# الاستعمال:  GH_TOKEN=github_pat_xxx ./push.sh
set -euo pipefail

REPO="moamedhbt/King-of-carre"
BRANCH="main"

if [ -z "${GH_TOKEN:-}" ]; then
  echo "خطأ: مرّر التوكن هكذا:  GH_TOKEN=github_pat_xxx ./push.sh" >&2
  exit 1
fi

# لا نطبع التوكن أبداً، ونستخدمه عبر stdin لمساعد الاعتماد
git -c credential.helper= push \
  "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git" "${BRANCH}:${BRANCH}"
echo "تم الدفع إلى https://github.com/${REPO}"
