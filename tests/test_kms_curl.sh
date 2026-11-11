#!/bin/bash

# Test KMS API with curl commands
# This provides a quick verification without requiring boto3 or AWS CLI

set -e

ENDPOINT="http://localhost:3000/api/kms"
ACCOUNT_ID="123456789012"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

PASSED=0
FAILED=0

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "KMS API Testing with curl"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Endpoint: $ENDPOINT"
echo ""

test_api() {
    local name=$1
    local method=$2
    local url=$3
    local data=$4
    
    echo -e "${BLUE}Test: $name${NC}"
    echo "  Method: $method"
    echo "  URL: $url"
    
    if [ -n "$data" ]; then
        echo "  Data: $data"
        response=$(curl -s -X "$method" "$url" \
            -H "x-account-id: $ACCOUNT_ID" \
            -H "Content-Type: application/json" \
            -d "$data")
    else
        response=$(curl -s -X "$method" "$url" \
            -H "x-account-id: $ACCOUNT_ID" \
            -H "Content-Type: application/json")
    fi
    
    # Check for errors
    if echo "$response" | grep -q "error\|__type"; then
        echo -e "  ${RED}✗ FAILED${NC}"
        echo "  Response: $response"
        FAILED=$((FAILED + 1))
    else
        echo -e "  ${GREEN}✓ PASSED${NC}"
        echo "  Response: $(echo "$response" | head -c 100)..."
        PASSED=$((PASSED + 1))
    fi
    echo ""
}

# Test 1: ListKeys
test_api "ListKeys" "GET" \
    "$ENDPOINT?action=ListKeys"

# Test 2: DescribeKey - S3 Default
test_api "DescribeKey (S3 Default)" "GET" \
    "$ENDPOINT?action=DescribeKey&keyId=12345678-1234-1234-1234-123456789012"

# Test 3: DescribeKey - S3-Only
test_api "DescribeKey (S3-Only)" "GET" \
    "$ENDPOINT?action=DescribeKey&keyId=87654321-4321-4321-4321-210987654321"

# Test 4: DescribeKey - Decrypt-Only
test_api "DescribeKey (Decrypt-Only)" "GET" \
    "$ENDPOINT?action=DescribeKey&keyId=11111111-2222-3333-4444-555555555555"

# Test 5: GetKeyPolicy
test_api "GetKeyPolicy" "GET" \
    "$ENDPOINT?action=GetKeyPolicy&keyId=12345678-1234-1234-1234-123456789012"

# Test 6: GetKeyRotationStatus
test_api "GetKeyRotationStatus" "GET" \
    "$ENDPOINT?action=GetKeyRotationStatus&keyId=12345678-1234-1234-1234-123456789012"

# Test 7: CreateKey
test_api "CreateKey" "POST" \
    "$ENDPOINT" \
    '{"action":"CreateKey","description":"Test key from curl","policy":{}}'

# Test 8: RotateKey
test_api "RotateKey" "POST" \
    "$ENDPOINT" \
    '{"action":"RotateKey","keyId":"12345678-1234-1234-1234-123456789012"}'

# Test 9: EnableKeyRotation
test_api "EnableKeyRotation" "POST" \
    "$ENDPOINT" \
    '{"action":"EnableKeyRotation","keyId":"12345678-1234-1234-1234-123456789012"}'

# Test 10: GetKeyRotationStatus (after enabling)
test_api "GetKeyRotationStatus (After Enable)" "GET" \
    "$ENDPOINT?action=GetKeyRotationStatus&keyId=12345678-1234-1234-1234-123456789012"

# Print summary
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Test Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}✓ Passed: $PASSED${NC}"
echo -e "${RED}✗ Failed: $FAILED${NC}"

if [ $FAILED -eq 0 ]; then
    echo -e "\n${GREEN}✓ All tests passed!${NC}"
    exit 0
else
    echo -e "\n${RED}✗ Some tests failed${NC}"
    exit 1
fi
