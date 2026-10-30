# Production backend: verified source, reviewed patch, real frontend and static API.
FROM node:24.22.0-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS source
RUN apk add --no-cache git
WORKDIR /prepare
COPY upstream ./upstream
RUN node upstream/prepare-source.mjs /source /source-artifacts

FROM node:24.22.0-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f AS frontend
WORKDIR /build
ENV PUPPETEER_SKIP_DOWNLOAD=true CYPRESS_INSTALL_BINARY=0
COPY --from=source /source/frontend/package.json /source/frontend/pnpm-lock.yaml /source/frontend/pnpm-workspace.yaml ./
# Match packageManager in the verified upstream package.json.
RUN npm install --global pnpm@11.27.0 && pnpm install --frozen-lockfile
COPY --from=source /source/frontend ./
RUN pnpm run build
COPY --from=source /source-artifacts/vikunja-2.7.1-atomic-fields.1.tar.gz ./dist/source/vikunja-2.7.1-atomic-fields.1.tar.gz

FROM golang:1.27.0-alpine@sha256:4c9fe60190a2a3350ddc51de80d0224b8a6698d12bdfc999fee45ea9d6c46dbc AS api
RUN apk add --no-cache build-base git ca-certificates
WORKDIR /source
COPY --from=source /source/go.mod /source/go.sum ./
RUN go mod download
COPY --from=source /source ./
COPY --from=frontend /build/dist ./frontend/dist
RUN CGO_ENABLED=1 go build -trimpath -tags 'osusergo netgo timetzdata' \
    -ldflags '-s -w -linkmode external -extldflags "-static" -X code.vikunja.io/api/pkg/version.Version=2.7.1+atomic-fields.1 -X "main.Tags=osusergo netgo timetzdata"' \
    -o /out/vikunja .
RUN mkdir -p /runtime/tmp /runtime/db /runtime/app/vikunja/files \
    && chmod 1777 /runtime/tmp \
    && chown -R 1000:1000 /runtime/db /runtime/app

FROM scratch AS runtime
LABEL org.opencontainers.image.title="Vikunja with atomic field updates" \
      org.opencontainers.image.version="2.7.1+atomic-fields.1" \
      org.opencontainers.image.revision="5619c4a9f66ddfc13f7bbba24ada07c3e82ae7a0" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"
COPY --from=api /runtime/ /
COPY --from=api /out/vikunja /app/vikunja/vikunja
COPY --from=api /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=source /source-artifacts/LICENSE /usr/share/licenses/vikunja/LICENSE
COPY --from=source /source/upstream/vikunja-2.7.1-atomic-fields.json /usr/share/vikunja/source-manifest.json
WORKDIR /app/vikunja
USER 1000:1000
ENV VIKUNJA_SERVICE_ROOTPATH=/app/vikunja/ \
    VIKUNJA_DATABASE_PATH=/db/vikunja.db \
    VIKUNJA_FILES_BASEPATH=/app/vikunja/files \
    VIKUNJA_LOG_PATH=/tmp/logs
EXPOSE 3456
ENTRYPOINT ["/app/vikunja/vikunja"]
