#!/usr/bin/env python3
"""
Test KMS API with boto3 (AWS Python SDK)

This verifies that our KMS API is compatible with boto3 clients,
which is what Lambda functions and other Python code use.

Run with: python3 tests/test_kms_boto3.py
"""

import boto3
import json
import sys
from botocore.exceptions import ClientError

# Configure boto3 to use local endpoint
ENDPOINT_URL = "http://localhost:3000/api/kms"
REGION = "us-east-1"
ACCOUNT_ID = "123456789012"

# Example key IDs
KEY_IDS = {
    "s3_default": "12345678-1234-1234-1234-123456789012",
    "s3_only": "87654321-4321-4321-4321-210987654321",
    "decrypt_only": "11111111-2222-3333-4444-555555555555",
}


class KMSAPITester:
    def __init__(self):
        # Create KMS client pointing to our local API
        self.client = boto3.client(
            "kms",
            endpoint_url=ENDPOINT_URL,
            region_name=REGION,
            aws_access_key_id="test",
            aws_secret_access_key="test",
        )
        self.passed = 0
        self.failed = 0
        self.errors = []

    def test_list_keys(self):
        """Test ListKeys operation"""
        print("\n📋 Test: ListKeys")
        print("-" * 50)
        try:
            response = self.client.list_keys()
            print(f"✓ ListKeys succeeded")
            print(f"  Keys found: {len(response.get('Keys', []))}")
            for key in response.get("Keys", []):
                print(f"    - {key['KeyId']}")
            
            # Verify we have 3 example keys
            assert len(response.get("Keys", [])) == 3, "Expected 3 keys"
            self.passed += 1
            return True
        except Exception as e:
            print(f"✗ ListKeys failed: {e}")
            self.failed += 1
            self.errors.append(("ListKeys", str(e)))
            return False

    def test_describe_key(self, key_name="s3_default"):
        """Test DescribeKey operation"""
        key_id = KEY_IDS[key_name]
        print(f"\n🔍 Test: DescribeKey ({key_name})")
        print("-" * 50)
        try:
            response = self.client.describe_key(KeyId=key_id)
            metadata = response["KeyMetadata"]
            
            print(f"✓ DescribeKey succeeded")
            print(f"  KeyId: {metadata['KeyId']}")
            print(f"  State: {metadata['KeyState']}")
            print(f"  CreationDate: {metadata['CreationDate']}")
            print(f"  Description: {metadata.get('Description', 'N/A')}")
            
            # Verify key is enabled
            assert metadata["KeyState"] == "Enabled", "Expected key to be Enabled"
            self.passed += 1
            return True
        except Exception as e:
            print(f"✗ DescribeKey failed: {e}")
            self.failed += 1
            self.errors.append((f"DescribeKey({key_name})", str(e)))
            return False

    def test_get_key_policy(self, key_name="s3_default"):
        """Test GetKeyPolicy operation"""
        key_id = KEY_IDS[key_name]
        print(f"\n🔐 Test: GetKeyPolicy ({key_name})")
        print("-" * 50)
        try:
            response = self.client.get_key_policy(KeyId=key_id, PolicyName="default")
            policy = json.loads(response["Policy"])
            
            print(f"✓ GetKeyPolicy succeeded")
            print(f"  Policy Version: {policy['Version']}")
            print(f"  Statements: {len(policy['Statement'])}")
            for i, stmt in enumerate(policy["Statement"]):
                actions = stmt.get("Action", [])
                if isinstance(actions, str):
                    actions = [actions]
                print(f"    [{i}] {stmt.get('Sid', 'No Sid')}")
                print(f"        Actions: {actions}")
                print(f"        Principal: {stmt.get('Principal', {})}")
            
            self.passed += 1
            return True
        except Exception as e:
            print(f"✗ GetKeyPolicy failed: {e}")
            self.failed += 1
            self.errors.append((f"GetKeyPolicy({key_name})", str(e)))
            return False

    def test_all_keys_described(self):
        """Test describing all keys"""
        print("\n✨ Test: Describe All Keys")
        print("-" * 50)
        try:
            for key_name, key_id in KEY_IDS.items():
                response = self.client.describe_key(KeyId=key_id)
                metadata = response["KeyMetadata"]
                print(f"✓ {key_name}: {metadata['Description']}")
            
            self.passed += 1
            return True
        except Exception as e:
            print(f"✗ Describe all keys failed: {e}")
            self.failed += 1
            self.errors.append(("DescribeAllKeys", str(e)))
            return False

    def test_key_permissions(self):
        """Test that keys have expected permissions"""
        print("\n🔑 Test: Verify Key Permissions")
        print("-" * 50)
        try:
            # Key 1: Should have S3 + Lambda
            policy1 = self._get_policy(KEY_IDS["s3_default"])
            s3_can_encrypt = self._check_principal_can_encrypt(policy1, "s3.amazonaws.com")
            lambda_can_encrypt = self._check_principal_can_encrypt(policy1, "arn:aws:iam::123456789012:role/lambda-executor")
            
            print(f"✓ Key 1 (S3 Default):")
            print(f"    S3 can encrypt: {s3_can_encrypt}")
            print(f"    Lambda can encrypt: {lambda_can_encrypt}")
            assert s3_can_encrypt and lambda_can_encrypt, "Key 1 should allow both S3 and Lambda"
            
            # Key 2: Should have S3 only
            policy2 = self._get_policy(KEY_IDS["s3_only"])
            s3_can_encrypt = self._check_principal_can_encrypt(policy2, "s3.amazonaws.com")
            lambda_can_encrypt = self._check_principal_can_encrypt(policy2, "arn:aws:iam::123456789012:role/lambda-executor")
            
            print(f"✓ Key 2 (S3-Only):")
            print(f"    S3 can encrypt: {s3_can_encrypt}")
            print(f"    Lambda can encrypt: {lambda_can_encrypt}")
            assert s3_can_encrypt and not lambda_can_encrypt, "Key 2 should allow S3 only"
            
            # Key 3: Should have Lambda decrypt-only
            policy3 = self._get_policy(KEY_IDS["decrypt_only"])
            lambda_can_decrypt = self._check_principal_can_decrypt(policy3, "arn:aws:iam::123456789012:role/lambda-executor")
            lambda_can_encrypt = self._check_principal_can_encrypt(policy3, "arn:aws:iam::123456789012:role/lambda-executor")
            
            print(f"✓ Key 3 (Decrypt-Only):")
            print(f"    Lambda can decrypt: {lambda_can_decrypt}")
            print(f"    Lambda can encrypt: {lambda_can_encrypt}")
            assert lambda_can_decrypt and not lambda_can_encrypt, "Key 3 should allow decrypt only"
            
            self.passed += 1
            return True
        except Exception as e:
            print(f"✗ Permission verification failed: {e}")
            self.failed += 1
            self.errors.append(("VerifyPermissions", str(e)))
            return False

    def test_rotate_key(self):
        """Test RotateKey operation"""
        print("\n🔄 Test: RotateKey")
        print("-" * 50)
        try:
            key_id = KEY_IDS["s3_default"]
            response = self.client.rotate_key(KeyId=key_id)
            
            print(f"✓ RotateKey succeeded")
            print(f"  KeyId: {response['KeyId']}")
            
            # Verify key still works
            metadata = self.client.describe_key(KeyId=key_id)["KeyMetadata"]
            print(f"  Key state: {metadata['KeyState']}")
            
            self.passed += 1
            return True
        except Exception as e:
            print(f"✗ RotateKey failed: {e}")
            self.failed += 1
            self.errors.append(("RotateKey", str(e)))
            return False

    def test_create_key(self):
        """Test CreateKey operation"""
        print("\n✨ Test: CreateKey")
        print("-" * 50)
        try:
            response = self.client.create_key(
                Description="Test key created by boto3",
                KeyUsage="ENCRYPT_DECRYPT"
            )
            
            key_id = response["KeyMetadata"]["KeyId"]
            print(f"✓ CreateKey succeeded")
            print(f"  New KeyId: {key_id}")
            print(f"  Description: {response['KeyMetadata'].get('Description', 'N/A')}")
            
            # Verify it's enabled by default
            metadata = self.client.describe_key(KeyId=key_id)["KeyMetadata"]
            assert metadata["KeyState"] == "Enabled", "New key should be Enabled"
            
            self.passed += 1
            return True
        except Exception as e:
            print(f"✗ CreateKey failed: {e}")
            self.failed += 1
            self.errors.append(("CreateKey", str(e)))
            return False

    # Helper methods
    def _get_policy(self, key_id):
        """Get and parse key policy"""
        response = self.client.get_key_policy(KeyId=key_id, PolicyName="default")
        return json.loads(response["Policy"])

    def _check_principal_can_encrypt(self, policy, principal):
        """Check if principal has GenerateDataKey action"""
        return self._check_principal_action(policy, principal, "kms:GenerateDataKey")

    def _check_principal_can_decrypt(self, policy, principal):
        """Check if principal has Decrypt action"""
        return self._check_principal_action(policy, principal, "kms:Decrypt")

    def _check_principal_action(self, policy, principal, action):
        """Check if principal has specific action in policy"""
        for stmt in policy.get("Statement", []):
            if stmt.get("Effect") != "Allow":
                continue
            
            # Check principal matches
            stmt_principal = stmt.get("Principal", {})
            if isinstance(stmt_principal, str) and stmt_principal == "*":
                return True
            elif isinstance(stmt_principal, dict):
                if principal in str(stmt_principal):
                    # Check action
                    actions = stmt.get("Action", [])
                    if isinstance(actions, str):
                        actions = [actions]
                    if action in actions or "kms:*" in actions:
                        return True
        
        return False

    def run_all_tests(self):
        """Run all tests"""
        print("\n" + "=" * 50)
        print("KMS API Testing with boto3")
        print("=" * 50)
        print(f"Endpoint: {ENDPOINT_URL}")
        print(f"Region: {REGION}")
        
        # Run all tests
        self.test_list_keys()
        self.test_describe_key("s3_default")
        self.test_describe_key("s3_only")
        self.test_describe_key("decrypt_only")
        self.test_get_key_policy("s3_default")
        self.test_get_key_policy("s3_only")
        self.test_get_key_policy("decrypt_only")
        self.test_all_keys_described()
        self.test_key_permissions()
        self.test_rotate_key()
        self.test_create_key()
        
        # Print summary
        print("\n" + "=" * 50)
        print("TEST SUMMARY")
        print("=" * 50)
        print(f"✓ Passed: {self.passed}")
        print(f"✗ Failed: {self.failed}")
        
        if self.errors:
            print("\nFailures:")
            for test_name, error in self.errors:
                print(f"  • {test_name}: {error}")
        
        return self.failed == 0


def main():
    """Run all tests"""
    try:
        tester = KMSAPITester()
        success = tester.run_all_tests()
        sys.exit(0 if success else 1)
    except Exception as e:
        print(f"\n❌ Fatal error: {e}")
        print("\nMake sure:")
        print("  1. The dev server is running: npm run dev")
        print("  2. boto3 is installed: pip install boto3")
        print("  3. Port 3000 is accessible")
        sys.exit(1)


if __name__ == "__main__":
    main()
