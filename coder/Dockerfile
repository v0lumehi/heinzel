# Heinzel coding container: git + OpenCode, one task per container.
# Extend it with your project's toolchain (FROM heinzel-coder, then install JDK, Python, …) so the agent can run tests.
FROM node:25-slim
ARG OPENCODE_VERSION=2.0.32

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates ripgrep \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g @opencode/cli@${OPENCODE_VERSION} \
 && npm cache clean --force \
 && useradd --create-home --uid 10001 coder \
 && mkdir -p /srv && chmod 700 /srv

COPY entrypoint.mjs /usr/local/lib/heinzel/entrypoint.mjs
# Runs as root to clone and push; the agent itself runs as "coder" (see entrypoint.mjs).
ENTRYPOINT ["node", "/usr/local/lib/heinzel/entrypoint.mjs"]
