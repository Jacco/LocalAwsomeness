#!/usr/bin/env python3
"""
S3-KMS Integration Tests
Tests encryption support in S3 with KMS permission validation
"""

import requests
import json
import sys

BASE_URL = "http://localhost:3000/api"
ACCOUNT = "123456789012"
REGION = "us-east-1"

# Example KMS keys from KMS Step 0
KEY_S3_DEFAULT = "12345678-1234-1234-1234-123456789012"  # S3 + Lambda have GenerateDataKey + Decrypt
KEY_S3_ONLY = "87654321-4321-4321-4321-210987654321"  # S3 only, no Lambda
KEY_DECRYPT_ONLY = "11111111-2222-3333-4444-555555555555"  # Lambda Decrypt only (no GenerateDataKey)

# IAM principals
LAMBDA_PRINCIPAL = "arn:aws:iam::123456789012:role/lambda-executor"
S3_SERVICE_PRINCIPAL = "s3.amazonaws.com"

# Test results
tests_passed = 0
tests_failed = 0

def log_test(name, passed, message=""):
    global tests_passed, tests_failed
    status = "✓ PASS" if passed else "✗ FAIL"
    print(f"\n{status}: {name}")
    if message:
        print(f"       {message}")
    if passed:
        tests_passed += 1
    else:
        tests_failed += 1

def s3_request(action, bucket, key=None, body=None, headers=None):
    """Make an S3 API request"""
    default_headers = {
        "x-account-id": ACCOUNT,
        "x-region": REGION,
        "Content-Type": "application/json"
    }
    if headers:
        default_headers.update(headers)
    
    params = {
        "action": action,
        "Bucket": bucket,
    }
    if key:
        params["Key"] = key
    if body is not None:
        params["Body"] = body
    
    try:
        response = requests.get(
            f"{BASE_URL}/s3",
            params=params,
            headers=default_headers,
            timeout=5
        )
        return response
    except Exception as e:
        print(f"Request error: {e}")
        return None

def create_bucket(bucket_name):
    """Create an S3 bucket"""
    response = requests.post(
        f"{BASE_URL}/s3",
        headers={
            "x-account-id": ACCOUNT,
            "x-region": REGION,
            "Content-Type": "application/json"
        },
        json={
            "action": "CreateBucket",
            "Bucket": bucket_name
        }
    )
    return response.status_code == 200

def put_bucket_encryption(bucket_name, key_id):
    """Set bucket default encryption"""
    response = requests.post(
        f"{BASE_URL}/s3",
        headers={
            "x-account-id": ACCOUNT,
            "x-region": REGION,
            "Content-Type": "application/json"
        },
        json={
            "action": "PutBucketEncryption",
            "Bucket": bucket_name,
            "ServerSideEncryption": {
                "Rules": [
                    {
                        "ApplyServerSideEncryptionByDefault": {
                            "SSEAlgorithm": "aws:kms",
                            "KMSMasterKeyID": key_id
                        }
                    }
                ]
            }
        }
    )
    return response.status_code == 200, response

def put_object(bucket_name, key, body, principal=None, headers=None):
    """Put an S3 object"""
    req_headers = {
        "x-account-id": ACCOUNT,
        "x-region": REGION,
        "Content-Type": "application/json"
    }
    if principal:
        req_headers["x-principal"] = principal
    if headers:
        req_headers.update(headers)
    
    response = requests.post(
        f"{BASE_URL}/s3",
        headers=req_headers,
        json={
            "action": "PutObject",
            "Bucket": bucket_name,
            "Key": key,
            "Body": body,
            "ContentType": "text/plain"
        }
    )
    return response

def get_object(bucket_name, key, principal=None, headers=None):
    """Get an S3 object"""
    req_headers = {
        "x-account-id": ACCOUNT,
        "x-region": REGION,
    }
    if principal:
        req_headers["x-principal"] = principal
    if headers:
        req_headers.update(headers)
    
    response = requests.get(
        f"{BASE_URL}/s3",
        params={
            "action": "GetObject",
            "Bucket": bucket_name,
            "Key": key,
        },
        headers=req_headers
    )
    return response

