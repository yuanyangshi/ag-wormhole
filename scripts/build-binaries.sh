#!/bin/bash
# Build mgraftcp-enhanced binaries for Linux (amd64 and arm64)
# This builds both mgraftcp and libdnsredir.so for DNS pollution prevention
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$PROJECT_DIR/resources/bin"
# Updated: Use local graftcp repo with enhancements
GRAFTCP_LOCAL_PATH="${GRAFTCP_LOCAL_PATH:-/home/ubuntu/main/graftcp}"
GO_VERSION="1.23.4"

# Check if local graftcp exists, otherwise clone from upstream
if [ ! -d "$GRAFTCP_LOCAL_PATH" ]; then
    GRAFTCP_REPO="https://github.com/hmgle/graftcp.git"
    echo "Cloning graftcp from $GRAFTCP_REPO..."
    GRAFTCP_LOCAL_PATH="/tmp/graftcp-enhanced"
    rm -rf "$GRAFTCP_LOCAL_PATH"
    git clone --depth 1 "$GRAFTCP_REPO" "$GRAFTCP_LOCAL_PATH"
fi

if ! command -v go &>/dev/null; then
    echo "Installing Go $GO_VERSION..."
    GO_TAR="go${GO_VERSION}.linux-amd64.tar.gz"
    wget -q "https://go.dev/dl/${GO_TAR}" -O "/tmp/${GO_TAR}"
    sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf "/tmp/${GO_TAR}"
    rm "/tmp/${GO_TAR}"
fi
export PATH="/usr/local/go/bin:$PATH"

if ! command -v aarch64-linux-gnu-gcc &>/dev/null; then
    echo "Installing arm64 cross-compiler..."
    sudo apt-get update -qq && sudo apt-get install -y -qq gcc-aarch64-linux-gnu
fi

mkdir -p "$OUTPUT_DIR"

build_for_arch() {
    local arch=$1
    local cross_prefix=$2
    
    echo "Building for linux-$arch..."
    cd "$GRAFTCP_LOCAL_PATH"
    
    # Clean previous build
    make -C local clean 2>/dev/null || true
    
    # Build with cross-compiler if specified
    if [ -n "$cross_prefix" ]; then
        make CROSS_COMPILE="$cross_prefix"
        # Build libdnsredir.so for arm64
        cd local/dnsredir
        ${cross_prefix}gcc -Wall -Wextra -O2 -fPIC -o libdnsredir.so dnsredir.c -shared -ldl
        cd "$GRAFTCP_LOCAL_PATH"
    else
        make
        # dnsredir is built as part of make in local/
    fi
    
    # Copy outputs
    cp local/mgraftcp "$OUTPUT_DIR/mgraftcp-linux-$arch"
    cp local/dnsredir/libdnsredir.so "$OUTPUT_DIR/libdnsredir-linux-$arch.so"
    
    echo "Built: $OUTPUT_DIR/mgraftcp-linux-$arch"
    echo "Built: $OUTPUT_DIR/libdnsredir-linux-$arch.so"
}

build_for_arch "amd64" ""
build_for_arch "arm64" "aarch64-linux-gnu-"

echo ""
echo "Build complete!"
ls -la "$OUTPUT_DIR"
