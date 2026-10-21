#!/bin/sh
# Runs the ASR bench on both test files inside a throwaway node:22-alpine container (installs ffmpeg
# in the container only). Nothing is installed on the host. Results go to ./results/.
#
#   ./run.sh                                     # SenseVoice on the 1Panel docker network (default)
#   NETWORK=host BASE=http://127.0.0.1:16661/v1 ./run.sh   # SenseVoice via the host port
#
# Env: BASE (default http://sensevoice:8040/v1), NETWORK (default 1panel-network), MODEL
# (default sensevoice-small), SEGMENT (default 28), ASR_API_KEY (default empty), IMAGE (default node:22-alpine),
# FILES (default "audio/zh-5min.m4a audio/mix-50s.m4a").
set -eu
cd "$(dirname "$0")"
export BASE="${BASE:-http://sensevoice:8040/v1}" MODEL="${MODEL:-sensevoice-small}" SEGMENT="${SEGMENT:-28}" ASR_API_KEY="${ASR_API_KEY:-}"
NETWORK="${NETWORK:-1panel-network}"
export FILES="${FILES:-audio/zh-5min.m4a audio/mix-50s.m4a}"
mkdir -p results
docker run --rm --network "$NETWORK" -v "$PWD":/w -w /w \
  -e BASE -e MODEL -e SEGMENT -e ASR_API_KEY -e FILES \
  "${IMAGE:-node:22-alpine}" sh -c '
    command -v ffmpeg >/dev/null || apk add --no-cache ffmpeg >/dev/null || { echo "could not install ffmpeg in the container"; exit 3; }
    rc=0
    for f in $FILES; do
      n=$(basename "$f"); n=${n%.*}
      echo "================ $f ================"
      node bench.mjs --out "results/$n.json" "$f" 2>&1 | tee "results/$n.log" || rc=1
      echo
    done
    chmod -R a+rw results 2>/dev/null || true
    exit $rc
  '
echo "Results: $(pwd)/results/"