def main():
    print("="*60)
    print("S3-KMS Integration Tests")
    print("="*60)
    
    # Test 1: Create bucket without encryption
    print("\n📦 Test 1: Create bucket without encryption")
    bucket_no_enc = "test-bucket-no-encryption"
    if create_bucket(bucket_no_enc):
        log_test("Create unencrypted bucket", True)
    else:
        log_test("Create unencrypted bucket", False)
    
    # Test 2: Put object to unencrypted bucket (should succeed)
    print("\n📦 Test 2: PutObject to unencrypted bucket")
    response = put_object(bucket_no_enc, "test.txt", "hello world", LAMBDA_PRINCIPAL)
    success = response.status_code == 200
    log_test("PutObject to unencrypted bucket", success, f"Status: {response.status_code}")
    
    # Test 3: Create bucket with encryption (Key 1 - S3 Default)
    print("\n📦 Test 3: Create bucket with KMS encryption (Key 1)")
    bucket_enc_key1 = "test-bucket-encrypted-key1"
    if create_bucket(bucket_enc_key1):
        success, resp = put_bucket_encryption(bucket_enc_key1, KEY_S3_DEFAULT)
        log_test("Set bucket encryption with Key 1 (S3 Default)", success)
    else:
        log_test("Set bucket encryption with Key 1", False, "Failed to create bucket")
    
    # Test 4: Put object to encrypted bucket with Key 1 (Lambda should have permission)
    print("\n📦 Test 4: PutObject to bucket encrypted with Key 1")
    response = put_object(bucket_enc_key1, "secrets.txt", "encrypted data", LAMBDA_PRINCIPAL)
    success = response.status_code == 200
    log_test(
        "PutObject with Lambda principal to Key 1 encrypted bucket",
        success,
        f"Status: {response.status_code}"
    )
    if response.status_code != 200:
        print(f"       Response: {response.text[:200]}")
    
    # Test 5: Create bucket with encryption (Key 2 - S3 Only)
    print("\n📦 Test 5: Create bucket with KMS encryption (Key 2 - S3 only)")
    bucket_enc_key2 = "test-bucket-encrypted-key2"
    if create_bucket(bucket_enc_key2):
        success, resp = put_bucket_encryption(bucket_enc_key2, KEY_S3_ONLY)
        log_test("Set bucket encryption with Key 2 (S3-only)", success)
    else:
        log_test("Set bucket encryption with Key 2", False)
    
    # Test 6: Put object to Key 2 encrypted bucket (Lambda should be DENIED - no GenerateDataKey)
    print("\n📦 Test 6: PutObject to bucket encrypted with Key 2")
    response = put_object(bucket_enc_key2, "secrets.txt", "encrypted data", LAMBDA_PRINCIPAL)
    success = response.status_code == 403 or "AccessDenied" in response.text
    log_test(
        "PutObject denied for Lambda (Key 2 - S3-only)",
        success,
        f"Status: {response.status_code}, Expected 403"
    )
    if response.status_code != 403:
        print(f"       Response: {response.text[:200]}")
    
    # Test 7: Get object from Key 1 encrypted bucket (should succeed)
    print("\n📦 Test 7: GetObject from Key 1 encrypted bucket")
    if response.status_code == 200 or response.status_code == 403:
        # First put an object
        put_response = put_object(bucket_enc_key1, "read-test.txt", "data to read", LAMBDA_PRINCIPAL)
        if put_response.status_code == 200:
            # Now try to read it
            response = get_object(bucket_enc_key1, "read-test.txt", LAMBDA_PRINCIPAL)
            success = response.status_code == 200
            log_test(
                "GetObject from Key 1 encrypted bucket (Lambda has Decrypt)",
                success,
                f"Status: {response.status_code}"
            )
        else:
            log_test("GetObject from Key 1", False, "Failed to put test object")
    
    # Test 8: Create bucket with Key 3 (Decrypt-only)
    print("\n📦 Test 8: Create bucket with KMS encryption (Key 3 - Decrypt-only)")
    bucket_enc_key3 = "test-bucket-encrypted-key3"
    if create_bucket(bucket_enc_key3):
        success, resp = put_bucket_encryption(bucket_enc_key3, KEY_DECRYPT_ONLY)
        log_test("Set bucket encryption with Key 3 (Decrypt-only)", success)
    else:
        log_test("Set bucket encryption with Key 3", False)
    
    # Test 9: Put object to Key 3 encrypted bucket (Lambda should be DENIED - no GenerateDataKey)
    print("\n📦 Test 9: PutObject to bucket encrypted with Key 3")
    response = put_object(bucket_enc_key3, "secrets.txt", "encrypted data", LAMBDA_PRINCIPAL)
    success = response.status_code == 403 or "AccessDenied" in response.text
    log_test(
        "PutObject denied for Lambda (Key 3 - no GenerateDataKey)",
        success,
        f"Status: {response.status_code}"
    )
    
    # Test 10: Verify CloudTrail logging
    print("\n📦 Test 10: Verify CloudTrail logging of KMS checks")
    try:
        response = requests.get(
            f"{BASE_URL}/cloudtrail/events",
            params={"account": ACCOUNT},
            headers={"x-account-id": ACCOUNT}
        )
        if response.status_code == 200:
            events = response.text.strip().split('\n')
            kms_events = [
                e for e in events
                if e and ('kms:GenerateDataKey' in e or 'kms:Decrypt' in e)
            ]
            success = len(kms_events) > 0
            log_test(
                "CloudTrail logged KMS permission checks",
                success,
                f"Found {len(kms_events)} KMS events"
            )
        else:
            log_test("CloudTrail logging", False, f"Status: {response.status_code}")
    except Exception as e:
        log_test("CloudTrail logging", False, str(e))
    
    # Summary
    print("\n" + "="*60)
    print("TEST SUMMARY")
    print("="*60)
    print(f"✓ Passed: {tests_passed}")
    print(f"✗ Failed: {tests_failed}")
    print(f"Total: {tests_passed + tests_failed}")
    print("="*60)
    
    return 0 if tests_failed == 0 else 1

if __name__ == "__main__":
    sys.exit(main())
