#!/usr/bin/env bash
# Smoke test against a running instance (fresh data dir, LLM pointed at scripts/mock-llm.mjs).
# Usage: BASE=http://127.0.0.1:3000 SETUP_CODE=ABCDE-FGHJK scripts/smoke.sh
# Without SETUP_CODE the code is read from $SETUP_CODE_FILE (default ./data/setup-code)
# or from `docker compose logs` in the current directory.
set -euo pipefail
BASE=${BASE:-http://127.0.0.1:3000}
if [ -z "${SETUP_CODE:-}" ]; then
  F=${SETUP_CODE_FILE:-./data/setup-code}
  if [ -r "$F" ]; then SETUP_CODE=$(tr -d '[:space:]' < "$F")
  else SETUP_CODE=$(docker compose logs 2>/dev/null | sed -n 's/.*SETUP CODE: \([A-Z0-9-]*\).*/\1/p' | tail -1); fi
fi
JAR=$(mktemp)
J=(-H 'content-type: application/json')
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; exit 1; }

curl -fsS "$BASE/api/health" | grep -q '"ok":true' && pass health
curl -fsS "$BASE/api/setup" | grep -q '"needsSetup":true' && pass "setup needed on fresh install"
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/docs")" = 401 ] && pass "API requires login"
[ "$(curl -s -o /dev/null -w '%{http_code}' "${J[@]}" -d '{"username":"admin","password":"password123","setupCode":"WRONG-CODE0"}' "$BASE/api/setup")" = 403 ] && pass "wrong setup code rejected"
[ -n "${SETUP_CODE:-}" ] || fail "no setup code found (set SETUP_CODE)"
curl -fsS -c "$JAR" "${J[@]}" -d "{\"username\":\"admin\",\"password\":\"password123\",\"setupCode\":\"$SETUP_CODE\"}" "$BASE/api/setup" | grep -q '"isAdmin":true' && pass "setup with code created admin"
[ "$(curl -s -o /dev/null -w '%{http_code}' "${J[@]}" -d "{\"username\":\"x2\",\"password\":\"password123\",\"setupCode\":\"$SETUP_CODE\"}" "$BASE/api/setup")" = 403 ] && pass "setup closed afterwards (code invalidated)"
rm -f "$JAR"; JAR=$(mktemp)
curl -fsS -c "$JAR" "${J[@]}" -d '{"username":"admin","password":"password123"}' "$BASE/api/auth/login" | grep -q admin && pass login
DOC=$(curl -fsS -b "$JAR" "${J[@]}" -d '{"title":"冒烟测试"}' "$BASE/api/docs" | sed -E 's/.*"id":"([^"]+)".*/\1/')
[ -n "$DOC" ] && pass "create doc $DOC"
TEXT='人工智能的发展历程。人工智能经历了多次起伏。\n\n深度学习在2012年取得突破。GPU让训练大模型成为可能。\n\n大语言模型带来了新的变化。各行各业开始探索应用。'
SSE=$(curl -fsS -N -b "$JAR" "${J[@]}" -d "{\"text\":\"$TEXT\",\"title\":\"冒烟测试\"}" "$BASE/api/generate")
echo "$SSE" | grep -q '^event: delta' && pass "generation streams deltas"
echo "$SSE" | grep -q '^event: done' || { echo "$SSE" | tail -5; fail "generation done"; }
MD=$(echo "$SSE" | grep -A1 '^event: done' | grep '^data:' | sed 's/^data: //' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).markdown))')
echo "$MD" | head -1 | grep -q '^# 人工智能的发展历程' && pass "generated outline: $(echo "$MD" | wc -l) lines"
BODY=$(node -e 'process.stdout.write(JSON.stringify({markdown: process.argv[1]}))' "$MD")
curl -fsS -b "$JAR" "${J[@]}" -X PUT -d "$BODY" "$BASE/api/docs/$DOC" >/dev/null && pass save
GOT=$(curl -fsS -b "$JAR" "$BASE/api/docs/$DOC/export?format=md")
[ "$GOT" = "$MD" ] && pass "reload returns saved Markdown"
curl -fsS -b "$JAR" "$BASE/api/docs/$DOC/export?format=opml" | grep -q '<outline text="人工智能的发展历程">' && pass "export opml"
curl -fsS -b "$JAR" "$BASE/api/docs/$DOC/export?format=json" | grep -q '"kind": "heading"' && pass "export json"
curl -fsS -b "$JAR" "${J[@]}" -d '{}' "$BASE/api/settings/test" | grep -q '"ok":true' && pass "settings test connection"
ALL=$(for p in /api/settings /api/settings/public /api/auth/me /api/docs "/api/docs/$DOC"; do curl -fsS -b "$JAR" "$BASE$p"; done)
echo "$ALL" | grep -q "${LEAK_CHECK_KEY:-sk-test-secret}" && fail "API key leaked" || pass "API key not in any response"
curl -fsS "$BASE/" | grep -q '<div id="root">' && pass "frontend served"
rm -f "$JAR"
echo "smoke test passed"
