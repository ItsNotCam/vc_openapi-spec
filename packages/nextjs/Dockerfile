FROM oven/bun:1-debian

WORKDIR /app

# Copy workspace manifests
COPY package.json bun.lock tsconfig.base.json ./

# Copy packages needed for build
COPY packages/shared ./packages/shared/
COPY packages/nextjs ./packages/nextjs/

# Install all dependencies (dev deps needed for Next.js build)
RUN bun install

# Build Next.js app
WORKDIR /app/packages/nextjs
RUN bun run build

EXPOSE 3001

CMD ["bun", "run", "start"]
