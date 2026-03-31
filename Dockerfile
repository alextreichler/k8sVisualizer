FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w -X main.Version=${VERSION}" -o /k8svis .

FROM scratch
COPY --from=build /k8svis /k8svis
EXPOSE 8090
USER 65534
ENTRYPOINT ["/k8svis"]
