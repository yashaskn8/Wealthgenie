# Build stage
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS build

WORKDIR /app

ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL
ARG VITE_BUILD_SHA
ENV VITE_BUILD_SHA=$VITE_BUILD_SHA
# The two private financial workspaces are opt-in at build time. Vite cannot
# read Kubernetes ConfigMap variables after these assets are compiled.
# Enable only when matching API flags, migrations, secrets and readiness pass.
ARG VITE_RUNWAY_ENABLED=false
ENV VITE_RUNWAY_ENABLED=${VITE_RUNWAY_ENABLED}
ARG VITE_COVERAGE_ENABLED=false
ENV VITE_COVERAGE_ENABLED=${VITE_COVERAGE_ENABLED}

COPY reactapp/package*.json ./
RUN npm ci

COPY reactapp/. .
# The frontend intentionally imports two shared root-level contracts. Keep the
# Docker build context at the project root and place shared/ where the existing
# relative imports resolve (/app/src/... -> /shared/...).
COPY shared /shared
RUN chown -R node:node /app /shared
USER node
RUN npm run build

# Production stage
FROM nginx:alpine@sha256:72ba65eb42c10344912a84ff42408db7d34f2feb642204570ab8fc5ffd29f1d3

COPY --from=build /app/dist /usr/share/nginx/html
COPY reactapp/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
