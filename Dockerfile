# Multi-stage Dockerfile for On-Call Assistant
#
# Targets:
#   - base: Common dependencies
#   - api: Catalog REST API server
#   - mcp: MCP server (for production deployment)

# ─────────────────────────────────────────────────────────────
# BASE STAGE
# ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS base

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source
COPY . .

# ─────────────────────────────────────────────────────────────
# BUILD STAGE
# ─────────────────────────────────────────────────────────────
FROM base AS build

RUN npm run build

# ─────────────────────────────────────────────────────────────
# API TARGET (Catalog REST API)
# ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS api

WORKDIR /app

# Copy only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built code
COPY --from=build /app/dist ./dist

# Run API server
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "dist/api/server.js"]

# ─────────────────────────────────────────────────────────────
# MCP TARGET (MCP Server)
# ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS mcp

WORKDIR /app

# Copy only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy built code
COPY --from=build /app/dist ./dist

# MCP uses stdio, not a port
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
