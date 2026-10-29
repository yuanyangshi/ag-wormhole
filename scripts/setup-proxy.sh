#!/bin/bash
set -e

# ============================================================================
# AG-Wormhole - Dual-Plane Tunnel Provisioning Script
# ============================================================================
# This script injects the zero-privilege syscall redirection wrapper into
# the target language server binaries to route traffic through the Wormhole
# data plane using mgraftcp-fakedns.
#
# Environment Variables:
#   PROXY_HOST        - Ingress host (default: __PROXY_HOST__)
#   PROXY_PORT        - Ingress port (default: __PROXY_PORT__)
#   PROXY_TYPE        - Tunnel mode: http or socks5 (default: __PROXY_TYPE__)
#   EXTENSION_PATH    - Absolute path to active extension package
#   EXTENSION_VERSION - Provisioning version for state synchronization
#   DEBUG             - Set to 1 for verbose diagnostics
# ============================================================================

PROXY_HOST="${PROXY_HOST:-__PROXY_HOST__}"
PROXY_PORT="${PROXY_PORT:-__PROXY_PORT__}"
PROXY_TYPE="${PROXY_TYPE:-__PROXY_TYPE__}"
EXTENSION_PATH="${EXTENSION_PATH:-}"
EXTENSION_VERSION="${EXTENSION_VERSION:-1.0.0}"
PROXY_ADDR="${PROXY_HOST}:${PROXY_PORT}"

DEBUG="${DEBUG:-0}"

debug_log() {
    if [ "$DEBUG" = "1" ]; then
        echo "[AG-Wormhole][DEBUG] $*"
    fi
}

info_log() {
    echo "[AG-Wormhole][INFO] $*"
}

warn_log() {
    echo "[AG-Wormhole][WARN] $*"
}

error_log() {
    echo "[AG-Wormhole][ERROR] $*"
}

echo "================================================================="
echo " AG-Wormhole: Autonomous Provisioning Engine"
echo "================================================================="
echo ""

ARCH=$(uname -m)
info_log "Host Architecture: $ARCH"
info_log "Tunnel Endpoint: $PROXY_ADDR ($PROXY_TYPE)"
info_log "Provisioning Version: $EXTENSION_VERSION"
if [ -n "$EXTENSION_PATH" ]; then
    info_log "Extension Mount: $EXTENSION_PATH"
fi

# Kernel TCP Keepalive check (warn if 7200s default is active)
if [ -f "/proc/sys/net/ipv4/tcp_keepalive_time" ]; then
    CURRENT_KEEPALIVE=$(cat /proc/sys/net/ipv4/tcp_keepalive_time 2>/dev/null || echo "0")
    if [ "$CURRENT_KEEPALIVE" -gt 300 ] 2>/dev/null; then
        warn_log "System TCP keepalive is currently ${CURRENT_KEEPALIVE}s (standard Linux 2h default)."
        warn_log "Dead connections may occupy port $PROXY_PORT after network drops."
        info_log "Recommendation: Run 'sudo sysctl -w net.ipv4.tcp_keepalive_time=60' on this host."
    else
        debug_log "System TCP keepalive optimized (${CURRENT_KEEPALIVE}s)"
    fi
fi
echo ""

case "$ARCH" in
    x86_64|amd64) 
        EXPECTED_BINARY="mgraftcp-fakedns-linux-amd64"
        EXPECTED_LIB="libdnsredir-linux-amd64.so"
        ;;
    aarch64|arm64) 
        EXPECTED_BINARY="mgraftcp-fakedns-linux-arm64"
        EXPECTED_LIB="libdnsredir-linux-arm64.so"
        ;;
    *) 
        EXPECTED_BINARY="mgraftcp-fakedns-linux-$ARCH"
        EXPECTED_LIB="libdnsredir-linux-$ARCH.so"
        ;;
esac

debug_log "Expected Engine Binary: $EXPECTED_BINARY"
debug_log "Expected FakeDNS Library: $EXPECTED_LIB"

# ============================================================================
# Server Workspace Discovery
# ============================================================================
POSSIBLE_SERVER_DIRS=(
    "$HOME/.ag-wormhole"
    "$HOME/.antigravity-ide-server"
    "$HOME/.antigravity-server"
)

SERVER_DIR=""
for dir in "${POSSIBLE_SERVER_DIRS[@]}"; do
    if [ -d "$dir/bin" ]; then
        SERVER_DIR="$dir"
        break
    fi
done

if [ -z "$SERVER_DIR" ]; then
    error_log "No Antigravity server workspace discovered."
    error_log "Scanned candidates: ${POSSIBLE_SERVER_DIRS[*]}"
    exit 1
fi

