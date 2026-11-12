#!/usr/bin/env python3
"""
Test KMS cryptographic operations (Encrypt, Decrypt, GenerateDataKey)

This verifies that our KMS crypto implementation works correctly with boto3.

Run with: python3 tests/test_kms_crypto.py
"""

import boto3
import json
import base64
from botocore.exceptions import ClientError
from botocore.awsrequest import AWSRequest
from botocore.endpoint import Endpoint

# Configure boto3 to use local endpoint
ENDPOINT_URL = "http://localhost:3006/api/kms"
REGION = "us-east-1"
ACCOUNT_ID = "123456789012"


class KMSCryptoTester:
    def __init__(self):
        # Create KMS client with special configuration for local testing
        self.client = boto3.client(
            "kms",
            endpoint_url=ENDPOINT_URL,
            region_name=REGION,
            aws_access_key_id="test",
            aws_secret_access_key="test",
            verify=False  # Disable SSL verification for local testing
        )
        self.passed = 0
        self.failed = 0
        self.errors = []
        self.key_id = None

    def setup(self):
        """Create a test key"""
        print("\n📝 Creating test KMS key...")
        try:
            response = self.client.create_key(Description="Test key for crypto operations")
            self.key_id = response["KeyMetadata"]["KeyId"]
            print(f"✓ Created key: {self.key_id}")
        except Exception as e:
            print(f"✗ Failed to create key: {e}")
            # Create key using raw HTTP for debugging
            import urllib.request
            import json
            
            req_body = {
                "Description": "Test key for crypto operations"
            }
            
            headers = {
                'X-Amz-Target': 'TrentService.CreateKey',
                'Content-Type': 'application/x-amz-json-1.1',
            }
            
            req = urllib.request.Request(
                ENDPOINT_URL,
                data=json.dumps(req_body).encode('utf-8'),
                headers=headers,
                method='POST'
            )
            
            try:
                with urllib.request.urlopen(req) as response:
                    result = json.loads(response.read().decode('utf-8'))
                    self.key_id = result["KeyMetadata"]["KeyId"]
                    print(f"✓ Created key (via direct HTTP): {self.key_id}")
            except Exception as e2:
                print(f"✗ Direct HTTP also failed: {e2}")
                raise

    def test_encrypt_decrypt(self):
        """Test Encrypt → Decrypt round-trip"""
        if not self.key_id:
            print("\n⚠️  Skipping tests - no key ID available")
            return False
            
        print("\n🔐 Test: Encrypt/Decrypt Round-Trip")
        print("-" * 50)
        
        plaintext = "Hello, World! This is secret data."
        
        try:
            # Encrypt
            encrypt_response = self.client.encrypt(
                KeyId=self.key_id,
                Plaintext=plaintext.encode('utf-8')
            )
            ciphertext = encrypt_response["CiphertextBlob"]
            print(f"✓ Encrypt succeeded")
            print(f"  Plaintext:  {len(plaintext)} bytes")
            print(f"  Ciphertext: {len(base64.b64decode(ciphertext)) if isinstance(ciphertext, str) else len(ciphertext)} bytes (encrypted)")
            
            # Decrypt
            decrypt_response = self.client.decrypt(
                CiphertextBlob=ciphertext
            )
            decrypted = decrypt_response["Plaintext"].decode('utf-8')
            print(f"✓ Decrypt succeeded")
            print(f"  Decrypted:  {len(decrypted)} bytes")
            
            # Verify
            if decrypted == plaintext:
                print(f"✓ Round-trip successful: plaintext matches!")
                self.passed += 1
                return True
            else:
                print(f"✗ Round-trip failed: plaintext doesn't match!")
                print(f"  Expected: {plaintext}")
                print(f"  Got:      {decrypted}")
                self.failed += 1
                self.errors.append(("Encrypt/Decrypt Round-Trip", "Plaintext mismatch"))
                return False
                
        except Exception as e:
            print(f"✗ Encrypt/Decrypt failed: {e}")
            self.failed += 1
            self.errors.append(("Encrypt/Decrypt", str(e)))
            return False

    def test_generate_data_key(self):
        """Test GenerateDataKey operation"""
        if not self.key_id:
            return False
            
        print("\n🔐 Test: GenerateDataKey")
        print("-" * 50)
        
        try:
            # Generate a 256-bit (32 byte) data key
            response = self.client.generate_data_key(
                KeyId=self.key_id,
                KeySpec='AES_256'
            )
            
            plaintext_key = response["Plaintext"]
            ciphertext_key = response["CiphertextBlob"]
            
            print(f"✓ GenerateDataKey succeeded")
            print(f"  Plaintext key:   {len(plaintext_key) if isinstance(plaintext_key, (str, bytes)) else 'N/A'} bytes")
            print(f"  Ciphertext key:  {len(ciphertext_key) if isinstance(ciphertext_key, (str, bytes)) else 'N/A'} bytes")
            print(f"  KeySpec:         {response.get('KeySpec', 'N/A')}")
            
            self.passed += 1
            return True
                
        except Exception as e:
            print(f"✗ GenerateDataKey failed: {e}")
            self.failed += 1
            self.errors.append(("GenerateDataKey", str(e)))
            return False

    def run_all(self):
        """Run all tests"""
        print("=" * 60)
        print("     KMS CRYPTOGRAPHIC OPERATIONS TEST SUITE")
        print("=" * 60)
        
        self.setup()
        
        self.test_encrypt_decrypt()
        self.test_generate_data_key()
        
        print("\n" + "=" * 60)
        print(f"✓ PASSED: {self.passed}")
        print(f"✗ FAILED: {self.failed}")
        print("=" * 60)
        
        if self.errors:
            print("\nErrors:")
            for test_name, error in self.errors:
                print(f"  • {test_name}: {error}")
        
        return self.failed == 0


if __name__ == "__main__":
    tester = KMSCryptoTester()
    success = tester.run_all()
    exit(0 if success else 1)
