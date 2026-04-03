#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# SURFAI — Post-deploy verification
# Run after setup-server.sh completes: bash /opt/surfai/deploy/verify.sh
# =============================================================================

APP_PORT="${PORT:-3100}"
DOMAIN="${1:-surfai.ru}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; ERRORS=$((ERRORS + 1)); }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }

ERRORS=0

echo ""
echo "=== SURFAI Verification ==="
echo ""

# 1. Service running
echo "1. systemd service"
if systemctl is-active --quiet surfai 2>/dev/null; then
    pass "surfai.service is active"
else
    fail "surfai.service is NOT active"
fi

# 2. Port listening
echo "2. Port $APP_PORT"
if ss -tlnp | grep -q ":${APP_PORT}"; then
    pass "Port $APP_PORT is listening"
else
    fail "Nothing listening on port $APP_PORT"
fi

# 3. API health (local)
echo "3. Local API"
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${APP_PORT}/api/sessions?limit=1" 2>/dev/null || echo "000")
if [ "$HTTP_CODE" = "200" ]; then
    pass "GET /api/sessions -> 200"
else
    fail "GET /api/sessions -> $HTTP_CODE (expected 200)"
fi

# 4. Ingest endpoint
echo "4. Ingest endpoint"
INGEST_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "http://127.0.0.1:${APP_PORT}/api/events" \
    -H "Content-Type: application/json" \
    -d '{"sessionId":"test-verify-001","sentAt":1710000000000,"events":[{"type":"mouse","data":{"x":100,"y":200,"ts":1710000000000}}]}' \
    2>/dev/null || echo "000")
if [ "$INGEST_CODE" = "200" ]; then
    pass "POST /api/events -> 200 (test event ingested)"
else
    fail "POST /api/events -> $INGEST_CODE (expected 200)"
fi

# 5. SSE endpoint
echo "5. SSE stream"
SSE_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://127.0.0.1:${APP_PORT}/api/events/live" 2>/dev/null || echo "000")
if [ "$SSE_CODE" = "200" ] || [ "$SSE_CODE" = "028" ]; then
    pass "GET /api/events/live responds (SSE stream)"
else
    warn "SSE returned $SSE_CODE (may timeout — check manually)"
fi

# 6. Dashboard
echo "6. Dashboard"
DASH_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${APP_PORT}/dashboard/" 2>/dev/null || echo "000")
if [ "$DASH_CODE" = "200" ]; then
    pass "GET /dashboard/ -> 200"
else
    fail "GET /dashboard/ -> $DASH_CODE"
fi

# 7. Database
echo "7. Database connectivity"
TEST_SESSION=$(curl -s "http://127.0.0.1:${APP_PORT}/api/sessions?limit=1" 2>/dev/null)
if echo "$TEST_SESSION" | grep -q "sessions"; then
    pass "Database responding through API"
else
    warn "Could not confirm DB connectivity from API response"
fi

# 8. Nginx (if domain resolves)
echo "8. Nginx / domain"
if command -v host &>/dev/null; then
    if host "$DOMAIN" &>/dev/null; then
        EXT_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://${DOMAIN}/api/sessions?limit=1" 2>/dev/null || echo "000")
        if [ "$EXT_CODE" = "200" ]; then
            pass "http://${DOMAIN}/api/sessions -> 200 (external OK)"
        else
            warn "http://${DOMAIN} returned $EXT_CODE (DNS may not be pointed yet)"
        fi
    else
        warn "$DOMAIN does not resolve yet — point DNS A record to this server's IP"
    fi
else
    warn "Cannot check DNS (host command not available)"
fi

# Summary
echo ""
if [ "$ERRORS" -eq 0 ]; then
    echo -e "${GREEN}All checks passed!${NC}"
else
    echo -e "${RED}$ERRORS check(s) failed.${NC} Review above and fix."
fi
echo ""
