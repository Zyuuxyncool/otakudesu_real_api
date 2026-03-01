#!/bin/bash
# Otakudesu API Startup Script for Linux/Mac

echo ""
echo "========================================="
echo "    Otakudesu API v2.0.0"
echo "========================================="
echo ""

# Set environment variable
export NODE_TLS_REJECT_UNAUTHORIZED=0

# Kill existing process on port 3000
echo "[*] Checking port 3000..."
lsof -ti :3000 | xargs kill -9 2>/dev/null

echo "[*] Starting server..."
sleep 1

# Start the server
node index.js

echo ""
echo "Server stopped!"
