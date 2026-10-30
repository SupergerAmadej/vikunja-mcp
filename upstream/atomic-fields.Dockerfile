FROM golang:1.27.0-alpine@sha256:4c9fe60190a2a3350ddc51de80d0224b8a6698d12bdfc999fee45ea9d6c46dbc AS base
RUN apk add --no-cache build-base git
WORKDIR /source
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN mkdir -p frontend/dist && touch frontend/dist/index.html \
    && git init -b codex/atomic-regression \
    && git -c user.name='Atomic regression' -c user.email='audit@example.invalid' commit --allow-empty -m 'test: initialize isolated upstream harness'
RUN go build -ldflags '-X code.vikunja.io/api/pkg/version.Version=2.7.1' -o /out/vikunja-base .

FROM base AS patched
RUN git apply --check _atomic-fields.patch && git apply _atomic-fields.patch
RUN if ! go tool mage test:filter 'TestAtomicFieldUpdates|TestBulkTask|TestTask_Update|TestProject_CreateOrUpdate|TestLabel_Update|TestDeleteUser_DoesNotPromote|TestTaskBucket_Update|TestWebhookListener_|TestAPIToken_CanUseRoute' > /out/native-tests.log 2>&1; then cat /out/native-tests.log; exit 1; fi
RUN go build -ldflags '-X code.vikunja.io/api/pkg/version.Version=2.7.1+atomic-fields.1' -o /out/vikunja-atomic .

FROM scratch AS artifacts
COPY --from=base /out/vikunja-base /vikunja-base
COPY --from=patched /out/vikunja-atomic /vikunja-atomic
COPY --from=patched /out/native-tests.log /native-tests.log
COPY --from=base /source/LICENSE /LICENSE