info_log "Discovered Workspace: $SERVER_DIR"

# ============================================================================
# Helper Functions
# ============================================================================

get_wrapper_version() {
    local wrapper="$1"
    grep -oP 'WRAPPER_VERSION="\K[^"]+' "$wrapper" 2>/dev/null || echo "none"
}

get_wrapper_proxy_addr() {
    local wrapper="$1"
    grep -oP 'PROXY_ADDR="\K[^"]+' "$wrapper" 2>/dev/null || echo "none"
}

get_wrapper_proxy_type() {
    local wrapper="$1"
    grep -oP 'PROXY_TYPE="\K[^"]+' "$wrapper" 2>/dev/null || echo "none"
}

is_wrapper_script() {
    local target="$1"
    head -1 "$target" 2>/dev/null | grep -q "^#!/bin/bash"
}

check_needs_update() {
    local target="$1"
    
    if ! is_wrapper_script "$target"; then
        echo "new_install"
        return 0
    fi
    
    local wrapper_version=$(get_wrapper_version "$target")
    if [ "$EXTENSION_VERSION" != "$wrapper_version" ]; then
        echo "version:$wrapper_version->$EXTENSION_VERSION"
        return 0
    fi
    
    local wrapper_proxy_addr=$(get_wrapper_proxy_addr "$target")
    if [ "$PROXY_ADDR" != "$wrapper_proxy_addr" ]; then
        echo "proxy_addr:$wrapper_proxy_addr->$PROXY_ADDR"
        return 0
    fi
    
    local wrapper_proxy_type=$(get_wrapper_proxy_type "$target")
    if [ "$PROXY_TYPE" != "$wrapper_proxy_type" ]; then
        echo "proxy_type:$wrapper_proxy_type->$PROXY_TYPE"
        return 0
    fi
    
    return 1
}

# ============================================================================
# Discover Target Language Servers
# ============================================================================
info_log "Scanning for language server binaries..."
TARGETS=$(find "$SERVER_DIR/bin" -path "*/extensions/antigravity/bin/language_server_linux_*" -type f 2>/dev/null | grep -v ".bak$")

if [ -z "$TARGETS" ]; then
    error_log "No eligible language server binaries identified."
    exit 1
fi

TARGET_COUNT=$(echo "$TARGETS" | wc -l)
info_log "Identified $TARGET_COUNT language server binary target(s)"
echo ""

# ============================================================================
# Intercept and Configure Targets
# ============================================================================
CONFIGURED_COUNT=0
SKIPPED_COUNT=0

while IFS= read -r TARGET; do
    [ -z "$TARGET" ] && continue
    
    echo "-----------------------------------------------------------------"
    info_log "Processing target: $TARGET"
    BAK="${TARGET}.bak"
    
    if UPDATE_REASON=$(check_needs_update "$TARGET"); then
        info_log "Interception update required: $UPDATE_REASON"
    else
        info_log "Already configured and up-to-date (v$EXTENSION_VERSION, $PROXY_ADDR, $PROXY_TYPE)"
        SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
        continue
    fi

    if [ ! -f "$BAK" ]; then
        if is_wrapper_script "$TARGET"; then
            error_log "Target is already an intercepted wrapper, but backup does not exist!"
            continue
        fi
        mv "$TARGET" "$BAK"
        info_log "Atomic backup created: $BAK"
    else
        debug_log "Backup confirmed: $BAK"
    fi

cat > "$TARGET" << 'WRAPPER_EOF'
#!/bin/bash
# ============================================================================
# AG-Wormhole - Syscall Redirection Sandbox Wrapper
# ============================================================================
# WRAPPER_VERSION="__EXTENSION_VERSION_PLACEHOLDER__"
# GENERATED="__TIMESTAMP_PLACEHOLDER__"
# ============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"

PROXY_ADDR="__PROXY_ADDR_PLACEHOLDER__"
PROXY_TYPE="__PROXY_TYPE_PLACEHOLDER__"
EXTENSION_BIN_PATH="__EXTENSION_BIN_PATH_PLACEHOLDER__"

