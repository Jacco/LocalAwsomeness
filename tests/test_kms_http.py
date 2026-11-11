#!/usr/bin/env python3
"""
Test KMS API with direct HTTP requests (compatible with boto3 format)

This tests our KMS API without requiring AWS credentials or authentication.
Run with: python3 tests/test_kms_http.py
"""

import requests
import json
import sys
from typing import Dict, Any

ENDPOINT_URL = "http://localhost:3000/api/kms"
ACCOUNT_ID = "123456789012"

# Example key IDs
KEY_IDS = {
    "s3_default": "12345678-1234-1234-1234-123456789012",
    "s3_only": "87654321-4321-4321-4321-210987654321",
    "decrypt_only": "11111111-2222-3333-4444-555555555555",
}


class KMSAPITester:
    def __init__(self):
        self.passed = 0
        self.failed = 0
        self.errors = []
        self.session = requests.Session()
        self.session.headers.update({
            "x-account-id": ACCOUNT_ID,
            "Content-Type": "application/json"
        })

    def get(self, action: str, params: Dict[str, str] = None) -> Dict[str, Any]:
        """Make GET request to KMS API"""
        url = f"{ENDPOINT_URL}?action={action}"
        if params:
            for key, val in params.items():
                url += f"&{key}={val}"
        
        response = self.session.get(url)
        response.raise_for_status()
        return response.json()

    def post(self, action: str, **kwargs) -> Dict[str, Any]:
        """Make POST request to KMS API"""
        data = {"action": action}
        data.update(kwargs)
        
        response = self.session.post(ENDPOINT_URL, json=data)
        response.raise_for_status()
        return response.json()

    def test_list_keys(self):
        """Test ListKeys operation"""
        print("\n📋 Test: ListKeys")
        print("-" * 50)
        try:
            response = self.get("ListKeys")
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
            response = self.get("DescribeKey", {"keyId": key_id})
            metadata = response["KeyMetadata"]
            
            print(f"✓ DescribeKey succeeded")
            print(f"  KeyId: {metadata['keyId']}")
            print(f"  State: {metadata['state']}")
            print(f"  CreationDate: {metadata['creationDate']}")
            print(f"  Description: {metadata.get('description', 'N/A')}")
            
            # Verify key is enabled
            assert metadata["state"] == "Enabled", "Expected key to be Enabled"
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
            response = self.get("GetKeyPolicy", {"keyId": key_id})
            # Policy is returned as JSON string
            if isinstance(response.get("Policy"), str):
                policy = json.loads(response["Policy"])
            else:
                policy = response.get("Policy", {})
            
            print(f"✓ GetKeyPolicy succeeded")
            print(f"  Policy Version: {policy.get('Version', 'N/A')}")
            print(f"  Statements: {len(policy.get('Statement', []))}")
            for i, stmt in enumerate(policy.get("Statement", [])):
                actions = stmt.get("Action", [])
                if isinstance(actions, str):
                    actions = [actions]
                print(f"    [{i}] {stmt.get('Sid', 'No Sid')}")
                print(f"        Actions: {actions}")
            
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
                response = self.get("DescribeKey", {"keyId": key_id})
                metadata = response["KeyMetadata"]
                print(f"✓ {key_name}: {metadata['description']}")
            
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
            s3_perms = self._check_permissions(policy1, "s3.amazonaws.com")
            lambda_perms = self._check_permissions(policy1, "arn:aws:iam::123456789012:role/lambda-executor")
            
            print(f"✓ Key 1 (S3 Default):")
            print(f"    S3 permissions: {s3_perms}")
            print(f"    Lambda permissions: {lambda_perms}")
            
            # Key 2: Should have S3 only
            policy2 = self._get_policy(KEY_IDS["s3_only"])
            s3_perms = self._check_permissions(policy2, "s3.amazonaws.com")
            lambda_perms = self._check_permissions(policy2, "arn:aws:iam::123456789012:role/lambda-executor")
            
            print(f"✓ Key 2 (S3-Only):")
            print(f"    S3 permissions: {s3_perms}")
            print(f"    Lambda permissions: {lambda_perms}")
            
            # Key 3: Should have Lambda decrypt-only
            policy3 = self._get_policy(KEY_IDS["decrypt_only"])
            lambda_perms = self._check_permissions(policy3, "arn:aws:iam::123456789012:role/lambda-executor")
            
            print(f"✓ Key 3 (Decrypt-Only):")
            print(f"    Lambda permissions: {lambda_perms}")
            
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
            response = self.post("RotateKey", keyId=key_id)
            
            print(f"✓ RotateKey succeeded")
            print(f"  KeyId: {response.get('KeyId')}")
            
            # Verify key still works
            metadata = self.get("DescribeKey", {"keyId": key_id})["KeyMetadata"]
            print(f"  Key state: {metadata['state']}")
            
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
            response = self.post(
                "CreateKey",
                description="Test key created by test_kms_http.py"
            )
            
            key_id = response["keyMetadata"]["keyId"]
            print(f"✓ CreateKey succeeded")
            print(f"  New KeyId: {key_id}")
            print(f"  Description: {response['keyMetadata'].get('description', 'N/A')}")
            
            # Verify it's enabled by default
            metadata = self.get("DescribeKey", {"keyId": key_id})["KeyMetadata"]
            assert metadata["state"] == "Enabled", "New key should be Enabled"
            
            self.passed += 1
            return True
        except Exception as e:
            print(f"✗ CreateKey failed: {e}")
            self.failed += 1
            self.errors.append(("CreateKey", str(e)))
            return False

    def test_enable_disable_key(self):
        """Test EnableKey and DisableKey operations"""
        print("\n🔐 Test: Enable/Disable Key")
        print("-" * 50)
        try:
            # Create a key first
            create_resp = self.post("CreateKey", description="Test enable/disable")
            key_id = create_resp["keyMetadata"]["keyId"]
            
            # Disable it
            self.post("DisableKey", keyId=key_id)
            disabled = self.get("DescribeKey", {"keyId": key_id})["KeyMetadata"]
            print(f"✓ DisableKey succeeded - State: {disabled['state']}")
            assert disabled["state"] == "Disabled", "Key should be disabled"
            
            # Re-enable it
            self.post("EnableKey", keyId=key_id)
            enabled = self.get("DescribeKey", {"keyId": key_id})["KeyMetadata"]
            print(f"✓ EnableKey succeeded - State: {enabled['state']}")
            assert enabled["state"] == "Enabled", "Key should be enabled"
            
            self.passed += 1
            return True
        except Exception as e:
            print(f"✗ Enable/Disable key failed: {e}")
            self.failed += 1
            self.errors.append(("EnableDisableKey", str(e)))
            return False

    # Helper methods
    def _get_policy(self, key_id):
        """Get and parse key policy"""
        response = self.get("GetKeyPolicy", {"keyId": key_id})
        if isinstance(response.get("Policy"), str):
            return json.loads(response["Policy"])
        return response.get("Policy", {})

    def _check_permissions(self, policy, principal):
        """Extract permissions for a principal"""
        perms = []
        for stmt in policy.get("Statement", []):
            if stmt.get("Effect") != "Allow":
                continue
            
            stmt_principal = stmt.get("Principal", {})
            if principal in str(stmt_principal):
                actions = stmt.get("Action", [])
                if isinstance(actions, str):
                    actions = [actions]
                perms.extend(actions)
        
        return perms

    def run_all_tests(self):
        """Run all tests"""
        print("\n" + "=" * 50)
        print("KMS API Testing with HTTP")
        print("=" * 50)
        print(f"Endpoint: {ENDPOINT_URL}")
        
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
        self.test_enable_disable_key()
        
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
        print("  2. Port 3000 is accessible")
        sys.exit(1)


if __name__ == "__main__":
    main()
