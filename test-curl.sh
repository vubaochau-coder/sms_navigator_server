#!/usr/bin/env bash

set -e

BASE_URL="${1:-http://localhost:3000}"
PAIR_ID="pair_demo_$(date +%s)"
FAKE_FCM_TOKEN="fcm_token_device_b_malaysia_$(date +%s)_abcdef123456"

echo "=========================================="
echo "Testing SMS Navigator Server: $BASE_URL"
echo "=========================================="

echo -e "\n1. Testing Health Check (GET /health)..."
curl -s -X GET "$BASE_URL/health" | jq . || curl -s -X GET "$BASE_URL/health"

echo -e "\n\n2. Testing Pair Confirm from Device B (POST /api/v1/pair/confirm)..."
curl -s -X POST "$BASE_URL/api/v1/pair/confirm" \
  -H "Content-Type: application/json" \
  -d '{
    "pair_id": "'"$PAIR_ID"'",
    "fcm_token": "'"$FAKE_FCM_TOKEN"'",
    "device_name": "Samsung S24 (Malaysia)",
    "platform": "android"
  }' | jq . || true

echo -e "\n\n3. Testing Query Pair Status (GET /api/v1/pair/status/'$PAIR_ID')..."
curl -s -X GET "$BASE_URL/api/v1/pair/status/$PAIR_ID" | jq . || true

NOW=$(date +%s)
echo -e "\n\n4. Testing OTP Relay from Device A (POST /api/v1/relay)..."
curl -s -X POST "$BASE_URL/api/v1/relay" \
  -H "Content-Type: application/json" \
  -d '{
    "pair_id": "'"$PAIR_ID"'",
    "device_id": "sender_device_vietnam_001",
    "encrypted_payload": "f8a7b9c0d1e2f3a4_encrypted_aes_gcm_sample",
    "iv": "dGVzdF9pdl8xMmJ5dGVz",
    "sent_at": '"$NOW"',
    "ttl_seconds": 300
  }' | jq . || true

echo -e "\n\n5. Testing Revoke Pair Session (DELETE /api/v1/pair/'$PAIR_ID')..."
curl -s -X DELETE "$BASE_URL/api/v1/pair/$PAIR_ID" | jq . || true

echo -e "\n\n6. Verifying Pair Status after revocation..."
curl -s -X GET "$BASE_URL/api/v1/pair/status/$PAIR_ID" | jq . || true

echo -e "\n=========================================="
echo "✅ All curl endpoint tests executed successfully!"
echo "=========================================="