find_binaries() {
    local arch=$(uname -m)
    local binary_name=""
    local lib_name=""
    case "$arch" in
        x86_64|amd64) 
            binary_name="mgraftcp-fakedns-linux-amd64"
            lib_name="libdnsredir-linux-amd64.so"
            ;;
        aarch64|arm64) 
            binary_name="mgraftcp-fakedns-linux-arm64"
            lib_name="libdnsredir-linux-arm64.so"
            ;;
        *) return 1 ;;
    esac
    
    # Method 1: Check primary active extension mount
    if [ -n "$EXTENSION_BIN_PATH" ] && [ -d "$EXTENSION_BIN_PATH" ]; then
        if [ -f "$EXTENSION_BIN_PATH/$binary_name" ]; then
            echo "$EXTENSION_BIN_PATH/$binary_name"
            if [ -f "$EXTENSION_BIN_PATH/$lib_name" ]; then
                echo "$EXTENSION_BIN_PATH/$lib_name"
            fi
            return 0
        fi
    fi
    
    # Method 2: Dynamic discovery across extension directories
    for dir in $(ls -d "$HOME/.ag-wormhole/extensions/"*ag-wormhole*/resources/bin \
                       "$HOME/.antigravity-ide-server/extensions/"*ag-wormhole*/resources/bin \
                       "$HOME/.antigravity-server/extensions/"*ag-wormhole*/resources/bin \
                       2>/dev/null | sort -t'-' -k3 -V -r); do
        if [ -f "$dir/$binary_name" ]; then
            echo "$dir/$binary_name"
            if [ -f "$dir/$lib_name" ]; then
                echo "$dir/$lib_name"
            fi
            return 0
        fi
    done
    return 1
}

BINARIES=$(find_binaries)
MGRAFTCP_PATH=$(echo "$BINARIES" | head -1)
DNSREDIR_PATH=$(echo "$BINARIES" | tail -1)

if [ -z "$MGRAFTCP_PATH" ] || [ ! -f "$MGRAFTCP_PATH" ]; then
    # Fallback directly to native backup binary if redirection engine is absent
    exec "$SCRIPT_DIR/$SCRIPT_NAME.bak" "$@"
fi

chmod +x "$MGRAFTCP_PATH" 2>/dev/null || true

# Force Go runtime netdns to cgo for LD_PRELOAD intercept compatibility
export GODEBUG="${GODEBUG:+$GODEBUG,}netdns=cgo"

if [ "$PROXY_TYPE" = "socks5" ]; then
    exec "$MGRAFTCP_PATH" --socks5 "$PROXY_ADDR" "$SCRIPT_DIR/$SCRIPT_NAME.bak" "$@"
else
    exec "$MGRAFTCP_PATH" --http_proxy "$PROXY_ADDR" "$SCRIPT_DIR/$SCRIPT_NAME.bak" "$@"
fi
WRAPPER_EOF

    sed -i "s|__PROXY_ADDR_PLACEHOLDER__|$PROXY_ADDR|g" "$TARGET"
    sed -i "s|__PROXY_TYPE_PLACEHOLDER__|$PROXY_TYPE|g" "$TARGET"
    sed -i "s|__EXTENSION_VERSION_PLACEHOLDER__|$EXTENSION_VERSION|g" "$TARGET"
    sed -i "s|__TIMESTAMP_PLACEHOLDER__|$(date -Iseconds)|g" "$TARGET"
    
    if [ -n "$EXTENSION_PATH" ]; then
        EXTENSION_BIN_DIR="$EXTENSION_PATH/resources/bin"
        sed -i "s|__EXTENSION_BIN_PATH_PLACEHOLDER__|$EXTENSION_BIN_DIR|g" "$TARGET"
    else
        sed -i "s|__EXTENSION_BIN_PATH_PLACEHOLDER__||g" "$TARGET"
    fi

    chmod +x "$TARGET"
    info_log "Interception sandbox injected successfully"
    info_log "  Target: $TARGET"
    info_log "  Endpoint: $PROXY_ADDR ($PROXY_TYPE)"
    CONFIGURED_COUNT=$((CONFIGURED_COUNT + 1))

done <<< "$TARGETS"

# ============================================================================
# Summary
# ============================================================================
echo ""
echo "================================================================="
echo " AG-Wormhole: Provisioning Summary"
echo "================================================================="
echo "  Version: $EXTENSION_VERSION"
echo "  Tunnel Endpoint: $PROXY_ADDR ($PROXY_TYPE)"
echo "-----------------------------------------------------------------"
if [ $CONFIGURED_COUNT -gt 0 ]; then
    echo "  Configured: $CONFIGURED_COUNT sandbox wrapper(s) deployed"
fi
if [ $SKIPPED_COUNT -gt 0 ]; then
    echo "  Skipped: $SKIPPED_COUNT wrapper(s) already synchronized"
fi
echo "================================================================="

if [ $CONFIGURED_COUNT -gt 0 ]; then
    echo ""
    echo "Setup complete: proxy=$PROXY_ADDR"
    echo "Notice: Window reload required to activate the newly injected sandbox."
elif [ $SKIPPED_COUNT -gt 0 ]; then
    echo ""
    echo "Already configured with $PROXY_ADDR (v$EXTENSION_VERSION)"
else
    echo ""
    error_log "No language server binaries could be configured."
    exit 1
fi
